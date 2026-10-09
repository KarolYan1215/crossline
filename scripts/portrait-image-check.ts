/**
 * One real illustration through the runtime's image tool, on a throwaway database: proves the illustrator path end to end (the feature
 * flag, the item the runtime sends, the file written) before any real report waits on it.
 *
 *   pnpm exec tsx scripts/portrait-image-check.ts
 *
 * Draws the cover only. Spends one image of the person's quota; never run as a side effect.
 */
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createPortraitIllustrator, PORTRAIT_IMAGES } from "../apps/worker/src/portrait-illustrator";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-portrait-image-"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const { workspace } = store.createPrincipalWithWorkspace("portrait-image-check", "check");
const blank = { portrait: "", coreConflict: "", keywords: [] };
store.setSetting(workspace.id, "portrait.report", JSON.stringify({ version: 1, at: new Date().toISOString(), report: {
  cover: { ...blank, portrait: "测试", archetype: "测试", tagline: "" },
  problem: { statement: "", gravity: [], designable: [], reframes: [] }, compass: { workView: "", lifeView: "", consistency: "", trueNorth: "" },
  energy: { summary: "", map: [], flow: [] }, lines: { allocation: "", items: [] },
  gap: { says: "", does: "", reading: "", anchor: "", realWant: "", reframe: "" }, insights: [], sensitive: [],
  imagery: { cover: "a lighthouse built from stacked notebooks, four rivers of different colours flowing into its base", problem: "", compass: "", energy: "", lines: "" }
} }));
const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3397),
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: ["crossline:crossline-portrait-illustrator"] }
});
try {
  const started = Date.now();
  const outcome = await createPortraitIllustrator(store, workspace.id, repoRoot, dataDir, () => supervisor.client)();
  const saved = JSON.parse(store.getSetting(workspace.id, PORTRAIT_IMAGES) ?? "{}") as { images?: Record<string, { file: string }> };
  const file = saved.images?.cover ? path.join(dataDir, "portrait", workspace.id.replace(/[^a-zA-Z0-9_-]/g, "_"), saved.images.cover.file) : "";
  console.info(JSON.stringify({ ...outcome, file, bytes: file && existsSync(file) ? statSync(file).size : 0, seconds: Math.round((Date.now() - started) / 1000) }));
  process.exitCode = outcome.drawn.includes("cover") ? 0 : 1;
} finally {
  await supervisor.stop();
  store.close();
}
