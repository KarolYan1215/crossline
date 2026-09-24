"use client";
import { authClient } from "./auth-client";
import { clearOfflineData, currentWorkspaceId } from "./offline-queue";

/**
 * Clears this browser's offline Dexie database and remembered workspace/device id before signing out —
 * the next person to use this browser must start from nothing, not read the previous account's queued
 * captures and in-flight work-order actions. Order matters: the workspace id has to be read *before*
 * `signOut()` clears the session, since nothing server-side can tell this browser which workspace it
 * was using afterward.
 */
export function SignOutButton() {
  const handleClick = async () => {
    const workspaceId = currentWorkspaceId();
    if (workspaceId) await clearOfflineData(workspaceId).catch(() => undefined);
    await authClient.signOut();
    location.href = "/login";
  };
  return <button type="button" className="sign-out-button" onClick={() => { void handleClick(); }}>退出登录</button>;
}
