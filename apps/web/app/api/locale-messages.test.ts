import { expect, test, vi } from "vitest";
import { TEST_CTX } from "../../lib/test-support";

/** Messages a route writes for the person follow the request's language (docs/i18n.md); codes stay codes. */
vi.mock("server-only", () => ({}));
vi.mock("../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: { ...TEST_CTX, locale: "en" } }) }));
vi.mock("../../lib/codex-runtime", () => ({ requestCodexSupervisor: vi.fn(),
  CodexSupervisorRequestError: class extends Error { status = 503; blocker = { code: "X", message: "x" }; } }));

const post = (route: { POST: (request: Request) => Promise<Response> }, path: string, body: unknown) => route.POST(new Request(`http://127.0.0.1:3210${path}`, {
  method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3210", host: "127.0.0.1:3210" }, body: JSON.stringify(body) }));

test("an empty API key is refused in English, with its code unchanged", async () => {
  const response = await post(await import("./codex/account/route"), "/api/codex/account", { type: "apiKey", apiKey: "" });
  expect(await response.json()).toEqual({ blocker: { code: "API_KEY_INVALID", message: "Enter an API key" } });
});

test("a calendar link left empty is asked for in English", async () => {
  const response = await post(await import("./calendar/subscriptions/route"), "/api/calendar/subscriptions", { link: " " });
  expect(await response.json()).toMatchObject({ code: "ICAL_LINK_INVALID", message: "Paste the calendar link first." });
});
