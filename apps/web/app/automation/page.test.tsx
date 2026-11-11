import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { AUTOMATIONS_SETTING, type Automation } from "@crossline/core";
import { CrosslineStore, requestAutomation } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` }); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({ push: () => undefined, replace: () => undefined }) }));

const automation = (patch: Partial<Automation> = {}): Automation => ({ id: "auto-1", name: "课程邮件整理", summary: "每天早上把课程邮件整理成清单", lineId: "research",
  trigger: { type: "schedule", schedule: { type: "daily", time: "08:00" } },
  action: { kind: "run", instructions: "整理课程邮件", category: "read_research_organize", outputs: ["digest.md"] },
  steps: [{ title: "读邮件并整理", by: "assistant" }], status: "active", origin: { kind: "asked", text: "整理课程邮件" }, createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z", runs: 0, ...patch } as Automation);

test("自动化 holds the workflows in one list, what the assistant may do and the library; old links to a workflow land on its page", async () => {
  const store = new CrosslineStore(":memory:");
  globalThis.crosslineStore = store;
  store.setSetting(TEST_CTX.workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation()]));
  requestAutomation(store, TEST_CTX.workspaceId, "课程网页一更新就告诉我", "research", TEST_CTX.principalId);
  const { default: AutomationPage } = await import("./page");
  const html = renderToStaticMarkup(await AutomationPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain("工作流 · 1");
  expect(html).toContain('href="/automation/auto-1"');
  expect(html).toContain("课程邮件整理");
  // A request still being designed is listed as a conversation of its own.
  expect(html).toContain("正在设计");
  expect(html).toContain("助手做完的结果默认直接生效");
  // The Skill library is read after the page is shown (`SkillLibraryLoader`); its folded summary is tested in settings/skill-library.test.tsx.
  expect(html).toContain('id="skills"');
  expect(html).toContain("正在读取…");
  await expect(AutomationPage({ searchParams: Promise.resolve({ login: "flow-xhs" }) })).rejects.toMatchObject({ digest: "NEXT_REDIRECT;/automation/flow-xhs?login=1" });
  store.close();
  globalThis.crosslineStore = undefined;
}, 30000);

test("a workflow's page shows its conversation and every version, the one in force marked", async () => {
  const store = new CrosslineStore(":memory:");
  globalThis.crosslineStore = store;
  store.setSetting(TEST_CTX.workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation()]));
  store.setSetting(TEST_CTX.workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation({ trigger: { type: "interval", hours: 6 } })]));
  store.saveWorkflowThread({ workspaceId: TEST_CTX.workspaceId, id: "req-1", workflowId: "auto-1", kind: "automation", codexThreadId: "c", lineId: "research", title: "整理课程邮件",
    createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" });
  store.saveWorkflowTurn({ workspaceId: TEST_CTX.workspaceId, id: "t1", threadId: "req-1", role: "person", text: "改成每 6 小时", items: [], state: "done", createdAt: "2026-11-01T01:00:00.000Z" });
  store.saveWorkflowTurn({ workspaceId: TEST_CTX.workspaceId, id: "t2", threadId: "req-1", role: "assistant", text: "好，改成每 6 小时一次。", state: "done", createdAt: "2026-11-01T01:00:01.000Z",
    items: [{ type: "tool", name: "next_times", args: "{}", result: "[]", ok: true }, { type: "version", version: 2, note: "" }] });
  const { default: WorkflowPage } = await import("./[id]/page");
  const html = renderToStaticMarkup(await WorkflowPage({ params: Promise.resolve({ id: "auto-1" }), searchParams: Promise.resolve({}) }));
  expect(html).toContain("改成每 6 小时");
  expect(html).toContain("next_times");
  expect(html).toContain("成为第 2 版");
  expect(html).toContain("版本 · 2");
  expect(html).toContain("回到此版");
  await expect(WorkflowPage({ params: Promise.resolve({ id: "nothing" }), searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  store.close();
  globalThis.crosslineStore = undefined;
}, 30000);
