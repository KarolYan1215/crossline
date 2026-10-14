import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CHATGPT_ISSUER, loopbackRedirect, verifyIdToken } from "./chatgpt";
import { createCrosslineAuth, migrateCrosslineAuth, type CrosslineAuthOptions } from "./index";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const idToken = (claims: Record<string, unknown>) => {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
};
/** OpenAI's discovery, keys and token endpoint, answered here. */
const openai = (token: () => string, posted: URLSearchParams[] = []): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ jwks_uri: `${CHATGPT_ISSUER}/jwks` });
  if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
  if (url.endsWith("/api/accounts/oauth/token")) { posted.push(new URLSearchParams(String(init?.body))); return Response.json({ id_token: token() }); }
  return new Response("", { status: 404 });
}) as typeof fetch;

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "crossline-chatgpt-")); });
// Better Auth keeps its SQLite handle with no way to close it, and Windows refuses to delete an open file: best effort, the OS temp dir is swept anyway.
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on Windows */ } });

test("an ID token is accepted only when OpenAI signed it for this install, now, for this attempt", async () => {
  const good = { iss: CHATGPT_ISSUER, aud: "oaiapp_1", sub: "user-1", email: "a@example.com", nonce: "n", exp: Math.floor(Date.now() / 1000) + 300 };
  expect((await verifyIdToken(idToken(good), { audience: "oaiapp_1", nonce: "n" }, openai(() => ""))).sub).toBe("user-1");
  for (const [claims, code] of [[{ ...good, aud: "oaiapp_other" }, "AUDIENCE"], [{ ...good, iss: "https://evil.example" }, "ISSUER"],
    [{ ...good, nonce: "replayed" }, "NONCE"], [{ ...good, exp: 1 }, "EXPIRED"]] as const)
    await expect(verifyIdToken(idToken(claims), { audience: "oaiapp_1", nonce: "n" }, openai(() => ""))).rejects.toThrow(code);
  const forged = idToken(good).split(".").slice(0, 2).join(".") + ".AAAA";
  await expect(verifyIdToken(forged, { audience: "oaiapp_1", nonce: "n" }, openai(() => ""))).rejects.toThrow("SIGNATURE");
});

test("the callback is the machine's own loopback address; a hosted site cannot use this flow", () => {
  expect(loopbackRedirect("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210/auth/callback");
  expect(loopbackRedirect("http://localhost:3210")).toBe("http://127.0.0.1:3210/auth/callback");
  expect(loopbackRedirect("https://crossline.example.com")).toBeUndefined();
});

test("first sign-in registers this install, keeps the issued id, and signs the person in", async () => {
  const installFile = path.join(dir, "chatgpt-signin.json");
  let nonce = "";
  const posted: URLSearchParams[] = [];
  const options: CrosslineAuthOptions = { authDbPath: path.join(dir, "auth.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
    trustedOrigins: ["http://127.0.0.1:3210"], chatgpt: { installFile,
      fetch: openai(() => idToken({ iss: CHATGPT_ISSUER, aud: "oaiapp_issued", sub: "acct-1", email: "me@example.com", email_verified: true, name: "Me", nonce,
        exp: Math.floor(Date.now() / 1000) + 300 }), posted) } };
  await migrateCrosslineAuth(options);
  const auth = createCrosslineAuth(options);
  const start = await auth.handler(new Request("http://127.0.0.1:3210/api/auth/chatgpt/start"));
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  // The registration name is the app-server's clientInfo.name, so plan usage is attributed to the same app.
  expect(authorize.searchParams.get("agent_name_hint")).toBe("crossline");
  expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3210/auth/callback");
  expect(authorize.searchParams.get("scope")).toBe("openid profile email");
  nonce = authorize.searchParams.get("nonce")!;
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await auth.handler(new Request(`http://127.0.0.1:3210/api/auth/chatgpt/callback?code=c1&state=${authorize.searchParams.get("state")}&client_id=oaiapp_issued`,
    { headers: { cookie } }));
  expect(callback.headers.get("location")).toBe("/");
  expect(callback.headers.get("set-cookie")).toContain("session_token");
  expect(posted[0]?.get("client_id")).toBe("oaiapp_issued");
  expect(posted[0]?.get("code_verifier")).toBeTruthy();
  expect(JSON.parse(readFileSync(installFile, "utf8")).clientId).toBe("oaiapp_issued");
  // Signing in again uses the issued id and still names this host; the registration name is not sent again.
  const again = new URL((await auth.handler(new Request("http://127.0.0.1:3210/api/auth/chatgpt/start"))).headers.get("location")!);
  expect(again.searchParams.get("client_id")).toBe("oaiapp_issued");
  expect(again.searchParams.get("ext_agent_host_id")).toBe(authorize.searchParams.get("ext_agent_host_id"));
  expect(again.searchParams.has("agent_name_hint")).toBe(false);
  // A forged state is refused before any token is asked for.
  const forged = await auth.handler(new Request("http://127.0.0.1:3210/api/auth/chatgpt/callback?code=c2&state=other", { headers: { cookie } }));
  expect(forged.headers.get("location")).toBe("/login?error=CHATGPT_STATE_MISMATCH");
}, 30_000);

/** One ChatGPT sign-in against an auth that also has an email account, returning where the callback sent the browser. */
async function chatgptSignIn(local: CrosslineAuthOptions, nonceOf: { value: string }) {
  const auth = createCrosslineAuth(local);
  const start = await auth.handler(new Request("http://127.0.0.1:3210/api/auth/chatgpt/start"));
  const authorize = new URL(start.headers.get("location")!);
  nonceOf.value = authorize.searchParams.get("nonce")!;
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await auth.handler(new Request(`http://127.0.0.1:3210/api/auth/chatgpt/callback?code=c1&state=${authorize.searchParams.get("state")}&client_id=oaiapp_issued`,
    { headers: { cookie } }));
  return callback;
}

test("a ChatGPT sign-in joins the account that already has its email only when both sides verified the address", async () => {
  const { readdirSync, readFileSync: read } = await import("node:fs");
  const Database = (await import("better-sqlite3")).default;
  const mailbox = path.join(dir, "mailbox");
  const nonce = { value: "" };
  let verified: unknown = true;
  const local = { authDbPath: path.join(dir, "link.db"), secret: "s".repeat(40), baseURL: "http://127.0.0.1:3210",
    trustedOrigins: ["http://127.0.0.1:3210"], testMailboxDir: mailbox, chatgpt: { installFile: path.join(dir, "link.json"),
      fetch: openai(() => idToken({ iss: CHATGPT_ISSUER, aud: "oaiapp_issued", sub: "acct-9", email: "owner@example.com", email_verified: verified,
        nonce: nonce.value, exp: Math.floor(Date.now() / 1000) + 300 })) } };
  await migrateCrosslineAuth(local);
  // The owner's account, made with an email code: its address is verified.
  const auth = createCrosslineAuth(local) as unknown as { api: Record<string, (input: unknown) => Promise<unknown>> };
  await auth.api.sendVerificationOTP!({ body: { email: "owner@example.com", type: "sign-in" } });
  const otp = /\d{6}/.exec((JSON.parse(read(path.join(mailbox, readdirSync(mailbox)[0]!), "utf8")) as { url: string }).url)![0];
  const owner = await auth.api.signInEmailOTP!({ body: { email: "owner@example.com", otp } }) as { user: { id: string } };
  const db = new Database(local.authDbPath);
  const accountsOf = () => db.prepare("SELECT providerId FROM account WHERE userId = ? ORDER BY providerId").all(owner.user.id);

  // OpenAI did not say it verified the address: refused, nothing linked.
  verified = undefined;
  expect((await chatgptSignIn(local, nonce)).headers.get("location")).toContain("/login?error=account_not_linked");
  expect(accountsOf()).toEqual([]);

  // Verified on both sides: the same person, now able to sign in either way.
  verified = true;
  const joined = await chatgptSignIn(local, nonce);
  expect(joined.headers.get("location")).toBe("/");
  expect(accountsOf()).toEqual([{ providerId: "chatgpt" }]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM user").get()).toEqual({ n: 1 });
  db.close();
}, 30_000);
