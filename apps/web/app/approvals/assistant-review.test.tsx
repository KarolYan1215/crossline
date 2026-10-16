import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { approveCategory, CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "owner-1", workspaceId: "workspace-1", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "owner-1" }, authMethod: "session" as const, requestId: "test-request" };

let store: CrosslineStore;
let dir: string;
beforeEach(() => { vi.stubEnv("CROSSLINE_SEED_EXAMPLES", ""); store = new CrosslineStore(":memory:"); globalThis.crosslineStore = store; dir = mkdtempSync(path.join(tmpdir(), "crossline-assistant-page-")); });
afterEach(() => { vi.unstubAllEnvs(); store.close(); globalThis.crosslineStore = undefined; rmSync(dir, { recursive: true, force: true }); });

const event = (type: string, entityId: string, payload: object) => store.appendEvent({ ownerId: "owner-1", workspaceId: "workspace-1", idempotencyKey: `${type}:${entityId}`, type, entityId, payload });
const render = async () => { const { AssistantReview } = await import("./assistant-review"); return renderToStaticMarkup(<AssistantReview ctx={TEST_CTX} />); };

test("on 待确认, a kind the assistant wants and a question it asked mid-run are put to the person, with the choices", async () => {
  event("agent.category.requested", "data_code_sim", { category: "data_code_sim", workOrderId: "wo-1", why: "AI 部分指向数据" });
  event("agent.approval.requested", "ap-1", { id: "ap-1", taskId: "t1", kind: "command", subject: "winget install Foo", rule: "install.global", reason: "系统级安装" });
  const html = await render();
  expect(html).toContain("请求开始「数据、代码、仿真」类工作");
  expect(html).toContain("允许「数据、代码、仿真」");
  expect(html).toContain("系统级安装");
  expect(html).toContain("允许本次");
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
  expect(html).toContain("整理 Cadence 材料");
  expect(html).toContain("整理了笔记。");
  // The summary is the model's, drawn as generated text and held to two lines on the card (`Clamp`).
  expect(html).toMatch(/class="gen"><span class="clamp"[^>]*>整理了笔记。/);
  expect(html).toContain("/api/agent/tasks/t1/file?path=n.md");
  expect(html).toContain("确认课程环境");
  expect(html).toContain("助手做了哪些操作（1 步） · 拦下 1 次");
  expect(html).not.toContain("powershell");
  expect(html).toContain("已自检 1 项，全部通过");
  expect(html).toContain("按暂定日程");
  expect(html).toContain("退回让助手补上");
  expect(html).toContain(">批准</button>");
});

test("an original file the assistant changed is called out above everything else", async () => {
  const taskDir = path.join(dir, "t2");
  mkdirSync(taskDir);
  writeFileSync(path.join(taskDir, "audit.json"), JSON.stringify({ summary: "做了。", artifacts: [], verification: [], needsHuman: [], notDone: [], assumptions: [],
    audit: { commands: [], filesChanged: [], searches: [], decisions: [] }, inputsModified: ["C:\Users\karol\Downloads\s.pdf"], checksPassed: false }));
  event("agent.task.requested", "t2", { title: "x", category: "draft_text", workOrderId: "" });
  event("agent.task.completed", "t2", { directory: taskDir, durationMs: 1000, commands: 0, denied: 0, artifacts: [], needsHuman: 0, checksPassed: false, inputsModified: ["C:\Users\karol\Downloads\s.pdf"], reviewRequired: true });
  expect(await render()).toContain("原文件被改动");
});

test("a result is shown by what it made: grouped deliverables with previews, a workflow as steps, no scripts or file names of the workflow", async () => {
  approveCategory(store, "workspace-1", "read_research_organize");
  const taskDir = path.join(dir, "t3");
  mkdirSync(path.join(taskDir, "skill", "scripts"), { recursive: true });
  writeFileSync(path.join(taskDir, "提纲.md"), "# 复习提纲\n\n- 载流子浓度\n- P–N 结\n");
  writeFileSync(path.join(taskDir, "gaps.csv"), "缺口,下一步\nL1 正文,向老师索取\n");
  writeFileSync(path.join(taskDir, "skill", "workflow.json"), JSON.stringify({ name: "复习提纲工作流", summary: "先建材料台账，再生成提纲。",
    steps: [{ title: "建立材料台账", by: "assistant", external: false }, { title: "确认考试范围", by: "person", external: false }] }));
  writeFileSync(path.join(taskDir, "audit.json"), JSON.stringify({ summary: "建了工作流。", artifacts: [
    { path: "提纲.md", purpose: "复习提纲", sha256: "a", bytes: 1 }, { path: "gaps.csv", purpose: "材料缺口", sha256: "b", bytes: 1 },
    { path: "skill/SKILL.md", purpose: "工作流说明", sha256: "c", bytes: 1 }, { path: "skill/workflow.json", purpose: "元数据", sha256: "d", bytes: 1 },
    { path: "skill/scripts/build.py", purpose: "脚本", sha256: "e", bytes: 1 }],
    verification: [{ check: "脚本离线示例运行", result: "pass", evidence: "python" }, { check: "提纲覆盖全部讲次", result: "fail", evidence: "缺 L2" }],
    needsHuman: [], notDone: [{ what: "未整理实际课程材料。", why: "本次只建流程。" }], assumptions: [],
    audit: { commands: [], filesChanged: [], searches: [], decisions: [] }, inputsModified: [], checksPassed: false }));
  event("agent.task.requested", "t3", { title: "建立复习工作流", category: "read_research_organize", workOrderId: "" });
  event("agent.task.completed", "t3", { directory: taskDir, durationMs: 60_000, commands: 0, denied: 0, artifacts: [], needsHuman: 0, checksPassed: false, inputsModified: [], reviewRequired: true });
  const html = await render();
  expect(html).toContain("成品 · 1");
  expect(html).toContain("缺口清单 · 1");
  expect(html).toContain("<li>载流子浓度</li>");
  expect(html).toContain("<th scope=\"col\">缺口</th>");
  expect(html).toContain("<td>向老师索取</td>");
  expect(html).toContain("复习提纲工作流");
  expect(html).toContain("确认考试范围");
  expect(html).not.toMatch(/build\.py|SKILL\.md|workflow\.json/);
  expect(html).toContain("已自检 1 项，1 项未通过");
  expect(html).toContain("提纲覆盖全部讲次");
  expect(html).toContain("本次没有做");
  expect(html).toContain("未整理实际课程材料。");
});
