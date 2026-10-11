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
      fetch: openai(() => idToken({ iss: CHATGPT_ISSUER, aud: "oaiapp_issued", sub: "acct-1", email: "me@example.com", name: "Me", nonce,
        exp: Math.floor(Date.now() / 1000) + 300 }), posted) } };
  await migrateCrosslineAuth(options);
  const auth = createCrosslineAuth(options);
  const start = await auth.handler(new Request("http://127.0.0.1:3210/api/auth/chatgpt/start"));
  const authorize = new URL(start.headers.get("location")!);
  expect(authorize.origin + authorize.pathname).toBe(`${CHATGPT_ISSUER}/api/accounts/authorize`);
  expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
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
  // A forged state is refused before any token is asked for.
  const forged = await auth.handler(new Request("http://127.0.0.1:3210/api/auth/chatgpt/callback?code=c2&state=other", { headers: { cookie } }));
  expect(forged.headers.get("location")).toBe("/login?error=CHATGPT_STATE_MISMATCH");
}, 30_000);
