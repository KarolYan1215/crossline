import { expect, test } from "vitest";
import { addAttentionBeat } from "./onboarding-attention";

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();
test("只计可见且 60 秒内有操作的时间；两次心跳间隔超过 20 秒只记 20 秒；达标时刻只记一次", () => {
  let record = addAttentionBeat(undefined, { at: at(0), inputAgoMs: 1_000, rounds: 1, ready: false, complete: false });
  record = addAttentionBeat(record, { at: at(15), inputAgoMs: 5_000, rounds: 1, ready: false, complete: false });
  expect(record.seconds).toBe(15);
  record = addAttentionBeat(record, { at: at(30), inputAgoMs: 70_000, rounds: 1, ready: false, complete: false });
  expect(record.seconds).toBe(15);
  record = addAttentionBeat(record, { at: at(330), inputAgoMs: 2_000, rounds: 3, ready: true, complete: false });
  expect(record.seconds).toBe(35);
  expect(record.ready).toEqual({ seconds: 35, rounds: 3, at: at(330) });
  record = addAttentionBeat(record, { at: at(345), inputAgoMs: 2_000, rounds: 4, ready: true, complete: false });
  expect(record.ready?.rounds).toBe(3);
});

test("完整设置的时刻同样只记一次；时钟倒退的心跳不加秒数", () => {
  let record = addAttentionBeat(undefined, { at: at(10), inputAgoMs: 0, rounds: 5, ready: true, complete: true });
  expect(record).toMatchObject({ seconds: 0, ready: { seconds: 0, rounds: 5 }, complete: { seconds: 0, rounds: 5 } });
  record = addAttentionBeat(record, { at: at(5), inputAgoMs: 0, rounds: 6, ready: true, complete: true });
  expect(record.seconds).toBe(0);
  expect(record.complete?.rounds).toBe(5);
});
