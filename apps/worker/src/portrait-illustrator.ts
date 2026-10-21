import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appearanceBasis, characterPrompt, figureRedrawDue, nextDrawnFigureFile, type PortraitReport } from "@crossline/core";
import { currentRoute, runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { imageBackendFromEnv, type ImageBackend } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";

export const PORTRAIT_ILLUSTRATOR = "crossline:crossline-portrait-illustrator";
/**
 * `{version, images: {slot: {file, at, basis}}}`: the latest drawing — the report version it was drawn for, its file, and what the person
 * had said about how they look (`appearanceBasis`; absent on drawings from before 2026-10-21).
 */
export const PORTRAIT_IMAGES = "portrait.images";
/** How many figures this account has had drawn on the server's image key (`{count}`); never reset, deleting a figure does not give one back. */
export const PORTRAIT_IMAGE_DRAWS = "portrait.imageDraws";

/**
 * Figures each account may have drawn on the server's own image key (`CROSSLINE_IMAGE_PER_ACCOUNT`, default 3; the owner's decision of
 * 2026-10-17: a limit per account, none per day). A figure is redrawn only when the person asks or describes how they look differently,
 * and the limit is what bounds the cost of those.
 * Figures drawn by the account's own Codex sign-in spend its own quota and are not counted.
 */
export function imageDrawsPerAccount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CROSSLINE_IMAGE_PER_ACCOUNT);
  return env.CROSSLINE_IMAGE_PER_ACCOUNT?.trim() && Number.isInteger(raw) && raw >= 0 ? raw : 3;
}

const SCHEMA = { type: "object", properties: { generated: { type: "boolean" }, note: { type: "string", minLength: 0, maxLength: 200 } },
  required: ["generated", "note"], additionalProperties: false };

/**
 * Draws the person's cartoon figure for the latest portrait report (decided 2026-10-08: pictures only where a picture carries meaning —
 * the figure that stands for their type; the charts are drawn in code). One short run of the runtime's image tool, from the prompt
 * `characterPrompt` builds: the fixed character standard, their type group's backdrop, and the writer's redacted outfit, props, pose and
 * expression. Saved to `<dataDir>/portrait/<workspace>/v<version>-character.png` (a later drawing of the same version gets its own name).
 *
 * The figure is the person's, not the report's (2026-10-21): one already drawn is kept — a report rewritten for a new schema, or its
 * words written again, draws nothing — unless the person asks for a new one (`redraw`) or has since said differently how they look
 * (`figureRedrawDue`). A failed drawing leaves the figure that was there.
 */
export function createPortraitIllustrator(store: CrosslineStore, workspaceId: string, cwd: string, dataDir: string, getClient: () => CodexRpcBoundary | undefined,
  imageApi: () => ImageBackend | undefined = imageBackendFromEnv) {
  return async function illustrate(options: { redraw?: boolean } = {}): Promise<{ drawn: string[]; failed: string[]; kept?: boolean }> {
    const client = getClient();
    let saved: { version?: number; report?: PortraitReport } = {};
    try { saved = JSON.parse(store.getSetting(workspaceId, "portrait.report") ?? "{}"); } catch { /* none */ }
    const prompt = saved.report ? characterPrompt(saved.report) : null;
    // A workspace whose runs go to another model has no image tool through Codex: an image API draws from the same prompt directly
    // (docs/beta-launch.md §10.4). With no image API configured it is left to the Codex sign-in, as before.
    const direct = currentRoute(PORTRAIT_ILLUSTRATOR).via !== "codex" ? imageApi() : undefined;
    if ((!client && !direct) || !prompt) return { drawn: [], failed: [] };
    let previous: { images?: { character?: { file?: string; at?: string; basis?: string } } } = {};
    try { previous = JSON.parse(store.getSetting(workspaceId, PORTRAIT_IMAGES) ?? "{}"); } catch { /* none */ }
    const facts = store.listProfileFacts(workspaceId, { identityId: "person" });
    if (!figureRedrawDue(previous.images?.character, facts, options.redraw)) {
      console.info(JSON.stringify({ type: "portrait.figure_kept", workspaceId, file: previous.images?.character?.file }));
      return { drawn: [], failed: [], kept: true };
    }
    const dir = join(dataDir, "portrait", workspaceId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    mkdirSync(dir, { recursive: true });
    const file = nextDrawnFigureFile(saved.version ?? 0, readdirSync(dir));
    // Only a drawing that landed is recorded, with what the person had said about how they look; a failure keeps the figure there was.
    const record = (ok: boolean) => { if (ok) store.setSetting(workspaceId, PORTRAIT_IMAGES,
      JSON.stringify({ version: saved.version ?? 0, images: { character: { file, at: new Date().toISOString(), basis: appearanceBasis(facts) } } })); };
    if (direct) {
      let drawn = 0;
      try { drawn = Number((JSON.parse(store.getSetting(workspaceId, PORTRAIT_IMAGE_DRAWS) ?? "{}") as { count?: unknown }).count) || 0; } catch { /* none */ }
      // Over the limit the figure already drawn stays on the page; nothing is recorded as failed.
      if (drawn >= imageDrawsPerAccount()) {
        console.warn(JSON.stringify({ type: "portrait.image_limit", workspaceId, drawn }));
        return { drawn: [], failed: [] };
      }
      // Counted before the call: a call that fails still cost a request, so the count can only overstate what was spent.
      store.setSetting(workspaceId, PORTRAIT_IMAGE_DRAWS, JSON.stringify({ count: drawn + 1, at: new Date().toISOString() }));
      const ok = await direct.generate(prompt).then((bytes) => { writeFileSync(join(dir, file), bytes); return true; }, (error: unknown) => {
        console.warn(JSON.stringify({ type: "portrait.image_api_failed", workspaceId, message: error instanceof Error ? error.message.slice(0, 200) : "failed" }));
        return false;
      });
      record(ok);
      return ok ? { drawn: ["character"], failed: [] } : { drawn: [], failed: ["character"] };
    }
    if (!client) return { drawn: [], failed: [] };
    let wrote = false;
    const context = { version: "crossline.portrait-image.v1", slot: "character", prompt };
    const result = await runCodexSkill<{ generated: boolean; note: string }>(client, context, {
      skillName: PORTRAIT_ILLUSTRATOR, cwd, developerInstructions: "Draw the person's portrait figure: call the image tool exactly once with the given prompt, unchanged, then return raw JSON only.",
      outputSchema: SCHEMA, prepareInput: () => context, allowImageGeneration: true,
      onImage: (image) => { if (wrote) return; writeFileSync(join(dir, file), Buffer.from(image.base64, "base64")); wrote = true; },
      validateOutput: (output) => output as { generated: boolean; note: string }, onAudit: () => {}, timeoutMs: 15 * 60_000 });
    const ok = result.ok && wrote;
    record(ok);
    return ok ? { drawn: ["character"], failed: [] } : { drawn: [], failed: ["character"] };
  };
}
