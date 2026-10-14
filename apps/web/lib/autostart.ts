import "server-only";
import { execFile } from "node:child_process";
import path from "node:path";
import { isLocalInstall } from "./install-mode";

/**
 * Starting with Windows, on an installed copy (docs/local-installer.md): off until the person turns it on in Settings → 通用. It is
 * the same per-user Run entry the tray's 「开机时启动」 menu item writes, so the two always agree, and the uninstaller removes it.
 * No administrator rights: HKCU only.
 */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "Crossline";
type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const run: Exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true }, (error, stdout) =>
    resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, stdout: String(stdout) }));
});

/** The tray program the Run entry starts, from the app folder the launcher names. */
export function trayCommand(env: Record<string, string | undefined> = process.env): string | undefined {
  const app = env.CROSSLINE_APP_DIR?.trim();
  return app ? `"${path.win32.join(app, "Crossline.exe")}" --background` : undefined;
}

export function autostartAvailable(env: Record<string, string | undefined> = process.env, platform = process.platform): boolean {
  return platform === "win32" && isLocalInstall() && Boolean(trayCommand(env));
}

export async function readAutostart(exec: Exec = run): Promise<boolean> {
  return (await exec("reg.exe", ["query", RUN_KEY, "/v", VALUE])).code === 0;
}

export async function setAutostart(on: boolean, env: Record<string, string | undefined> = process.env, exec: Exec = run): Promise<boolean> {
  const command = trayCommand(env);
  if (!command) return false;
  const result = on
    ? await exec("reg.exe", ["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", command, "/f"])
    : await exec("reg.exe", ["delete", RUN_KEY, "/v", VALUE, "/f"]);
  // Deleting a value that is not there answers 1; the state asked for is what counts.
  return result.code === 0 || (!on && !(await readAutostart(exec)));
}
