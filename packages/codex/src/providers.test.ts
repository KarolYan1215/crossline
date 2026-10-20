import { readdirSync } from "node:fs";
import path from "node:path";
import { SKILL_NEEDS } from "@crossline/core";
import { expect, test } from "vitest";
import { SKILL_TIERS, parseRoute } from "./model-policy";
import { decideRoute, providerConfigProblem, type ProviderConfig, type ProviderRouting } from "./providers";

const provider: ProviderConfig = { id: "deepseek", kind: "chat", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
  keyLast4: "abcd", updatedAt: "2026-10-13T00:00:00.000Z" };
const routing = (admitted: string[], codexSignedIn: boolean): ProviderRouting =>
  ({ provider, gatewayUrl: "http://127.0.0.1:5555/0123", admitted: new Set(admitted), codexSignedIn });

test("an admitted Skill goes to the provider, on a thread-only provider definition that carries no key", () => {
  const decision = decideRoute("crossline:crossline-task-titler", routing(["crossline-task-titler"], false));
  expect(decision).toEqual({ via: "provider", provider: { id: "crossline-deepseek", model: "deepseek-chat", definition: expect.objectContaining({
    base_url: "http://127.0.0.1:5555/0123", wire_api: "responses", requires_openai_auth: false, supports_websockets: false }) } });
  expect(JSON.stringify(decision)).not.toMatch(/abcd|env_key|bearer/i);
});

test("what the provider cannot do or has not passed goes to the workspace's own Codex sign-in; with none, a blocker that says why", () => {
  // Web search is never the provider's, however its conformance went.
  expect(decideRoute("crossline-due-diligence", routing(["crossline-due-diligence"], true))).toEqual({ via: "codex" });
  expect(decideRoute("crossline-due-diligence", routing(["crossline-due-diligence"], false)))
    .toEqual({ via: "blocked", code: "MODEL_CAPABILITY_MISSING", message: expect.stringContaining("联网") });
  expect(decideRoute("crossline-milestone-gate", routing([], false)))
    .toEqual({ via: "blocked", code: "MODEL_NOT_ADMITTED", message: expect.stringContaining("验收判定") });
  expect(decideRoute("crossline-agent", routing([], false))).toMatchObject({ via: "blocked", code: "MODEL_CAPABILITY_MISSING" });
  // No provider configured: nothing changes.
  expect(decideRoute("crossline-milestone-gate", undefined)).toEqual({ via: "codex" });
});

test("a Skill with a model of its own runs on it, and on the provider's own model when the main model is asked for", () => {
  const withPlanning = { ...routing(["crossline-step-planner", "crossline-milestone-gate"], false),
    modelFor: (skill: string) => skill === "crossline-step-planner" ? "glm" : undefined };
  expect(decideRoute("crossline-step-planner", withPlanning)).toMatchObject({ via: "provider", provider: { model: "glm" } });
  expect(decideRoute("crossline-step-planner", withPlanning, { mainModel: true })).toMatchObject({ via: "provider", provider: { model: "deepseek-chat" } });
  expect(decideRoute("crossline-milestone-gate", withPlanning)).toMatchObject({ via: "provider", provider: { model: "deepseek-chat" } });
});

test("with Crossline's own search configured, a web Skill may go to the provider; the assistant still may not", () => {
  const withSearch = { ...routing(["crossline-due-diligence", "crossline-agent"], false), capabilities: { webSearch: true } };
  expect(decideRoute("crossline-due-diligence", withSearch)).toMatchObject({ via: "provider" });
  expect(decideRoute("crossline-agent", withSearch)).toMatchObject({ via: "blocked", code: "MODEL_CAPABILITY_MISSING" });
  // An image API makes no gap, but the illustrator has no schema to pass, so it is never admitted: it draws through the image API directly.
  expect(decideRoute("crossline-portrait-illustrator", { ...routing([], true), capabilities: { image: true } })).toEqual({ via: "codex" });
});

test("a provider address must be https, or http on this computer; no credentials or query in it", () => {
  const base = { id: "x", kind: "chat" as const, label: "X", model: "m" };
  expect(providerConfigProblem({ ...base, baseUrl: "https://api.example.com/v1" })).toBeUndefined();
  expect(providerConfigProblem({ ...base, baseUrl: "http://127.0.0.1:11434/v1" })).toBeUndefined();
  expect(providerConfigProblem({ ...base, baseUrl: "http://api.example.com/v1" })).toContain("https");
  expect(providerConfigProblem({ ...base, baseUrl: "https://user:pw@api.example.com/v1" })).toBeDefined();
  expect(providerConfigProblem({ ...base, baseUrl: "https://api.example.com/v1?key=1" })).toBeDefined();
  expect(providerConfigProblem({ ...base, id: "Bad Id", baseUrl: "https://a.b" })).toBeDefined();
  expect(providerConfigProblem({ ...base, model: "two words", baseUrl: "https://a.b" })).toBeDefined();
});

test("every Skill — routed or in the plugin — says what it needs (a new Skill without an entry fails here)", () => {
  expect(Object.keys(SKILL_TIERS).filter((skill) => !SKILL_NEEDS[skill])).toEqual([]);
  const dir = path.resolve(import.meta.dirname, "../../../skills/marketplace/plugins/crossline/skills");
  const skills = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  expect(skills.filter((skill) => !SKILL_NEEDS[skill])).toEqual([]);
});

test("a model id with its own colon is not split into model and effort", () => {
  expect(parseRoute("qwen3:8b")).toEqual({ model: "qwen3:8b" });
  expect(parseRoute("qwen3:8b:high")).toEqual({ model: "qwen3:8b", effort: "high" });
  expect(parseRoute("gpt-5.6-sol:medium")).toEqual({ model: "gpt-5.6-sol", effort: "medium" });
});
