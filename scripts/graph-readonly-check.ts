/**
 * Gate 2 evidence: prove this machine can read the signed-in user's own calendar and tasks, read-only.
 *
 * Run it yourself — it needs a browser for the device-code step:
 *   pnpm exec tsx scripts/graph-readonly-check.ts
 *
 * It requests only delegated read scopes, never writes, and prints counts and a redacted account
 * name — never event subjects, task titles, or tokens. Writing is a separate gate and stays off.
 */
import { existsSync, statSync } from "node:fs";
import { createGraphAuthSession, graphAuthority, graphCacheConfiguration } from "../packages/connectors/src/index";

// Nothing else in this repo reads .env files, so this script loads its own. Node has this built in;
// no dependency is added for it. Values already in the environment win.
for (const file of [".env.local", ".env"]) {
  if (existsSync(file)) { try { process.loadEnvFile(file); } catch { /* malformed file: fall through */ } }
}

const clientId = process.env.CROSSLINE_MS_CLIENT_ID?.trim();
const tenantId = process.env.CROSSLINE_MS_TENANT_ID?.trim();

const fail = (code: string, message: string): never => {
  console.error(JSON.stringify({ status: "blocked", code, message }));
  process.exit(1);
};

if (!clientId) {
  fail("GRAPH_CLIENT_ID_REQUIRED",
    "设置 CROSSLINE_MS_CLIENT_ID（Entra 应用注册页的“应用程序(客户端) ID”）后重试。");
}
if (!tenantId) {
  fail("GRAPH_TENANT_ID_REQUIRED",
    "单租户注册必须设置 CROSSLINE_MS_TENANT_ID（“目录(租户) ID”）；/common 会被 AADSTS50194 拒绝。");
}

const session = await createGraphAuthSession({ clientId: clientId!, tenantId: tenantId!, access: "read" });
console.info(JSON.stringify({ status: "authority", authority: graphAuthority(tenantId) }));

let token = await session.getAccessToken();
if (!token) {
  await session.loginWithDeviceCode((info) => {
    console.info(JSON.stringify({ status: "device_code", verificationUri: info.verificationUri, userCode: info.userCode }));
  });
  token = await session.getAccessToken();
}
if (!token) fail("GRAPH_LOGIN_FAILED", "登录未完成；没有获得访问令牌。");

const read = async (label: string, url: string) => {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    // The two answers that mean "your tenant has not consented", not "the code is wrong".
    const hint = response.status === 403 ? "租户可能要求管理员同意此应用。"
      : response.status === 401 ? "令牌被拒绝；请重新登录。" : "";
    return { label, ok: false, status: response.status, hint };
  }
  const body = await response.json() as { value?: unknown[] };
  // Counts only: no subjects, no titles, nothing about what the items say.
  return { label, ok: true, status: response.status, count: Array.isArray(body.value) ? body.value.length : 0 };
};

const results = [
  await read("calendarView", "https://graph.microsoft.com/v1.0/me/events?$top=5&$select=id"),
  await read("todoLists", "https://graph.microsoft.com/v1.0/me/todo/lists?$top=5&$select=id")
];
console.info(JSON.stringify({ status: "read_only_check", results }, null, 1));

// Whether the sign-in actually stuck, checked here rather than discovered days later.
//
// The token cache is written asynchronously, and this script used to end on `process.exit()`, which
// kills pending I/O — so every run left a zero-byte cache and demanded a new device code, and the
// resident worker could never sync unattended. `process.exitCode` lets the write finish.
const cachePath = graphCacheConfiguration().cachePath;
const cached = existsSync(cachePath) ? statSync(cachePath).size : 0;
console.info(JSON.stringify({
  status: "token_cache",
  persisted: cached > 0,
  bytes: cached,
  message: cached > 0
    ? "登录已保存；下次运行和后台 worker 都不需要再扫码。"
    : "登录没有保存下来：下次仍需扫码，后台同步也无法自行运行。"
}));
process.exitCode = results.every((result) => result.ok) && cached > 0 ? 0 : 1;
