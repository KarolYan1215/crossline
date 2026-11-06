import { expect, test } from "vitest";
import { DIGEST_CAPTURES_PER_RECORDING, digestDocument, digestOmitted, digestText, validateRecordingDigest } from "./recording-digest";

/** What a digest leaves out is said in the digest, never silent (W-228, 2026-11-05). */
test("a cut transcript, commitments past the cap and unverified items are named at the digest's end", () => {
  const long = "开".repeat(30_000) + "中".repeat(30_000) + "尾".repeat(30_000);
  expect(digestText(long, 40_000)).toContain("中间省略");
  expect(digestOmitted(long, 40_000)).toBe(long.length - digestText(long, 40_000).replace("\n[……中间省略……]\n", "").length);
  expect(digestOmitted("短", 40_000)).toBe(0);

  const transcript = Array.from({ length: 8 }, (_, index) => `我来做第${index + 1}件事`).join("。");
  const commitment = (index: number) => ({ text: `第${index + 1}件`, by: "person", who: "", due: "", quote: `我来做第${index + 1}件事` });
  const answer = { recordings: [{ id: "r", kind: "meeting", title: "组会", summary: "分了八件事", lineIds: [], projectId: "",
    commitments: [...Array.from({ length: 7 }, (_, index) => commitment(index)), { text: "编的", by: "person", who: "", due: "", quote: "转写里没有这句话" }],
    facts: [], dates: [{ title: "坏日期", date: "下周", time: "", quote: "我来做第1件事" }] }] };
  const [item] = validateRecordingDigest(answer, { transcripts: new Map([["r", transcript]]), lineIds: [], projectIds: [] }).recordings;
  expect(item!.commitments).toHaveLength(7);
  expect(item!.unverified).toBe(2);

  const doc = digestDocument(item!, { fileName: "a.m4a", startedAt: "2026-11-05 10:00", minutes: 180, omittedMinutes: 40 });
  const lines = doc.split("\n");
  expect(lines.filter((line) => line.includes("只记在这里，没有建成收集"))).toHaveLength(7 - DIGEST_CAPTURES_PER_RECORDING);
  expect(doc).toContain("## 没有整理到的");
  expect(doc).toContain("中间约 40 分钟没有读");
  expect(doc).toContain("另有 2 条在转写里找不到原话");
  // Nothing left out: no such section.
  expect(digestDocument({ ...item!, commitments: item!.commitments.slice(0, 2), unverified: 0 }, { fileName: "a.m4a", startedAt: "", minutes: 3 }))
    .not.toContain("没有整理到的");
});
