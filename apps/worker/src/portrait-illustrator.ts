import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { characterPrompt, type PortraitReport } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";

export const PORTRAIT_ILLUSTRATOR = "crossline:crossline-portrait-illustrator";
/** `{version, images: {slot: {file, at}}}`: which report version the pictures were drawn for, and where each one is. */
export const PORTRAIT_IMAGES = "portrait.images";

const SCHEMA = { type: "object", properties: { generated: { type: "boolean" }, note: { type: "string", minLength: 0, maxLength: 200 } },
  required: ["generated", "note"], additionalProperties: false };

/**
 * Draws the person's cartoon figure for the latest portrait report (decided 2026-10-08: pictures only where a picture carries meaning —
 * the figure that stands for their type; the charts are drawn in code). One short run of the runtime's image tool, from the prompt
 * `characterPrompt` builds: the fixed character standard, their type group's backdrop, and the writer's redacted outfit, props, pose and
 * expression. Saved to `<dataDir>/portrait/<workspace>/v<version>-character.png`; a failed run leaves the page without the figure.
 */
export function createPortraitIllustrator(store: CrosslineStore, workspaceId: string, cwd: string, dataDir: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function illustrate(): Promise<{ drawn: string[]; failed: string[] }> {
    const client = getClient();
    let saved: { version?: number; report?: PortraitReport } = {};
    try { saved = JSON.parse(store.getSetting(workspaceId, "portrait.report") ?? "{}"); } catch { /* none */ }
    const prompt = saved.report ? characterPrompt(saved.report) : null;
    if (!client || !prompt) return { drawn: [], failed: [] };
    const dir = join(dataDir, "portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const file = `v${saved.version ?? 0}-character.png`;
    let wrote = false;
    const context = { version: "crossline.portrait-image.v1", slot: "character", prompt };
    const result = await runCodexSkill<{ generated: boolean; note: string }>(client, context, {
      skillName: PORTRAIT_ILLUSTRATOR, cwd, developerInstructions: "Generate exactly one image from the given prompt, then return raw JSON only.",
      outputSchema: SCHEMA, prepareInput: () => context, allowImageGeneration: true,
      onImage: (image) => { if (wrote) return; writeFileSync(join(dir, file), Buffer.from(image.base64, "base64")); wrote = true; },
      validateOutput: (output) => output as { generated: boolean; note: string }, onAudit: () => {}, timeoutMs: 15 * 60_000 });
    const ok = result.ok && wrote;
    store.setSetting(workspaceId, PORTRAIT_IMAGES, JSON.stringify({ version: saved.version ?? 0, images: ok ? { character: { file, at: new Date().toISOString() } } : {} }));
    return ok ? { drawn: ["character"], failed: [] } : { drawn: [], failed: ["character"] };
  };
}
