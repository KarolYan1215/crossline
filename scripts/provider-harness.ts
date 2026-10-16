/**
 * The shared wiring for running real Skills on another model in a script (docs/beta-launch.md §10.4): the model gateway, the provider
 * service with an in-memory key store, and a provider resolver that can *force* a workspace onto its provider for every Skill — the
 * evaluation question is "how good is this model at the real work", which the conformance gate deliberately does not let a provider
 * reach before it has passed. Skills the provider cannot be measured on (test-only ones, such as the simulated person in
 * `onboarding-eval.ts`) stay on the Codex sign-in.
 *
 * Keys are read from the environment variable each provider names (`keyEnv`); none is ever taken as an argument or written anywhere.
 */
import { readFileSync } from "node:fs";
import { SKILL_NEEDS, THIRD_PARTY_CAPABILITIES } from "../packages/core/src/index";
import { setProviderResolver, startModelGateway, type CodexRpcBoundary, type ProviderRouting } from "../packages/codex/src/index";
import { createMemorySecretStore } from "../packages/connectors/src/secret-file";
import type { CrosslineStore } from "../packages/db/src/index";
import { createModelProviderService } from "../apps/worker/src/model-provider";

export type Price = { inPerM: number; cachedInPerM?: number; outPerM: number; currency: string };
export type ProviderSpec = { id: string; label: string; kind: "chat" | "responses"; baseUrl: string; model: string; keyEnv?: string;
  responseFormat?: "json_object" | "json_schema"; price?: Price };
export type ImageSpec = { id: string; baseUrl: string; model: string; keyEnv: string; size?: string; style?: "siliconflow" | "openai" };
export type MatrixConfig = { providers: ProviderSpec[]; images?: ImageSpec[] };

export function readMatrixConfig(file: string): MatrixConfig {
  const config = JSON.parse(readFileSync(file, "utf8")) as MatrixConfig;
  if (!Array.isArray(config.providers)) throw new Error("config.providers must be an array");
  for (const spec of config.providers) {
    if (!/^[a-z0-9-]{1,32}$/.test(spec.id)) throw new Error(`provider id "${spec.id}": lowercase letters, digits and hyphens only`);
    if (spec.keyEnv && !process.env[spec.keyEnv]?.trim()) console.warn(JSON.stringify({ step: "warn", provider: spec.id, message: `${spec.keyEnv} is not set` }));
  }
  return config;
}

/** Every Skill a provider could be asked to do for real (test-only ones excluded). */
const REAL_SKILLS = new Set(Object.entries(SKILL_NEEDS).filter(([, needs]) => !needs.testOnly).map(([skill]) => skill));

export async function startProviderHarness(store: CrosslineStore, client: CodexRpcBoundary, cwd: string) {
  let service: ReturnType<typeof createModelProviderService>;
  const gateway = await startModelGateway({ resolve: (workspaceId, providerId) => service.upstream(workspaceId, providerId) });
  service = createModelProviderService({ store, secrets: createMemorySecretStore(), gateway, signedIn: () => false, client: async () => client, cwd });
  const forced = new Set<string>();
  // Built on every call, so the search functions (and their per-run caps) are fresh for each run, as in the worker.
  setProviderResolver((workspaceId) => {
    if (!workspaceId) return undefined;
    const routing = service.routing(workspaceId);
    if (!routing || !forced.has(workspaceId)) return routing;
    const forcedRouting: ProviderRouting = { ...routing, admitted: REAL_SKILLS, codexSignedIn: true,
      capabilities: { ...THIRD_PARTY_CAPABILITIES, ...routing.capabilities, shell: true } };
    return forcedRouting;
  });
  return {
    service,
    async add(workspaceId: string, spec: ProviderSpec): Promise<void> {
      const saved = await service.handle("POST", "/v1/model/provider", workspaceId, { id: spec.id, kind: spec.kind, label: spec.label.slice(0, 40),
        baseUrl: spec.baseUrl, model: spec.model, ...(spec.keyEnv ? { apiKey: process.env[spec.keyEnv]?.trim() ?? "" } : {}),
        ...(spec.responseFormat ? { responseFormat: spec.responseFormat } : {}) });
      if (saved?.status !== 200) throw new Error(`provider ${spec.id}: ${JSON.stringify(saved?.body).slice(0, 300)}`);
    },
    /** Every real Skill of this workspace now runs on its provider, whatever conformance said. */
    force(workspaceId: string) { forced.add(workspaceId); },
    async close() { setProviderResolver(undefined); await gateway.close(); }
  };
}

/** Estimated spend for a token count at a price; cached input at its own price when one is given. */
export function costOf(tokens: { inputTokens: number; cachedInputTokens: number; outputTokens: number }, price: Price | undefined): number | undefined {
  if (!price) return undefined;
  const cached = Math.min(tokens.cachedInputTokens, tokens.inputTokens);
  return ((tokens.inputTokens - cached) * price.inPerM + cached * (price.cachedInPerM ?? price.inPerM) + tokens.outputTokens * price.outPerM) / 1_000_000;
}
