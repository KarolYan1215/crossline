import { afterEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
const settings = new Map<string, string>();
vi.mock("./crossline", () => ({
  getStore: () => ({
    listWorkspaces: () => [{ id: "ws" }, { id: "no-account" }],
    getWorkspaceOwnerId: () => "owner",
    getSetting: (ws: string, key: string) => key === "calendar.write.account" ? (ws === "ws" ? "acct" : undefined) : settings.get(`${ws}:${key}`),
    setSetting: (ws: string, key: string, value: string) => settings.set(`${ws}:${key}`, value)
  })
}));
const BLOCKS = [{ id: "scheduled:a", title: "画图", start: "2099-01-01T09:00:00Z", end: "2099-01-01T10:00:00Z", reminderMinutes: 10 }];
const blocksToPublish = vi.fn(async (..._args: unknown[]): Promise<{ blocks: typeof BLOCKS; pending?: true }> => ({ blocks: BLOCKS }));
vi.mock("./calendar-publish", () => ({ blocksToPublish: (...args: unknown[]) => blocksToPublish(...args) }));
const requestCodexSupervisor = vi.fn(async (..._args: unknown[]) => ({ state: "published" }));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: (...args: unknown[]) => (requestCodexSupervisor as (...a: unknown[]) => unknown)(...args) }));
import { autoPublishPass, publishNow } from "./auto-publish";

afterEach(() => { settings.clear(); requestCodexSupervisor.mockClear(); blocksToPublish.mockClear(); });

test("while the optimal plan is being solved nothing is written; once it is, publishNow writes it at once", async () => {
  blocksToPublish.mockResolvedValueOnce({ blocks: [], pending: true });
  expect(await autoPublishPass(new Date("2098-12-31T12:00:00Z"))).toEqual([{ workspaceId: "ws", state: "pending" }]);
  expect(requestCodexSupervisor).not.toHaveBeenCalled();
  expect(blocksToPublish.mock.calls[0]![2]).toEqual({ waitForOptimal: true });
  expect(await publishNow("ws")).toBe("published");
  expect(requestCodexSupervisor).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String((requestCodexSupervisor.mock.calls[0]![2] as { body: string }).body))).toEqual({ blocks: BLOCKS });
});

test("publishes a changed schedule once, as a system job, and skips a workspace with no calendar account", async () => {
  expect(await autoPublishPass(new Date("2098-12-31T12:00:00Z"))).toEqual([{ workspaceId: "ws", state: "published" }]);
  expect(requestCodexSupervisor).toHaveBeenCalledTimes(1);
  expect(requestCodexSupervisor.mock.calls[0]![0]).toMatchObject({ workspaceId: "ws", authMethod: "system-job" });
  expect(await autoPublishPass(new Date("2098-12-31T12:10:00Z"))).toEqual([{ workspaceId: "ws", state: "unchanged" }]);
  expect(requestCodexSupervisor).toHaveBeenCalledTimes(1);
});
