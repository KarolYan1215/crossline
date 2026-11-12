import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DATES_UNRECORDED_EVENT, persistFileDates, personTimeZone } from "./onboarding-persist";
import { identityLines } from "./lines";

let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const context = (sources: Record<string, string>) => ({ ownerId: "user-1", documentIds: [], sources, today: "2026-10-02", reread: false, sessionId: "s1" });
const weekly = (over: object) => ({ id: "w", title: "跑步", project: "", weekdays: [2], startTime: "20:30", endTime: "21:30", from: "2026-10-02", to: "2026-12-31",
  exceptions: [], location: "", sourceRef: "reply-1", quote: "周二晚上 8:30 跑步", confidence: "high" as const, ...over });

test("a reading that verifies nothing writes no batch but records what it dropped and why (W-228: it used to return without a word)", () => {
  persistFileDates(store, workspaceId, { fileDates: { dates: [{ id: "d", date: "2026-10-20", startTime: "", endTime: "", kind: "deadline", title: "报告",
    project: "", sourceRef: "reply-1", quote: "报告要交", confidence: "high", note: "" }], recurring: [], questions: [] } }, context({ "reply-1": "报告要交" }));
  expect(store.listEvents(workspaceId, { type: "dates.extracted" })).toEqual([]);
  expect(store.listEvents(workspaceId, { type: DATES_UNRECORDED_EVENT })[0]).toMatchObject({ entityId: "s1",
    payload: { dropped: [{ title: "报告", code: "DATE_QUOTE_DOES_NOT_SUPPORT_DATE" }] } });
});

test("a habit filed under any line is kept outside the stated hours; a meal is left out and listed as off-hours", () => {
  const line = identityLines(store, workspaceId)[0]!;
  persistFileDates(store, workspaceId, { fileDates: { dates: [], questions: [], recurring: [
    weekly({ id: "run", project: line.label }), weekly({ id: "lunch", title: "午饭", startTime: "12:00", endTime: "13:00", quote: "周二晚上 8:30 跑步" })] },
    availability: { windows: [{ days: [1, 2, 3, 4, 5], start: "13:30", end: "18:00", energy: "medium" }], why: "" } },
    context({ "reply-1": "周二晚上 8:30 跑步" }));
  const batch = store.listEvents(workspaceId, { type: "dates.extracted" })[0]!.payload as { recurring: Array<{ title: string }>; dropped: Array<{ code: string }> };
  expect(batch.recurring.map((item) => item.title)).toEqual(["跑步"]);
  expect(batch.dropped).toEqual([expect.objectContaining({ title: "午饭", code: "OFF_HOURS" })]);
});

test("with no device zone on record the person's zone is the server's configured one, as on the web; the device's wins once synced", () => {
  const before = process.env.CROSSLINE_TIME_ZONE;
  try {
    process.env.CROSSLINE_TIME_ZONE = "Asia/Shanghai";
    expect(personTimeZone(store, workspaceId)).toBe("Asia/Shanghai");
    store.setSetting(workspaceId, "schedule.preferences", JSON.stringify({ timeZone: "Europe/Berlin", mode: "buffered", importance: {} }));
    expect(personTimeZone(store, workspaceId)).toBe("Europe/Berlin");
  } finally {
    if (before === undefined) delete process.env.CROSSLINE_TIME_ZONE; else process.env.CROSSLINE_TIME_ZONE = before;
  }
});
