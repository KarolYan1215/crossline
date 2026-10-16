import { afterEach, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" }, authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));
const supervisor = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ ok: true })));
vi.mock("../../../../lib/codex-runtime", () => ({ requestCodexSupervisor: supervisor, CodexSupervisorRequestError: class extends Error {} }));
vi.mock("../../../../lib/lines", () => ({ identityLines: () => [{ id: "research", label: "研究者" }] }));
// The account's name goes to the worker, which uses it to spot records that carry the person.
vi.mock("../../../../lib/auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { name: "Kai Yan" } }) } }) }));

afterEach(() => supervisor.mockClear());

const post = async (body: unknown, origin?: string) => (await import("./route")).POST(new Request("http://127.0.0.1/api/sources/folders",
  { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }));
const sent = () => { const [, pathname, init] = supervisor.mock.calls[0] as [unknown, string, RequestInit]; return { pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, method: init.method }; };

test("authorizing carries the preview's exclusions, cleaned: no drive, no climbing out of the folder", async () => {
  expect((await post({ action: "add", path: "D:\\Downloads", exclude: ["Tax 2019", "C:\\Windows", "../x", 7], include: ["Passport.pdf"] })).status).toBe(200);
  expect(sent()).toEqual({ pathname: "/v1/sources/folders", method: "POST", body: { path: "D:\\Downloads", exclude: ["Tax 2019"], include: ["Passport.pdf"], names: ["Kai Yan"] } });
}, 30_000); // the first test pays for importing the route

test("a preview sends only the path", async () => {
  await post({ action: "preview", path: "D:\\Downloads", exclude: ["a"] });
  expect(sent()).toEqual({ pathname: "/v1/sources/folders/preview", method: "POST", body: { path: "D:\\Downloads", names: ["Kai Yan"] } });
});

test("changing the exclusions goes to the folder's own route", async () => {
  await post({ action: "exclusions", id: "f1", exclude: ["old/**"], include: [] });
  expect(sent()).toEqual({ pathname: "/v1/sources/folders/f1/exclusions", method: "POST", body: { exclude: ["old/**"], include: [], names: ["Kai Yan"] } });
  expect((await post({ action: "exclusions", id: "../x", exclude: [], include: [] })).status).toBe(400);
});

test("revoking keeps what was read unless purge is asked for", async () => {
  const { DELETE } = await import("./route");
  await DELETE(new Request("http://127.0.0.1/api/sources/folders?id=f1", { method: "DELETE" }));
  expect(sent().pathname).toBe("/v1/sources/folders/f1");
  supervisor.mockClear();
  await DELETE(new Request("http://127.0.0.1/api/sources/folders?id=f1&purge=1", { method: "DELETE" }));
  expect(sent()).toMatchObject({ pathname: "/v1/sources/folders/f1/purge", method: "DELETE" });
});

test("a forged origin changes nothing", async () => {
  expect((await post({ action: "exclusions", id: "f1", exclude: [], include: [] }, "https://evil.example")).status).toBe(403);
  const { DELETE } = await import("./route");
  expect((await DELETE(new Request("http://127.0.0.1/api/sources/folders?id=f1&purge=1", { method: "DELETE", headers: { origin: "https://evil.example" } }))).status).toBe(403);
  expect(supervisor).not.toHaveBeenCalled();
});
