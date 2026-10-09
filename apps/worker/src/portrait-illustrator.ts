import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { portraitImageBriefs, type PortraitImageSlot, type PortraitReport } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { identityLines } from "./lines";

export const PORTRAIT_ILLUSTRATOR = "crossline:crossline-portrait-illustrator";
/** `{version, images: {slot: {file, at}}}`: which report version the pictures were drawn for, and where each one is. */
export const PORTRAIT_IMAGES = "portrait.images";

const SCHEMA = { type: "object", properties: { generated: { type: "boolean" }, note: { type: "string", minLength: 0, maxLength: 200 } },
  required: ["generated", "note"], additionalProperties: false };

/**
 * Illustrates the latest portrait report (decided 2026-10-08): one image per section, each its own short run of the runtime's image tool,
 * from a prompt the app writes (`portraitImageBriefs`: the house style, the model's redacted metaphor, the frame) — so the pictures share
 * one look and carry nothing that says who they are about. Files go to `<dataDir>/portrait/<workspace>/`; a section whose run fails keeps
 * no picture and the page draws it without one.
 */
export function createPortraitIllustrator(store: CrosslineStore, workspaceId: string, cwd: string, dataDir: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function illustrate(): Promise<{ drawn: PortraitImageSlot[]; failed: PortraitImageSlot[] }> {
    const client = getClient();
    let saved: { version?: number; report?: PortraitReport } = {};
    try { saved = JSON.parse(store.getSetting(workspaceId, "portrait.report") ?? "{}"); } catch { /* none */ }
    if (!client || !saved.report) return { drawn: [], failed: [] };
    const lines = identityLines(store, workspaceId).map((line) => ({ id: line.id, label: line.label }));
    const dir = join(dataDir, "portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const images: Record<string, { file: string; at: string }> = {};
    const drawn: PortraitImageSlot[] = [], failed: PortraitImageSlot[] = [];
    for (const brief of portraitImageBriefs(saved.report, lines)) {
      const file = `v${saved.version ?? 0}-${brief.slot}.png`;
      let wrote = false;
      const context = { version: "crossline.portrait-image.v1", slot: brief.slot, prompt: brief.prompt };
      const result = await runCodexSkill<{ generated: boolean; note: string }>(client, context, {
        skillName: PORTRAIT_ILLUSTRATOR, cwd, developerInstructions: "Generate exactly one image from the given prompt, then return raw JSON only.",
        outputSchema: SCHEMA, prepareInput: () => context, allowImageGeneration: true,
        onImage: (image) => { if (wrote) return; writeFileSync(join(dir, file), Buffer.from(image.base64, "base64")); wrote = true; },
        validateOutput: (output) => output as { generated: boolean; note: string }, onAudit: () => {}, timeoutMs: 15 * 60_000 });
      if (result.ok && wrote) { images[brief.slot] = { file, at: new Date().toISOString() }; drawn.push(brief.slot); }
      else failed.push(brief.slot);
    }
    store.setSetting(workspaceId, PORTRAIT_IMAGES, JSON.stringify({ version: saved.version ?? 0, images }));
    return { drawn, failed };
  };
}
