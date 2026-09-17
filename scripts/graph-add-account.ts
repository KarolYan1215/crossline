/**
 * Signs an ADDITIONAL mailbox into the same token cache.
 *
 *   pnpm exec tsx scripts/graph-add-account.ts
 *
 * `graph-readonly-check.ts` cannot do this: it logs in only when there is no token at all, so once the
 * first account is cached it short-circuits and there is no way to add a second. This one always runs
 * the device-code flow, and MSAL appends the result to the cache rather than replacing what is there.
 *
 * A personal Microsoft account (anything @outlook / @hotmail / @live, or a Gmail address registered as
 * one) needs the Entra app registration's supported account types to include personal accounts, and
 * `CROSSLINE_MS_TENANT_ID=common`. A single-tenant registration answers AADSTS50059 at /common and
 * AADSTS700016 at /consumers, and no amount of retrying changes that — it is a portal setting.
 *
 * Read-only: it requests the read scopes, and prints the account list without any calendar contents.
 */
import { createGraphAuthSession, graphAuthority } from "../packages/connectors/src/index.js";

const clientId = process.env.CROSSLINE_MS_CLIENT_ID?.trim();
if (!clientId) {
  console.error(JSON.stringify({ status: "blocked", code: "GRAPH_CLIENT_ID_REQUIRED",
    message: "设置 CROSSLINE_MS_CLIENT_ID 后重试。" }));
  process.exitCode = 1;
} else {
  const tenantId = process.env.CROSSLINE_MS_TENANT_ID?.trim();
  console.info(JSON.stringify({ status: "authority", authority: graphAuthority(tenantId) }));
  const session = await createGraphAuthSession({ clientId, ...(tenantId ? { tenantId } : {}), access: "read" });

  const before = await session.listAccounts();
  console.info(JSON.stringify({ status: "before", accounts: before.map((account) => account.username) }));

  const added = await session.loginWithDeviceCode((info) => {
    console.info(JSON.stringify({ status: "device_code", verificationUri: info.verificationUri, userCode: info.userCode }));
  });
  console.info(JSON.stringify({ status: "signed_in", username: added.username }));

  const after = await session.listAccounts();
  console.info(JSON.stringify({ status: "after", accounts: after.map((account) => account.username) }));
  if (after.length === before.length) {
    console.info(JSON.stringify({ status: "note",
      message: "账号数量没变；你可能登录的是同一个账号。要加另一个账号，在设备码页面选「使用其他账户」。" }));
  } else {
    console.info(JSON.stringify({ status: "note",
      message: "新账号的默认日历会在 worker 下次启动或你打开连接页时自动勾上；其余日历去连接页勾。" }));
  }
}
