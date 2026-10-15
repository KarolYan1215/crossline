import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { readAutostart, setAutostart, trayCommand } = await import("./autostart");

/** The Run entry is written and removed with reg.exe against HKCU only, and names the installed tray, quoted. */
test("turning it on writes the tray under HKCU Run, off removes it, and a missing app folder writes nothing", async () => {
  const calls: string[][] = [];
  let present = false;
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === "add") present = true;
    if (args[0] === "delete") { const had = present; present = false; return { code: had ? 0 : 1, stdout: "" }; }
    return { code: args[0] === "query" && !present ? 1 : 0, stdout: "" };
  };
  const env = { CROSSLINE_APP_DIR: "C:\\Users\\t\\AppData\\Local\\Crossline\\app" };
  expect(trayCommand(env)).toBe('"C:\\Users\\t\\AppData\\Local\\Crossline\\app\\Crossline.exe" --background');
  expect(await setAutostart(true, env, exec)).toBe(true);
  expect(calls[0]).toEqual(["reg.exe", "add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Crossline", "/t", "REG_SZ", "/d",
    '"C:\\Users\\t\\AppData\\Local\\Crossline\\app\\Crossline.exe" --background', "/f"]);
  expect(await readAutostart(exec)).toBe(true);
  expect(await setAutostart(false, env, exec)).toBe(true);
  expect(await readAutostart(exec)).toBe(false);
  // Already off: still reported as done.
  expect(await setAutostart(false, env, exec)).toBe(true);
  const before = calls.length;
  expect(await setAutostart(true, {}, exec)).toBe(false);
  expect(calls.length).toBe(before);
  expect(calls.every((call) => call[2]?.startsWith("HKCU\\"))).toBe(true);
});
