import "server-only";
import type { AccessContext } from "@crossline/core";
import { listAgentTasks } from "@crossline/db";
import { getStore } from "./crossline";
import { currentFigure, figureUrl } from "./figures";
import { runtimeStatus } from "./runtime-status";
import { personCalls, type PersonCall } from "./person-calls";

/**
 * What the floating 小帮手 shows: the person's portrait figure (null until one is drawn), what the background is doing, and what only the
 * person can do now (`calls`, said on every page).
 */
export type HelperState = { avatar: string | null; working: boolean; down: boolean; calls: PersonCall[] };

/**
 * The figure is the person's (`currentFigure`: the one they picked on the portrait page, else the latest drawing, whatever report version
 * drew it), addressed by file and time so a new one is fetched once and the old one stays cached. A guest runtime that cannot draw
 * images, or a report not written yet, has none, and the page keeps the text button.
 */
export async function helperState(ctx: AccessContext): Promise<HelperState> {
  const store = getStore();
  const figure = currentFigure(ctx);
  const status = await runtimeStatus(ctx);
  return {
    avatar: figure ? figureUrl(figure) : null,
    working: listAgentTasks(store, ctx.workspaceId).some((task) => task.status === "running"),
    // The developer's model standing in for a spent ChatGPT is a notice, not the worker being down.
    down: Boolean(status) && status?.code !== "sponsor_standin",
    calls: personCalls(ctx)
  };
}
