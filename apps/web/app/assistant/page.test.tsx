import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { approveCategory, CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../lib/access-guard", () => ({ requireSessionContext: async () => TEST_CTX }));

let store: CrosslineStore;
let dir: string;
beforeEach(() => { vi.stubEnv("CROSSLINE_SEED_EXAMPLES", ""); store = new CrosslineStore(":memory:"); globalThis.crosslineStore = store; dir = mkdtempSync(path.join(tmpdir(), "crossline-assistant-page-")); });
afterEach(() => { vi.unstubAllEnvs(); store.close(); globalThis.crosslineStore = undefined; rmSync(dir, { recursive: true, force: true }); });

const event = (type: string, entityId: string, payload: object) => store.appendEvent({ ownerId: "owner-1", workspaceId: "workspace-1", idempotencyKey: `${type}:${entityId}`, type, entityId, payload });
const render = async () => { const { default: Page } = await import("./page"); return renderToStaticMarkup(await Page()); };

test("a kind the assistant wants and a question it asked mid-run are put to the person, with the choices", async () => {
  event("agent.category.requested", "data_code_sim", { category: "data_code_sim", workOrderId: "wo-1", why: "AI 部分指向数据" });
  event("agent.approval.requested", "ap-1", { id: "ap-1", taskId: "t1", kind: "command", subject: "winget install Foo", rule: "install.global", reason: "系统级安装" });
  const html = await render();
  expect(html).toContain("助手想开始做「数据、代码、仿真」这类事");
  expect(html).toContain("同意助手做");
  expect(html).toContain("winget install Foo");
  expect(html).toContain("同意这一次");
});

test("a finished task is shown with what the assistant said and, apart from it, what the app recorded", async () => {
  approveCategory(store, "workspace-1", "read_research_organize");
  const taskDir = path.join(dir, "t1");
  mkdirSync(taskDir);
  writeFileSync(path.join(taskDir, "audit.json"), JSON.stringify({ summary: "整理了笔记。", artifacts: [{ path: "n.md", purpose: "笔记", sha256: "abcdef0123456789", bytes: 12 }],
    verification: [{ check: "文件存在", result: "pass", evidence: "Get-Item" }], needsHuman: [{ what: "确认课程环境", why: "只有老师能说" }], notDone: [], assumptions: ["按暂定日程"],
    audit: { commands: [{ command: "powershell.exe -Command ls", exitCode: 0 }], filesChanged: [], searches: ["sram"], decisions: [{ rule: "secret.path", reason: "凭据位置", subject: "~/.ssh", outcome: "declined" }] },
    inputsModified: [], checksPassed: true }));
  event("agent.task.requested", "t1", { title: "整理 Cadence 材料", category: "read_research_organize", workOrderId: "" });
  event("agent.task.completed", "t1", { directory: taskDir, durationMs: 90_000, commands: 1, denied: 1, artifacts: [{ path: "n.md", sha256: "abcdef0123456789", bytes: 12 }], needsHuman: 1, checksPassed: true, inputsModified: [], reviewRequired: true });
  const html = await render();
  expect(html).toContain("等你过目");
  expect(html).toContain("整理了笔记。");
  expect(html).toContain("这是助手自己的说明");
  expect(html).toContain("/api/agent/tasks/t1/file?path=n.md");
  expect(html).toContain("确认课程环境");
  expect(html).toContain("被拦下 1 次");
  expect(html).toContain("采纳这份产出");
});

test("an original file the assistant changed is called out above everything else", async () => {
  const taskDir = path.join(dir, "t2");
  mkdirSync(taskDir);
  writeFileSync(path.join(taskDir, "audit.json"), JSON.stringify({ summary: "做了。", artifacts: [], verification: [], needsHuman: [], notDone: [], assumptions: [],
    audit: { commands: [], filesChanged: [], searches: [], decisions: [] }, inputsModified: ["C:\Users\karol\Downloads\s.pdf"], checksPassed: false }));
  event("agent.task.requested", "t2", { title: "x", category: "draft_text", workOrderId: "" });
  event("agent.task.completed", "t2", { directory: taskDir, durationMs: 1000, commands: 0, denied: 0, artifacts: [], needsHuman: 0, checksPassed: false, inputsModified: ["C:\Users\karol\Downloads\s.pdf"], reviewRequired: true });
  expect(await render()).toContain("你的原文件被改动了");
});
