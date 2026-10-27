import { expect, test } from "vitest";
import { CrosslineStore, OWN_COMPLETION_REPAIR, repairOwnCompletions } from "./index";

const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };

test("once per workspace, work the person completed and the gate then blocked is accepted; other blocked work is left alone", () => {
  const store = new CrosslineStore(":memory:");
  const { workspace, principal } = store.createPrincipalWithWorkspace("user-1", "w");
  const ws = workspace.id;
  const order = (id: string, events: Array<Record<string, unknown>>) => {
    store.saveWorkOrder({ id, ownerId: principal.id, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "", intent: id,
      state: "approved", riskTier: "routine", estimate, payload: {} });
    events.forEach((event, index) => store.transitionWorkOrder(ws, id, event as never, `${id}:${index}`, {}));
  };
  order("done-then-refused", [{ type: "materials.not_required" }, { type: "human.started" }, { type: "human.completed" }, { type: "blocked", reason: "MILESTONE_GATE_INSUFFICIENT" }]);
  order("blocked-otherwise", [{ type: "blocked", reason: "MATERIALS_BLOCKED" }]);
  expect(repairOwnCompletions(store, ws, principal.id)).toEqual(["done-then-refused"]);
  const state = (id: string) => store.listWorkOrders(ws).find((item) => item.id === id)!.state;
  expect(state("done-then-refused")).toBe("accepted");
  expect(state("blocked-otherwise")).toBe("blocked");
  expect(store.getSetting(ws, OWN_COMPLETION_REPAIR)).toBeTruthy();
  expect(repairOwnCompletions(store, ws, principal.id)).toBeUndefined();
  store.close();
});
