import "server-only";
import type { AccessContext } from "@crossline/core";
import { listAgentTasks } from "@crossline/db";
import { getStore } from "./crossline";
import { runtimeStatus } from "./runtime-status";

/** What the floating 小帮手 shows: the person's portrait figure (null until one is drawn) and what the background is doing. */
export type HelperState = { avatar: string | null; working: boolean; down: boolean };

/**
 * The figure is the portrait's character image (`portrait.images`), whatever report version drew it — an older figure is still the
 * person — addressed with its drawing time so a new one is fetched once and the old one stays cached. A guest runtime that cannot draw
 * images, or a report not written yet, has none, and the page keeps the text button.
 */
export async function helperState(ctx: AccessContext): Promise<HelperState> {
  const store = getStore();
  let drawn: { images?: Record<string, { file?: string; at?: string }> } = {};
  try { drawn = JSON.parse(store.getSetting(ctx.workspaceId, "portrait.images") ?? "{}"); } catch { /* none */ }
  const character = drawn.images?.character;
  const avatar = character?.file ? `/api/portrait/image/character?v=${encodeURIComponent(character.at ?? character.file)}` : null;
  return {
    avatar,
    working: listAgentTasks(store, ctx.workspaceId).some((task) => task.status === "running"),
    down: Boolean(await runtimeStatus(ctx))
  };
}
