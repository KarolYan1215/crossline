import { randomUUID } from "node:crypto";
import type { CrosslineStore } from "./index";

/**
 * The person asked for an automation in words (docs/personal-agent.md): recorded here, by whichever side heard it — the input box in
 * the web app, the settings card through the worker — and designed by the worker (`designPending`) at once or on its next tick.
 */
export function requestAutomation(store: CrosslineStore, workspaceId: string, text: string, lineId: string, by: string): string {
  const id = `areq-${randomUUID().slice(0, 10)}`;
  store.appendEvent({ ownerId: by, workspaceId, idempotencyKey: `automation.requested:${id}`, type: "automation.requested", entityId: id,
    payload: { text: text.slice(0, 1000), lineId } });
  return id;
}
