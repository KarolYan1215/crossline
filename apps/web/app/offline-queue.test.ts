import { expect, test } from "vitest";
import { replayQueue, type OfflineCommand, type ReplayStore } from "./offline-queue";
import type { DeadLetter } from "@crossline/core";

const WORKSPACE = "workspace-1";
const command = (id: string, sequence: number): OfflineCommand => ({
  ownerId: "local-owner", workspaceId: WORKSPACE, clientCommandId: id,
  clientSequence: sequence, type: "task.capture", payload: { title: `t-${id}` },
  createdAt: "2026-09-20T00:00:00.000Z"
});

const fakeStore = (pending: OfflineCommand[]) => {
  const state = { pending: [...pending], dead: [] as Array<DeadLetter<OfflineCommand>>, conflicts: [] as Array<DeadLetter<OfflineCommand>> };
  const store: ReplayStore = {
    listPending: async () => state.pending,
    removePending: async (id) => { state.pending = state.pending.filter((item) => item.clientCommandId !== id); },
    putDead: async (entry) => { state.dead.push(entry); },
    putConflict: async (entry) => { state.conflicts.push(entry); }
  };
  return { state, store };
};

test("a permanently rejected capture becomes a visible dead letter instead of retrying forever", async () => {
  const { state, store } = fakeStore([command("a", 1)]);
  const summary = await replayQueue(WORKSPACE, async () => ({ status: 400 }), store);
  expect(summary).toEqual({ sent: 0, retrying: 0, deadLettered: 1, conflicted: 0 });
  // It must leave the pending queue, or every future reconnect replays it again.
  expect(state.pending).toEqual([]);
  expect(state.dead[0]).toMatchObject({ status: 400, command: { clientCommandId: "a" } });
  expect(state.dead[0]!.reason).toContain("400");
});

test("a transient failure stays queued so nothing is lost while offline", async () => {
  const { state, store } = fakeStore([command("a", 1)]);
  expect(await replayQueue(WORKSPACE, async () => { throw new Error("network down"); }, store))
    .toEqual({ sent: 0, retrying: 1, deadLettered: 0, conflicted: 0 });
  expect(state.pending).toHaveLength(1);
  expect(state.dead).toEqual([]);

  for (const status of [500, 429, 408]) {
    expect((await replayQueue(WORKSPACE, async () => ({ status }), store)).retrying).toBe(1);
    expect(state.pending).toHaveLength(1);
  }
});

test("replay follows the order the captures were made", async () => {
  const seen: number[] = [];
  const { store } = fakeStore([command("c", 3), command("a", 1), command("b", 2)]);
  await replayQueue(WORKSPACE, async (item) => { seen.push(item.clientSequence); return { status: 200 }; }, store);
  expect(seen).toEqual([1, 2, 3]);
});

test("one bad capture does not block the ones behind it", async () => {
  const { state, store } = fakeStore([command("bad", 1), command("good", 2)]);
  const summary = await replayQueue(WORKSPACE, async (item) => ({ status: item.clientCommandId === "bad" ? 422 : 200 }), store);
  expect(summary).toEqual({ sent: 1, retrying: 0, deadLettered: 1, conflicted: 0 });
  expect(state.pending).toEqual([]);
});

test("a work order that moved on under an offline command becomes a conflict, not a dead letter", async () => {
  const { state, store } = fakeStore([command("a", 1)]);
  const summary = await replayQueue(WORKSPACE, async () => ({ status: 409 }), store);
  expect(summary).toEqual({ sent: 0, retrying: 0, deadLettered: 0, conflicted: 1 });
  expect(state.pending).toEqual([]);
  expect(state.dead).toEqual([]);
  expect(state.conflicts[0]).toMatchObject({ status: 409, command: { clientCommandId: "a" } });
});
