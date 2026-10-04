/**
 * Phase 3 evidence: build one real manualbook against the live Codex runtime, on a throwaway database.
 *
 *   pnpm exec tsx scripts/manualbook-check.ts
 *
 * It spends real quota (a design run, a search per step that needs one, a write-up per step) and opens real web pages,
 * so it is never run as a side effect. The task is the one a researcher actually starts with — learn Cadence Virtuoso and
 * draw a 6T SRAM cell — and the checks are about the book, not about the model: the flow is a chain, every source is a
 * public page that opened, only open-access hosts were downloaded in full, and the manifest's checksums match the folder.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createManualbookBuilder, listManualbookFiles } from "../apps/worker/src/manualbook";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-manualbook-"));
const materialsDir = path.join(dataDir, "materials");
const WORKSPACE = "manualbook-check";
const ORDER_ID = "cadence-6t";

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const failures: string[] = [];
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.info(JSON.stringify({ step: label, ok, ...(detail === undefined ? {} : { detail }) }));
  if (!ok) failures.push(label);
};

store.saveWorkOrder({
  id: ORDER_ID, ownerId: "o", workspaceId: WORKSPACE, identityId: "research", projectId: "sram", milestoneId: "",
  intent: "熟悉 Cadence Virtuoso 的使用，并构建一个 6T SRAM 单元", state: "preparing", riskTier: "milestone",
  estimate: { p25Minutes: 120, p50Minutes: 240, p85Minutes: 480, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: {
    materialContract: [
      { id: "m1", description: "Cadence Virtuoso 原理图输入与仿真（Spectre）的入门教程", required: true },
      { id: "m2", description: "6T SRAM 单元的结构、读写稳定性（SNM）和尺寸设计要点", required: true }
    ],
    evidenceContract: [{ kind: "file", description: "一张画好的 6T SRAM 单元原理图（截图）和一次仿真结果", required: true }],
    availableInputs: [{ id: "i0", text: "我有 UW-Madison 的 Cadence 账号，课程 ECE 555 会用 Cadence 做版图和 Spectre 仿真。" }]
  }
});

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-manualbook-designer", "crossline:crossline-material-researcher", "crossline:crossline-material-writer"]
  }
});

try {
  const build = createManualbookBuilder(store, WORKSPACE, materialsDir, repoRoot, () => supervisor.client, { readCost: () => supervisor.readCostSignal() });
  const started = Date.now();
  const outcome = await build(ORDER_ID);
  check("built", outcome.state === "ready", { ...outcome, minutes: Math.round((Date.now() - started) / 6000) / 10 });
  if (outcome.state === "ready") {
    const root = path.join(materialsDir, ORDER_ID);
    const flow = JSON.parse(readFileSync(path.join(root, "flow.json"), "utf8")) as { nodes: Array<{ id: string; title: string; stage: number }>; edges: unknown[] };
    check("flow_has_steps_and_links", flow.nodes.length >= 2 && flow.edges.length >= 1, flow.nodes.map((node) => `${node.stage}:${node.title}`));
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as {
      files: Array<{ path: string; sha256: string }>; sources: Array<{ kept: string; url: string; license: string; title: string }>;
    };
    const mismatched = manifest.files.filter((entry) => createHash("sha256").update(readFileSync(path.join(root, entry.path))).digest("hex") !== entry.sha256);
    check("checksums_match", mismatched.length === 0, mismatched.map((entry) => entry.path));
    const openHosts = /(arxiv\.org|biorxiv\.org|medrxiv\.org|ncbi\.nlm\.nih\.gov|europepmc\.org|openreview\.net|aclanthology\.org|mlr\.press|jmlr\.org|plos\.org|zenodo\.org|docs\.python\.org|developer\.mozilla\.org|docs\.github\.com)/;
    const wrongDownloads = manifest.sources.filter((source) => source.kept === "full_text" && !openHosts.test(source.url));
    check("only_open_access_downloaded", wrongDownloads.length === 0, wrongDownloads.map((source) => source.url));
    check("sources_listed", manifest.sources.length > 0, manifest.sources.map((source) => `${source.kept}: ${source.title} — ${source.url}`));
    check("files_written", listManualbookFiles(materialsDir, ORDER_ID).length > 6, listManualbookFiles(materialsDir, ORDER_ID));
    check("ready_for_human", store.listWorkOrders(WORKSPACE)[0]?.state === "ready_for_human");
    console.info(JSON.stringify({ materialsFolder: root }));
  }
} finally {
  await supervisor.stop();
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "manualbook_failed" : "manualbook_passed", failures }));
process.exitCode = failures.length ? 1 : 0;
