import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { conformanceCases, summarizeConformance } from "@crossline/core";
import { decideRoute } from "@crossline/codex";
import { CrosslineStore, SPONSOR_SETTING } from "@crossline/db";
import { createModelProviderService, RUNTIME_VERSION } from "./model-provider";
import { createSponsorService } from "./sponsor";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-18T12:00:00.000Z");
const MODEL = "deepseek-ai/DeepSeek-V4.1";

function setup(withEvaluation = true) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "sponsor-"));
  dirs.push(dataDir);
  if (withEvaluation) {
    const record = summarizeConformance({ providerId: "sponsor", model: MODEL, runtimeVersion: RUNTIME_VERSION, ranAt: NOW.toISOString() },
      conformanceCases().flatMap((item) => Array.from({ length: item.runs }, () => ({ caseId: item.id, ok: true, repairs: 0, ms: 900 }))));
    writeFileSync(path.join(dataDir, "sponsor.json"), JSON.stringify({ evaluations: [{ model: MODEL, record, yuanPerRun: 0.02 }] }));
  }
  const store = new CrosslineStore(":memory:");
  const gateway = { urlFor: (workspaceId: string, providerId: string) => `http://127.0.0.1:1/${workspaceId}/${providerId}`, port: 1, close: async () => {} };
  const env = { CROSSLINE_SPONSOR_API_KEY: "sk-test", CROSSLINE_SPONSOR_MODELS: `${MODEL}=4:16:1024` } as NodeJS.ProcessEnv;
  let sponsor: ReturnType<typeof createSponsorService> | undefined;
  const providers = createModelProviderService({ store, cwd: dataDir, gateway, signedIn: () => false, client: async () => undefined,
    secrets: { read: async () => undefined, write: async () => {}, remove: () => {} } as never, search: null, image: null, sponsor: () => sponsor, now: () => NOW });
  sponsor = createSponsorService({ store, dataDir, cwd: dataDir, gateway, capabilities: providers.capabilities, client: () => undefined, env, now: () => NOW });
  return { store, providers, sponsor };
}

test("an account that redeemed a code runs on the chosen model through the gateway, with the server key", async () => {
  const { store, providers } = setup();
  expect(providers.routing("ws")).toBeUndefined();
  expect(providers.hasProvider("ws")).toBe(false);
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  const routing = providers.routing("ws")!;
  expect(routing.provider).toMatchObject({ id: "sponsor", model: MODEL, kind: "chat" });
  expect(decideRoute("crossline:crossline-onboarding", routing)).toMatchObject({ via: "provider", provider: { model: MODEL } });
  expect(providers.hasProvider("ws")).toBe(true);
  expect(await providers.upstream("ws", "sponsor")).toMatchObject({ key: "sk-test", baseUrl: "https://api.siliconflow.cn/v1" });
  // An account that did not redeem gets nothing through the sponsor route.
  expect(await providers.upstream("other", "sponsor")).toBeUndefined();
  expect(providers.view("ws").features.find((feature) => feature.skill === "crossline-onboarding")?.served).toBe(true);
});

test("the month's cap stops the account with the reason, and its quota reads as spent", () => {
  const { store, providers } = setup();
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  // 2M input × 4 + 1.5M output × 16 = 32 yuan this month; last month's use does not count.
  for (const at of ["2026-10-05T00:00:00.000Z", "2026-09-30T00:00:00.000Z"]) store.saveModelUsage({ workspaceId: "ws", skill: "crossline:crossline-onboarding", tier: "", model: MODEL,
    effort: "", spendMode: "normal", threadId: "", ok: true, errorCode: "", repairs: 0, turns: 1, inputTokens: 2_000_000, cachedInputTokens: 0,
    outputTokens: 1_000_000, reasoningTokens: 500_000, totalTokens: 3_500_000, durationMs: 1, at });
  const routing = providers.routing("ws")!;
  expect(routing.blocked?.code).toBe("MODEL_SPONSOR_BUDGET");
  expect(decideRoute("crossline:crossline-onboarding", routing)).toMatchObject({ via: "blocked", code: "MODEL_SPONSOR_BUDGET" });
  expect(providers.cost("ws")).toMatchObject({ available: true, limitReached: true, money: { spent: 32, cap: 30 } });
});

test("until a model has passed, the account is told it is being tested", () => {
  const { store, providers } = setup(false);
  store.setSetting("ws", SPONSOR_SETTING, JSON.stringify({ inviteId: "inv", since: NOW.toISOString() }));
  expect(decideRoute("crossline:crossline-onboarding", providers.routing("ws"))).toMatchObject({ via: "blocked", code: "MODEL_SPONSOR_PENDING" });
});
