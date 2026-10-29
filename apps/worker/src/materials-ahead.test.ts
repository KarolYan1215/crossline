import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { prepareMaterialsAhead } from "./manualbook";
import { ORDER_STARTS_SETTING } from "./schedule-window";

/** Materials are prepared within a day of the first block, not when the person presses 开始 (docs/plans/closed-loop-1030.md §5). */
let store: CrosslineStore;
let ws: string;
let owner: string;
const NOW = new Date("2026-11-10T15:00:00Z");
const estimate = { p25Minutes: 30, p50Minutes: 45, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "w");
  ws = created.workspace.id; owner = created.principal.id;
});
afterEach(() => store.close());

const order = (id: string, contract: boolean) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: "research", projectId: "p", milestoneId: "",
  intent: id, state: "approved", riskTier: "routine", estimate,
  payload: { materialContract: contract ? [{ kind: "notes", description: "讲义要点", why: "做题要用", required: true }] : [] } });

test("work with a material contract whose first block is within a day goes to preparing; later work and work without a contract wait", () => {
  order("soon", true); order("later", true); order("none", false);
  store.setSetting(ws, ORDER_STARTS_SETTING, JSON.stringify({ soon: "2026-11-11T09:00:00Z", later: "2026-11-13T09:00:00Z", none: "2026-11-11T09:00:00Z" }));
  expect(prepareMaterialsAhead(store, ws, NOW)).toEqual(["soon"]);
  expect(store.getWorkOrder(ws, "soon")!.state).toBe("preparing");
  expect(store.getWorkOrder(ws, "later")!.state).toBe("approved");
  expect(store.getWorkOrder(ws, "none")!.state).toBe("approved");
  expect(prepareMaterialsAhead(store, ws, NOW)).toEqual([]);
});
