import type { Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Relative, not @crossline/db: the repo root is not a workspace package and has no such dependency.
import { CrosslineStore } from "../packages/db/src/index.js";

/** The ledger the e2e server opened (`CROSSLINE_E2E_DATA_DIR`, stashed by the config so every test worker reaches the same file). */
export function openStore(): CrosslineStore {
  return new CrosslineStore(path.join(process.env.CROSSLINE_E2E_DATA_DIR!, "crossline.db"));
}

/**
 * `global-setup.ts` signs in the one e2e test account once per run, and its first authenticated request
 * is what creates that account's principal+workspace row (`requireAccessContext`'s
 * `createPrincipalWithWorkspace`) — there is no hardcoded workspace id to read any more, real accounts
 * get a real generated one. A fresh per-run database has exactly one, so the first is the right one.
 */
export function realWorkspaceId(store: CrosslineStore): string {
  const workspace = store.listWorkspaces()[0];
  if (!workspace) throw new Error("No workspace exists yet — did global-setup.ts's sign-in run?");
  return workspace.id;
}

/**
 * Gives the account a portrait report: the fictional stress fixture (`fixtures/portrait-report.json` — adjacent high values, energy
 * activities with identical scores, two pieces of advice on one matrix cell, an axis at 52%). Written only when none exists, so the
 * desktop and phone projects see the same report whichever runs first.
 */
export async function ensurePortrait(page: Page): Promise<void> {
  await page.goto("/settings");
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    if (store.getSetting(workspaceId, "portrait.report")) return;
    const report = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "portrait-report.json"), "utf8")) as unknown;
    store.setSetting(workspaceId, "portrait.report", JSON.stringify({ version: 1, at: "2026-10-12T09:00:00.000Z", schema: 4, report }));
  } finally { store.close(); }
}

/**
 * Gives the account a tutorial and an uploaded file for the material pages' audits, and returns the two addresses to open: the reading
 * page of the first open task's tutorial (`/materials/<id>`) and the material page of a Markdown upload (`/materials/view?src=…`). The
 * book is fictional and long on purpose — a table wider than a phone, citations repeated across sections, a 「需要补充」 line — and is
 * written where the worker writes books (`<data dir>/materials/<id>/`). Written only when none exists.
 */
export async function ensureMaterials(page: Page): Promise<{ tutorial: string; view: string }> {
  await page.goto("/settings");
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    const dataDir = process.env.CROSSLINE_E2E_DATA_DIR!;
    const order = store.listWorkOrders(workspaceId).find((item) => item.state !== "archived" && item.state !== "accepted");
    if (!order) throw new Error("No open work order on the e2e board");
    const docId = "e2e-material-doc";
    const sources = path.join(dataDir, "sources");
    if (!store.listSourceDocuments(workspaceId).some((doc) => doc.id === docId)) {
      mkdirSync(sources, { recursive: true });
      const text = "# 课程安排\n\n## 评分\n\n| 部分 | 占比 | 说明 |\n|---|---|---|\n| 期中考试一 | 22% | 闭卷，可带一页单面公式纸，只允许使用计算器 |\n| 作业 | 20% | 每两周一次，在课程平台提交 |\n\n## 讲次\n\n1. 第 1 讲：量子力学与固体物理基础\n2. 第 2 讲：掺杂\n\n> 日期为暂定，以课程平台为准。\n";
      writeFileSync(path.join(sources, `${docId}.txt`), text);
      store.saveSourceDocument({ id: docId, ownerId: order.ownerId, workspaceId, kind: "text", fileName: "课程安排.md", mediaType: "text/markdown", sha256: docId,
        uri: pathToFileURL(path.join(sources, `${docId}.txt`)).href, extractedText: text, extractionStatus: "done", createdAt: "2026-10-01T09:00:00.000Z" });
    }
    const root = path.join(dataDir, "materials", order.id);
    if (!existsSync(path.join(root, "flow.json"))) {
      const nodes = [
        { id: "read-brief", title: "通读题目并列出要求", kind: "read", goal: "形成覆盖每一题的要求清单。", stage: 0, order: 0 },
        { id: "check-work", title: "核对推导与提交格式", kind: "verify", goal: "发现并修正推导、单位与格式问题。", stage: 1, order: 1 }
      ];
      const write = (relative: string, body: string) => { mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), body); };
      write("flow.json", JSON.stringify({ version: 1, nodes, edges: [{ from: "read-brief", to: "check-work" }] }));
      write("manual.md", `# ${order.intent}\n\n按两个步骤推进：先列出每题要求，再逐题核对。\n\n## 假设\n- 题目在课程平台按时发布。\n\n## 流程\n1. …`);
      write("materials.json", JSON.stringify([{ id: "upload-1", title: "课程安排.md", publisher: "本人上传", url: "", docId, kept: "full_text", verdict: "本人上传的文件", summary: "课程安排",
        notes: [{ node: "read-brief", step: "通读题目并列出要求", note: "评分表给出各部分占比；作业每两周一次。" }] }]));
      for (const node of nodes) {
        write(`nodes/${node.id}/task.md`, `# ${node.title}\n\n**目标**：${node.goal}\n\n## 步骤\n1. 打开题目\n\n## 怎样算做到\n每一题都有对应的要求条目与检查方法。`);
        write(`nodes/${node.id}/tutorial.md`, `# 教程：${node.title}\n\n1. 在课程平台打开作业条目，下载题目与评分细则，记录每一题的输入条件、输出内容和提交形式。[upload-1]\n\n2. 建立逐题核对表，字段为题号、要求、解答位置、单位、格式和修正状态。[s1]\n\n3. 对每个关键数值独立复算，保留公式、代入值、单位与结果的链路。`);
        write(`nodes/${node.id}/analysis.md`, `# 分析：${node.title}\n\n需要补充：作业题目页、提交格式要求。\n\n课程安排给出评分占比与讲次，可用于确定复习范围。[upload-1]\n\n## 参考来源\n- s1`);
        write(`nodes/${node.id}/sources.json`, JSON.stringify([{ id: "s1", url: "https://ocw.mit.edu/courses/example", title: "核对表的做法", publisher: "MIT OpenCourseWare", kept: "summary_only", verdict: "", summary: "" }]));
      }
    }
    const src = `/api/source-documents/${docId}/file`;
    return { tutorial: `/materials/${order.id}`, view: `/materials/view?src=${encodeURIComponent(src)}&name=${encodeURIComponent("课程安排.md")}&from=${encodeURIComponent(`/workbench/${order.id}`)}` };
  } finally { store.close(); }
}

/**
 * Gives the account a skill library for the settings page's audits: one line skill with its sources (a person's review note, a confirmed
 * fact, a platform page) and an earlier version, and two public skills — one usable, one kept as text only after the scan found a script
 * that reaches the network — and one grown workflow (a weekly vlog cut whose publishing step is the person's). Written only when none exists.
 */
export async function ensureSkillLibrary(page: Page): Promise<void> {
  await page.goto("/settings");
  const store = openStore();
  try {
    const workspaceId = realWorkspaceId(store);
    if (store.getSetting(workspaceId, "skills.library")) return;
    const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "skill-library.json"), "utf8")) as
      { mine: Record<string, unknown>; library: unknown[]; grown: unknown[]; grownFiles: Record<string, unknown> };
    const line = (store.getSetting(workspaceId, "lines.v1") ? (JSON.parse(store.getSetting(workspaceId, "lines.v1")!) as Array<{ id: string }>)[0]?.id : undefined) ?? "media";
    store.setSetting(workspaceId, `skills.mine.${line}`, JSON.stringify({ ...fixture.mine, lineId: line }));
    store.setSetting(workspaceId, "skills.library", JSON.stringify(fixture.library));
    store.setSetting(workspaceId, "skills.grown", JSON.stringify(fixture.grown));
    for (const [id, files] of Object.entries(fixture.grownFiles)) store.setSetting(workspaceId, `skills.grown.files.${id}`, JSON.stringify(files));
  } finally { store.close(); }
}
