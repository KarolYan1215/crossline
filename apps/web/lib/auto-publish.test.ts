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
vi.mock("./calendar-publish", () => ({ blocksToPublish: async () => ({ approved: true, blocks: [{ id: "scheduled:a", title: "画图", start: "2099-01-01T09:00:00Z", end: "2099-01-01T10:00:00Z", reminderMinutes: 10 }] }) }));
const requestCodexSupervisor = vi.fn(async (..._args: unknown[]) => ({ state: "published" }));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: (...args: unknown[]) => (requestCodexSupervisor as (...a: unknown[]) => unknown)(...args) }));
import { autoPublishPass } from "./auto-publish";

afterEach(() => { settings.clear(); requestCodexSupervisor.mockClear(); });

test("publishes a changed schedule once, as a system job, and skips a workspace with no calendar account", async () => {
  expect(await autoPublishPass(new Date("2098-12-31T12:00:00Z"))).toEqual([{ workspaceId: "ws", state: "published" }]);
  expect(requestCodexSupervisor).toHaveBeenCalledTimes(1);
  expect(requestCodexSupervisor.mock.calls[0]![0]).toMatchObject({ workspaceId: "ws", authMethod: "system-job" });
  expect(await autoPublishPass(new Date("2098-12-31T12:10:00Z"))).toEqual([{ workspaceId: "ws", state: "unchanged" }]);
  expect(requestCodexSupervisor).toHaveBeenCalledTimes(1);
});
