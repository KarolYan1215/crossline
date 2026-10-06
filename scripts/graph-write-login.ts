/**
 * Lets Crossline write to ONE calendar — the one it makes and names 「Crossline」 — in a Microsoft account you choose.
 *
 *   pnpm exec tsx scripts/graph-write-login.ts
 *
 * Runs the device-code login asking for Calendars.ReadWrite (and User.Read), nothing else: no tasks, no shared calendars, no mail.
 * Microsoft cannot limit that permission to a single calendar, so the limit is Crossline's own: it writes only to a calendar named
 * Crossline, only to events it marked as its own, and never to a calendar or event you made. See packages/connectors/src/crossline-calendar.ts.
 *
 * After sign-in the chosen account is stored as `calendar.write.account` in your ledger. Nothing is written to any calendar by this script.
 */
import path from "node:path";
import { createGraphAuthSession, graphAuthority } from "../packages/connectors/src/index.js";
import { CrosslineStore } from "../packages/db/src/index.js";

const clientId = process.env.CROSSLINE_MS_CLIENT_ID?.trim();
if (!clientId) {
  console.error(JSON.stringify({ status: "blocked", code: "GRAPH_CLIENT_ID_REQUIRED", message: "设置 CROSSLINE_MS_CLIENT_ID 后重试（在 .env.local 里）。" }));
  process.exit(1);
}
const tenantId = process.env.CROSSLINE_MS_TENANT_ID?.trim();
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(import.meta.dirname, "..", "data"));
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const workspaces = store.listWorkspaces();
if (workspaces.length !== 1) {
  console.error(JSON.stringify({ status: "blocked", code: "WORKSPACE_AMBIGUOUS", message: "找到的工作区不是恰好一个；设置 CROSSLINE_WORKSPACE_ID。", found: workspaces.length }));
  process.exit(1);
}
const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? workspaces[0]!.id;

console.info(JSON.stringify({ status: "authority", authority: graphAuthority(tenantId), scopes: ["User.Read", "Calendars.ReadWrite"] }));
const session = await createGraphAuthSession({ clientId, ...(tenantId ? { tenantId } : {}), access: "calendar-write" });
const signedIn = await session.loginWithDeviceCode((info) => {
  console.info(JSON.stringify({ status: "device_code", open: info.verificationUri, code: info.userCode,
    message: "在浏览器打开上面的网址，输入这个代码，选你想放 Crossline 日历的账号，核对同意页写的是“读取和写入你的日历”，点接受。" }));
});
const account = (await session.listAccounts()).find((entry) => entry.username.toLowerCase() === signedIn.username.toLowerCase());
if (!account) { console.error(JSON.stringify({ status: "blocked", code: "ACCOUNT_NOT_IN_CACHE" })); process.exit(1); }
store.setSetting(workspaceId, "calendar.write.account", account.id);
console.info(JSON.stringify({ status: "authorized", username: signedIn.username,
  note: "已记下。之后在 Plan 页点「同步到 Crossline 日历」（计划批准后才可点；只有点按钮才会写）。你的其他日历不会被改动。" }));
store.close();
