import type { CrosslineStore } from "@crossline/db";

/**
 * Signing in the account that holds the Crossline calendar, from the app (the calendar card) instead of `scripts/graph-write-login.ts`:
 * the same device-code login with the same scopes (User.Read, Calendars.ReadWrite — `access: "calendar-write"`). The worker asks
 * Microsoft for a code and hands it to the page; the person opens Microsoft's page, types it and signs in themselves. Nothing here
 * signs anyone in. When they have, the account is stored as `calendar.write.account`, exactly as the script does.
 */
export type WriteLoginSession = {
  loginWithDeviceCode(onCode: (info: { userCode: string; verificationUri: string; message: string }) => void): Promise<{ username: string }>;
  listAccounts(): Promise<Array<{ id: string; username: string }>>;
};
export type WriteLoginState =
  | { state: "idle" }
  | { state: "waiting"; userCode: string; verificationUri: string; startedAt: string }
  | { state: "done"; at: string }
  | { state: "failed"; code: string; message: string };

const WRITE_ACCOUNT = "calendar.write.account";
/** Microsoft's own sign-in pages only; anything else is not shown as a link. */
const SAFE_HOSTS = new Set(["microsoft.com", "www.microsoft.com", "login.microsoft.com", "login.microsoftonline.com", "aka.ms"]);
export const safeVerificationUri = (value: string): string | undefined => {
  try { const url = new URL(value); return url.protocol === "https:" && SAFE_HOSTS.has(url.hostname) ? url.toString() : undefined; } catch { return undefined; }
};

export function createWriteLogin(store: CrosslineStore, deps: { session: () => Promise<WriteLoginSession | undefined>; ownerOf: (workspaceId: string) => string;
  now?: () => Date }) {
  const states = new Map<string, WriteLoginState>();
  const now = () => deps.now?.() ?? new Date();
  return {
    status: (workspaceId: string): WriteLoginState => states.get(workspaceId) ?? { state: "idle" },
    /** Starts a login (or returns the one waiting) and answers once Microsoft has given the code. */
    async start(workspaceId: string): Promise<WriteLoginState> {
      const current = states.get(workspaceId);
      if (current?.state === "waiting") return current;
      const session = await deps.session();
      if (!session) return { state: "failed", code: "GRAPH_NOT_CONFIGURED", message: "本机没有配置 Microsoft 日历。" };
      return await new Promise<WriteLoginState>((resolve) => {
        void session.loginWithDeviceCode((info) => {
          const uri = safeVerificationUri(info.verificationUri);
          const waiting: WriteLoginState = uri ? { state: "waiting", userCode: info.userCode, verificationUri: uri, startedAt: now().toISOString() }
            : { state: "failed", code: "LOGIN_URI_UNEXPECTED", message: "登录地址不是微软的页面，已停止。" };
          states.set(workspaceId, waiting);
          resolve(waiting);
        }).then(async (signedIn) => {
          const account = (await session.listAccounts()).find((entry) => entry.username.toLowerCase() === signedIn.username.toLowerCase());
          if (!account) { states.set(workspaceId, { state: "failed", code: "ACCOUNT_NOT_IN_CACHE", message: "登录完成，但没有找到这个账号，请重试。" }); return; }
          store.setSetting(workspaceId, WRITE_ACCOUNT, account.id);
          // Provenance only: that an account was chosen for writing, not which address.
          store.appendEvent({ ownerId: deps.ownerOf(workspaceId), workspaceId, idempotencyKey: `calendar.write.authorized:${Date.now()}`,
            type: "calendar.write.authorized", entityId: workspaceId, payload: { via: "device_code" } });
          states.set(workspaceId, { state: "done", at: now().toISOString() });
        }).catch((error: unknown) => {
          const failed: WriteLoginState = { state: "failed", code: "GRAPH_LOGIN_FAILED",
            message: (error as { errorCode?: string } | undefined)?.errorCode === "expired_token" ? "代码已过期，请重新开始。" : "登录没有完成，请重试。" };
          states.set(workspaceId, failed);
          resolve(failed);
        });
      });
    }
  };
}
