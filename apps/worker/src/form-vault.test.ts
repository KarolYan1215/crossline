import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computerAskDue, type FormFillAnswer, type Opportunity, type StoredFormRun } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";
import { CrosslineStore, applicationProfile, readFormRuns, recordSensitiveSlot } from "@crossline/db";
import { listenForBrowser } from "./browser-port";
import { createFormService } from "./form-service";
import { moveSensitiveToComputer, profileValues, saveSlotOnComputer, removeSlotOnComputer, type VaultLink } from "./form-profile";
import { createNodeBrowsers, findBrowser, redactHeld, vaultHash, type NodeVault } from "./node/browser";
import type { NodeBrowserLink } from "./node/hub";

/**
 * The sensitive profile items of an account whose forms open on its own computer live only in that computer's secret store
 * (docs/plans/harness-1125.md §9.3); a run queued for a sleeping computer waits and, two days before the deadline, pushes once (§9.4).
 */
const PHONE = "+1 608 555 0123";
let store: CrosslineStore;
let ws = "";
let dir = "";
const server = new Map<string, string>();
const serverStore: SecretStore = { read: async (w, name) => server.get(`${w}/${name}`), write: async (w, name, value) => { server.set(`${w}/${name}`, value); },
  remove: (w, name) => { server.delete(`${w}/${name}`); } };
const memoryVault = (): NodeVault & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return { files, read: async (name) => files.get(name), write: async (name, value) => { files.set(name, value); }, remove: (name) => { files.delete(name); } };
};
/** The person's computer as the hub would reach it: the operations straight into the node's own handler. */
const computer = (vault: NodeVault | undefined, extra: { executable?: string; allow?: (url: string) => Promise<boolean> } = {}): NodeBrowserLink & { calls: Array<Record<string, unknown>>; closeAll: () => Promise<void> } => {
  const browsers = createNodeBrowsers({ profilesDir: path.join(dir, "node-profiles"), ...(vault ? { vault } : {}), ...(extra.executable ? { executable: extra.executable } : {}),
    ...(extra.allow ? { allow: extra.allow } : {}),
    launch: async (profileDir, executable) => (await import("playwright-core")).chromium.launchPersistentContext(profileDir, { executablePath: executable, headless: true }) });
  const calls: Array<Record<string, unknown>> = [];
  return { host: "kai-pc", vault: browsers.vault, calls, closeAll: browsers.closeAll, call: async (request) => { calls.push(request); return browsers.handle(request as never); } };
};
const logged: Array<Record<string, unknown>> = [];
const log = (event: Record<string, unknown>) => { logged.push(event); };

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  dir = mkdtempSync(path.join(tmpdir(), "crossline-vault-"));
  server.clear();
  logged.length = 0;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The state before the decision: the server held the value, the ledger said held. */
const legacyPhone = () => { server.set(`${ws}/apply-phone`, PHONE); recordSensitiveSlot(store, ws, "phone", true); };

describe("moving the server's copies to the computer", () => {
  it("moves each held item, verifies it by the computer's hash, and only then deletes the server's copy", async () => {
    legacyPhone();
    const vault = memoryVault();
    const link = computer(vault);
    const result = await moveSensitiveToComputer(store, serverStore, ws, link, log);
    expect(result).toEqual({ moved: ["phone"], kept: [] });
    expect(vault.files.get("apply-phone")).toBe(PHONE);
    expect(server.has(`${ws}/apply-phone`)).toBe(false);
    // The ledger still says held; the move is recorded on the profile's own event, with the computer and never the value.
    expect(applicationProfile(store, ws).find((item) => item.slot === "phone")).toMatchObject({ present: true });
    expect(store.listEvents(ws, { type: "apply.profile.saved" }).some((event) => (event.payload as { movedToComputer?: string }).movedToComputer === "kai-pc")).toBe(true);
    expect(JSON.stringify(store.exportSnapshot(ws))).not.toContain("555");
    expect(JSON.stringify(logged)).not.toContain("555");
    expect(logged).toContainEqual(expect.objectContaining({ event: "apply.sensitive.moved", slot: "phone" }));
  });

  it("keeps the server's copy when the computer's hash does not match, when it fails, or when it cannot hold items", async () => {
    legacyPhone();
    const wrong: VaultLink = { host: "kai-pc", vault: true, call: async () => ({ sha256: vaultHash("+1 608 555 9999") }) };
    expect(await moveSensitiveToComputer(store, serverStore, ws, wrong, log)).toEqual({ moved: [], kept: ["phone"] });
    const failing: VaultLink = { host: "kai-pc", vault: true, call: async () => { throw new Error("NODE_DISCONNECTED"); } };
    expect(await moveSensitiveToComputer(store, serverStore, ws, failing, log)).toEqual({ moved: [], kept: ["phone"] });
    // A store that reads back something else than was written.
    const lossy = memoryVault();
    lossy.read = async () => "+1 608 555 01";
    expect(await moveSensitiveToComputer(store, serverStore, ws, computer(lossy), log)).toEqual({ moved: [], kept: ["phone"] });
    // A computer too old to hold them is never asked.
    const old = computer(undefined);
    expect(await moveSensitiveToComputer(store, serverStore, ws, old, log)).toEqual({ moved: [], kept: [] });
    expect(old.calls).toEqual([]);
    expect(server.get(`${ws}/apply-phone`)).toBe(PHONE);
    expect(JSON.stringify(logged)).not.toContain("555");
    expect(logged.filter((event) => event.event === "apply.sensitive.move_failed")).toHaveLength(3);
  });

  it("the form service moves them on its pass once the account's computer is connected, and never sends a value to the run", async () => {
    legacyPhone();
    const vault = memoryVault();
    let link: NodeBrowserLink | undefined;
    const forms = createFormService({ store, secrets: serverStore, cwd: dir, dataDir: dir, client: () => undefined, owner: () => ws, screen: false,
      nodeAccount: () => true, nodeBrowser: () => link, log });
    await forms.pass(ws);
    expect(server.get(`${ws}/apply-phone`)).toBe(PHONE);
    link = computer(vault);
    await forms.pass(ws);
    expect(server.has(`${ws}/apply-phone`)).toBe(false);
    expect(vault.files.get("apply-phone")).toBe(PHONE);
    // What a run on that computer gets for a sensitive slot is its placeholder, typed there.
    expect(await profileValues(store, serverStore, ws, "computer").get("phone")).toBe("{{profile.phone}}");
    expect(await profileValues(store, serverStore, ws, "nowhere").get("phone")).toBeUndefined();
  });
});

describe("saving and removing on the computer", () => {
  it("refuses without a computer, saves there with a matching hash, and keeps nothing on the server", async () => {
    expect(await saveSlotOnComputer(store, serverStore, ws, "phone", PHONE, "settings", undefined)).toEqual({ ok: false, code: "SENSITIVE_NEEDS_COMPUTER" });
    expect(await saveSlotOnComputer(store, serverStore, ws, "phone", PHONE, "settings", computer(undefined))).toEqual({ ok: false, code: "SENSITIVE_NEEDS_COMPUTER" });
    expect(applicationProfile(store, ws).find((item) => item.slot === "phone")?.present).toBe(false);
    const wrong: VaultLink = { host: "kai-pc", vault: true, call: async () => ({ sha256: "0".repeat(64) }) };
    expect(await saveSlotOnComputer(store, serverStore, ws, "phone", PHONE, "settings", wrong)).toEqual({ ok: false, code: "SENSITIVE_VERIFY_FAILED" });
    expect(applicationProfile(store, ws).find((item) => item.slot === "phone")?.present).toBe(false);
    const vault = memoryVault();
    const link = computer(vault);
    expect(await saveSlotOnComputer(store, serverStore, ws, "phone", ` ${PHONE} `, "settings", link)).toEqual({ ok: true });
    expect(vault.files.get("apply-phone")).toBe(PHONE);
    expect(server.size).toBe(0);
    expect(applicationProfile(store, ws).find((item) => item.slot === "phone")?.present).toBe(true);
    // A plain item is still a confirmed fact in the ledger.
    expect(await saveSlotOnComputer(store, serverStore, ws, "email", "kai@example.edu", "settings", undefined)).toEqual({ ok: true });
    // Removing needs the computer too; then the record goes.
    expect(await removeSlotOnComputer(store, serverStore, ws, "phone", undefined)).toEqual({ ok: false, code: "SENSITIVE_NEEDS_COMPUTER" });
    expect(await removeSlotOnComputer(store, serverStore, ws, "phone", link)).toEqual({ ok: true });
    expect(vault.files.has("apply-phone")).toBe(false);
    expect(applicationProfile(store, ws).find((item) => item.slot === "phone")?.present).toBe(false);
  });

  it("the hosted worker's route sends a node account's sensitive item to its computer, never to its own store", async () => {
    const vault = memoryVault();
    let link: NodeBrowserLink | undefined;
    const forms = createFormService({ store, secrets: serverStore, cwd: dir, dataDir: dir, client: () => undefined, owner: () => "owner", screen: false,
      nodeAccount: () => true, nodeBrowser: () => link });
    expect(await forms.handle("POST", "/v1/apply-profile/phone", ws, { value: PHONE })).toMatchObject({ status: 409, body: { code: "SENSITIVE_NEEDS_COMPUTER" } });
    link = computer(vault);
    expect(await forms.handle("POST", "/v1/apply-profile/phone", ws, { value: PHONE })).toMatchObject({ status: 200 });
    expect(await forms.handle("POST", "/v1/apply-profile/phone", ws, { value: "x" })).toMatchObject({ status: 400 });
    expect(server.size).toBe(0);
    expect(vault.files.get("apply-phone")).toBe(PHONE);
  });

  it("the computer refuses a bad slot name, and never echoes a value back", async () => {
    const link = computer(memoryVault());
    await expect(link.call({ op: "vaultPut", slot: "../token", value: PHONE })).rejects.toThrow("NODE_VAULT_SLOT_INVALID");
    const answer = await link.call({ op: "vaultPut", slot: "phone", value: PHONE });
    expect(answer).toEqual({ sha256: vaultHash(PHONE) });
    await expect(computer(undefined).call({ op: "vaultPut", slot: "phone", value: PHONE })).rejects.toThrow("NODE_VAULT_MISSING");
  });

  it("what the computer sends back carries placeholders for held values, the phone's reformatted digits too", () => {
    const held = new Map([["phone", PHONE], ["passport_number", "E12345678"]]);
    const answer = redactHeld({ value: `- textbox "Phone": +1 (608) 555-0123\n- textbox "Passport": E12345678`, url: "https://x.example/?p=16085550123", blocked: [] }, held);
    expect(answer.value).toBe(`- textbox "Phone": +{{profile.phone}}\n- textbox "Passport": {{profile.passport_number}}`);
    expect(answer.url).toBe("https://x.example/?p={{profile.phone}}");
    expect(JSON.stringify(answer)).not.toMatch(/555|12345678/);
  });
});

describe("a run queued for a sleeping computer", () => {
  const opportunity = (deadlines: string[]): Opportunity => ({ id: `opp-${deadlines.join("-") || "none"}`, key: "k", lineId: "startup", kind: "event", title: "AI Night",
    organizer: "Madison AI", url: "https://lu.ma/ai-night", registrationHost: "lu.ma", deadlines: deadlines.map((day) => ({ day, quote: day })),
    cost: { amount: 0, currency: "USD", quote: "Free" }, eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z" } as Opportunity);
  const run = (deadlines: string[], extra: Partial<StoredFormRun> = {}) => ({ state: "queued", opportunity: opportunity(deadlines), ...extra }) as StoredFormRun;

  it("is worth one push only while queued, not asked yet, with the earliest deadline ahead starting within 48 hours", () => {
    const now = new Date("2026-12-08T18:00:00Z");
    expect(computerAskDue(run(["2026-12-10"]), now)).toBe(true);
    expect(computerAskDue(run(["2026-12-11"]), now)).toBe(false);
    expect(computerAskDue(run(["2026-12-01", "2026-12-09"]), now)).toBe(true);
    expect(computerAskDue(run(["2026-12-01"]), now)).toBe(false);
    expect(computerAskDue(run([]), now)).toBe(false);
    expect(computerAskDue(run(["2026-12-10"], { computerAskedAt: "2026-12-08T00:00:00Z" }), now)).toBe(false);
    expect(computerAskDue(run(["2026-12-10"], { state: "waiting_person" }), now)).toBe(false);
  });

  it("queues while the account's computer is offline, pushes once two days before the deadline, and starts nothing meanwhile", async () => {
    const forms = createFormService({ store, secrets: serverStore, cwd: dir, dataDir: dir, client: () => undefined, owner: () => "owner", screen: false,
      nodeAccount: () => true, nodeBrowser: () => undefined });
    expect(await forms.handle("POST", "/v1/forms/queue", ws, { opportunity: opportunity(["2026-12-10"]), choice: "register" })).toMatchObject({ status: 200 });
    expect(await forms.handle("POST", "/v1/forms/queue", ws, { opportunity: opportunity([]), choice: "register" })).toMatchObject({ status: 200 });
    const said = (day: string) => store.listConversationMessages(ws, store.conversationFor(ws, day).id)
      .filter((message) => message.role === "nudge" && (message.payload as { nudge?: { kind?: string } }).nudge?.kind === "form_computer");
    await forms.pass(ws, new Date("2026-12-07T18:00:00Z"));
    expect(said("2026-12-07")).toHaveLength(0);
    await forms.pass(ws, new Date("2026-12-08T18:00:00Z"));
    await forms.pass(ws, new Date("2026-12-08T18:30:00Z"));
    expect(said("2026-12-08")).toHaveLength(1);
    expect(readFormRuns(store, ws).filter((item) => item.computerAskedAt)).toHaveLength(1);
    expect(readFormRuns(store, ws).every((item) => item.state === "queued")).toBe(true);
  });

  it("an account with no computer anywhere is still refused", async () => {
    const forms = createFormService({ store, secrets: serverStore, cwd: dir, dataDir: dir, client: () => undefined, owner: () => ws, screen: false, nodeBrowser: () => undefined });
    expect(await forms.handle("POST", "/v1/forms/queue", ws, { opportunity: opportunity([]), choice: "register" })).toMatchObject({ status: 409, body: { code: "FORM_NEEDS_SCREEN" } });
  });
});

const chrome = findBrowser();
describe.skipIf(!chrome)("a form on the person's computer", () => {
  let page: Server;
  let base = "";
  let body = "";
  beforeAll(async () => {
    page = createServer((request, response) => {
      let data = "";
      request.on("data", (chunk) => { data += String(chunk); });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (request.url === "/done") { body = decodeURIComponent(data.replace(/\+/g, " ")); return response.end(`<h1>You're registered!</h1>`); }
        response.end(`<h1>AI Night</h1><form method="post" action="/done"><label>Phone <input name="phone"></label><button type="submit">Register</button></form>`);
      });
    });
    base = `http://127.0.0.1:${await listenForBrowser(page)}`;
  });
  afterAll(() => new Promise<void>((resolve) => page.close(() => resolve())));

  it("types the value it holds for the placeholder, and the server sees only the placeholder", async () => {
    const vault = memoryVault();
    vault.files.set("apply-phone", PHONE);
    recordSensitiveSlot(store, ws, "phone", true);
    const link = computer(vault, { executable: chrome!, allow: async () => true });
    const seen: string[] = [];
    const forms = createFormService({ store, secrets: serverStore, cwd: dir, dataDir: dir, client: () => undefined, owner: () => "owner", screen: false,
      nodeAccount: () => true, nodeBrowser: () => link, profilesRoot: () => path.join(dir, "profiles"),
      models: () => ({
        propose: async (context): Promise<FormFillAnswer> => { seen.push(JSON.stringify(context)); return { pageKind: "form", note: "", actions: [
          { op: "fill", target: { role: "textbox", name: "Phone" }, value: { slot: "phone" }, why: "" },
          { op: "submit", target: { role: "button", name: "Register" }, value: null, why: "" }] }; },
        check: async (context) => { seen.push(JSON.stringify(context)); return { ok: true, problems: [] }; }
      }) });
    const opportunity = { id: "opp-1", key: "k", lineId: "startup", kind: "event", title: "AI Night", organizer: "Madison AI", url: `${base}/event`,
      registrationHost: "127.0.0.1", deadlines: [], cost: { amount: 0, currency: "USD", quote: "Free" }, eligibility: [], needsAccount: false, materials: [],
      consents: [], foundVia: "web", foundAt: "2026-11-01T00:00:00Z" } as unknown as Opportunity;
    expect(await forms.handle("POST", "/v1/forms/queue", ws, { opportunity, choice: "register" })).toMatchObject({ status: 200 });
    const end = Date.now() + 60_000;
    while (readFormRuns(store, ws)[0]?.state !== "ready_to_submit" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 200));
    const run = readFormRuns(store, ws)[0]!;
    expect(run).toMatchObject({ state: "ready_to_submit" });
    expect(run.filled).toContainEqual(expect.objectContaining({ slot: "phone", verified: true }));
    // The value went from the computer's own store into the page; nothing the server received, kept or showed a model carries it.
    expect(link.calls.find((call) => call.op === "formOpen")).toMatchObject({ vault: ["phone"] });
    expect(JSON.stringify(link.calls)).not.toContain("555");
    expect(JSON.stringify(seen)).not.toContain("555");
    expect(JSON.stringify(store.exportSnapshot(ws))).not.toContain("555");
    expect(body).toBe("");
    await forms.closeAll();
    await link.closeAll();
  }, 90_000);
});
