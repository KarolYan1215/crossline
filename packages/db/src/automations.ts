import { randomUUID } from "node:crypto";
import { AUTOMATIONS_SETTING, automationDefinition, readAutomations, tFor, type Automation, type AutomationDefinition } from "@crossline/core";
import type { CrosslineStore } from "./index";
import { readLocale } from "./locale";

/**
 * The person asked for an automation in words (docs/personal-agent.md): recorded here, by whichever side heard it — the input box in
 * the web app, the settings card through the worker — and designed by the worker (`designPending`) at once or on its next tick.
 */
export function requestAutomation(store: CrosslineStore, workspaceId: string, text: string, lineId: string, by: string,
  thread?: { workflowId: string }): string {
  const id = `areq-${randomUUID().slice(0, 10)}`;
  store.appendEvent({ ownerId: by, workspaceId, idempotencyKey: `automation.requested:${id}`, type: "automation.requested", entityId: id,
    payload: { text: text.slice(0, 1000), lineId } });
  // The request opens the conversation it is designed in (the 自动化 page, 2026-11-10): the person's words, and the designer's answer
  // as it comes. A request about a workflow that already has one goes on in that one.
  const at = new Date().toISOString();
  const existing = thread?.workflowId ? store.findWorkflowThread(workspaceId, thread.workflowId) : undefined;
  const threadId = existing?.id ?? id;
  if (!existing) store.saveWorkflowThread({ workspaceId, id, workflowId: thread?.workflowId ?? "", kind: "automation", codexThreadId: "", lineId,
    title: text.slice(0, 200), createdAt: at, updatedAt: at });
  store.saveWorkflowTurn({ workspaceId, id: `${id}-ask`, threadId, role: "person", text: text.slice(0, 1000), items: [], state: "done", createdAt: at });
  store.saveWorkflowTurn({ workspaceId, id: `${id}-reply`, threadId, role: "assistant", text: "", items: [], state: "running", createdAt: at });
  return id;
}

/** The conversation a request was put in (its own, or the workflow's it was about). */
export function requestThreadId(store: CrosslineStore, workspaceId: string, requestId: string): string | undefined {
  if (store.getWorkflowThread(workspaceId, requestId)) return requestId;
  return store.listWorkflowThreads(workspaceId).find((thread) => store.listWorkflowTurns(workspaceId, thread.id).some((turn) => turn.id === `${requestId}-reply`))?.id;
}

/**
 * Back to any earlier version of an automation (the 自动化 page, 2026-11-10), as a new version: the chosen version's definition — name,
 * trigger, action, steps — replaces the one in force; its runs, conversation and whether it is paused stay. A watched page's last reading
 * is dropped when the page changes. Undefined when there is no such version or it is the one in force.
 */
export function restoreAutomationVersion(store: CrosslineStore, workspaceId: string, id: string, version: number, now = new Date()): number | undefined {
  const list = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
  const current = list.find((item) => item.id === id);
  const versions = store.listWorkflowVersions(workspaceId, "automation", id);
  const target = versions.find((item) => item.version === version)?.data as AutomationDefinition | undefined;
  if (!current || !target || JSON.stringify(automationDefinition(target)) === JSON.stringify(automationDefinition(current))) return undefined;
  const definition = automationDefinition(target);
  const sameWatch = current.trigger.type === "watch" && definition.trigger.type === "watch" && current.trigger.url === definition.trigger.url;
  const { watch, ...rest } = current;
  const next: Automation = { ...rest, ...definition, updatedAt: now.toISOString(), ...(watch && sameWatch ? { watch } : {}) };
  return store.atomically(() => {
    store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify(list.map((item) => item.id === id ? next : item)));
    const made = store.annotateWorkflowVersion(workspaceId, "automation", id,
      { source: "rollback", note: tFor(readLocale(store, workspaceId))("回到第 {{version}} 版", { version }) });
    store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "system", workspaceId, idempotencyKey: `automation.restored:${id}:${made}:${now.toISOString()}`,
      type: "automation.restored", entityId: id, payload: { id, restoredFrom: version, version: made } });
    return made;
  });
}
