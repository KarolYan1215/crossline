import { expect, test } from "vitest";
import { GraphReadSource } from "./index";

const credential = { getAccessToken: async () => "token" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a recurring occurrence gets its title from the series master", async () => {
  // Exactly what a real UW calendar returned: `calendarView/delta` sends an occurrence as a partial
  // object — no subject, because it is unchanged from the master — so 12 of 21 events imported as
  // untitled blocks until the master was resolved.
  const calls: string[] = [];
  const source = new GraphReadSource({
    credential,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("calendarView/delta")) {
        return json({ value: [
          { id: "occ-1", seriesMasterId: "series-1", type: "occurrence",
            start: { dateTime: "2026-09-16T15:00:00" }, end: { dateTime: "2026-09-16T16:00:00" } },
          { id: "occ-2", seriesMasterId: "series-1", type: "occurrence",
            start: { dateTime: "2026-09-17T15:00:00" }, end: { dateTime: "2026-09-17T16:00:00" } },
          { id: "single", subject: "一次性会议",
            start: { dateTime: "2026-09-16T18:00:00" }, end: { dateTime: "2026-09-16T19:00:00" } }
        ], "@odata.deltaLink": "next" });
      }
      return json({ id: "series-1", subject: "机器学习 · 周三课" });
    }
  });

  const page = await source.pullCalendar();
  expect(page.items.map((item) => item.title)).toEqual(["机器学习 · 周三课", "机器学习 · 周三课", "一次性会议"]);
  // One lookup for the series, not one per occurrence.
  expect(calls.filter((url) => url.includes("/me/events/")).length).toBe(1);
});

test("a series title already resolved is not fetched again", async () => {
  let lookups = 0;
  const source = new GraphReadSource({
    credential,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("calendarView/delta") || url === "cursor") {
        return json({ value: [{ id: `occ-${lookups}`, seriesMasterId: "s", type: "occurrence",
          start: { dateTime: "2026-09-16T15:00:00" }, end: { dateTime: "2026-09-16T16:00:00" } }],
          "@odata.deltaLink": "cursor" });
      }
      lookups += 1;
      return json({ id: "s", subject: "组会" });
    }
  });
  expect((await source.pullCalendar()).items[0]?.title).toBe("组会");
  expect((await source.pullCalendar("cursor")).items[0]?.title).toBe("组会");
  expect(lookups).toBe(1);
});

test("an unresolvable series keeps the honest placeholder rather than inventing a name", async () => {
  const source = new GraphReadSource({
    credential,
    fetchImpl: async (input) => String(input).includes("calendarView/delta")
      ? json({ value: [{ id: "occ", seriesMasterId: "gone", type: "occurrence",
        start: { dateTime: "2026-09-16T15:00:00" }, end: { dateTime: "2026-09-16T16:00:00" } }] })
      : json({ error: "not found" }, 404)
  });
  expect((await source.pullCalendar()).items[0]?.title).toBe("(无标题)");
});

test("a 410 is reported as a resync rather than thrown", async () => {
  const source = new GraphReadSource({ credential, fetchImpl: async () => json({ error: "resyncRequired" }, 410) });
  expect(await source.pullCalendar()).toEqual({ items: [], resyncRequired: true });
});
