import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { METHOD_RESEARCH_SETTING, type MethodResearch } from "@crossline/core";
import { methodResearchDue, verifyMethodSources } from "./method-research";
import { personProfileFor } from "./planning-profile";

const page = (title: string) => new Response(`<html><head><title>${title}</title></head><body>${title}</body></html>`,
  { status: 200, headers: { "content-type": "text/html" } });
const deps = { isPublicHost: async () => true, fetchImpl: (async (url: string | URL) =>
  String(url).includes("gone") ? new Response("", { status: 404 }) : page("Retrieval practice works")) as typeof fetch };

test("a method resting only on a page that does not open is dropped; the person's own passages stay", async () => {
  const research: MethodResearch = { habits: [], sources: [
    { id: "s1", url: "https://example.edu/retrieval", title: "Retrieval practice works", local: false },
    { id: "s2", url: "https://example.edu/gone", title: "Gone", local: false },
    { id: "s3", url: "c4", title: "课程大纲", local: true }],
  methods: [
    { kind: "考试复习", lineId: "", approach: "计时做往年卷", fitsHabit: "", aiTools: [], sourceIds: ["s1", "s2"] },
    { kind: "写报告", lineId: "", approach: "按评分标准列提纲", fitsHabit: "", aiTools: [], sourceIds: ["s2"] },
    { kind: "实验", lineId: "", approach: "按大纲的实验要求准备", fitsHabit: "", aiTools: [], sourceIds: ["s3"] }] };
  const { research: kept, dropped } = await verifyMethodSources(research, deps);
  expect(dropped).toBe(1);
  expect(kept.methods.map((method) => method.kind)).toEqual(["考试复习", "实验"]);
  expect(kept.methods[0]!.sourceIds).toEqual(["s1"]);
});

test("research is due once per finished interview, and planners read it after the profile", () => {
  const store = new CrosslineStore(":memory:");
  expect(methodResearchDue(store, "w")).toBe(false);
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "fin:1", type: "onboarding.changed", entityId: "w", payload: { change: "finish_requested" } });
  expect(methodResearchDue(store, "w")).toBe(true);
  store.setSetting("w", METHOD_RESEARCH_SETTING, JSON.stringify({ at: "2999-01-01T00:00:00Z", droppedSources: 0, sources: [],
    habits: [{ text: "写东西先列提纲", factIds: ["f1"] }],
    methods: [{ kind: "写论文", lineId: "research", approach: "先列论证提纲再写", fitsHabit: "", aiTools: [], sourceIds: ["s1"] }] }));
  expect(methodResearchDue(store, "w")).toBe(false);
  const profile = personProfileFor(store, "w", "research");
  expect(profile.some((line) => line.includes("写东西先列提纲"))).toBe(true);
  expect(profile.some((line) => line.includes("先列论证提纲再写"))).toBe(true);
  expect(personProfileFor(store, "w", "media").some((line) => line.includes("先列论证提纲再写"))).toBe(false);
  store.close();
});
