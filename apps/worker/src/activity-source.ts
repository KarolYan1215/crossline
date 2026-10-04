import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ActivityReading, ActivitySource } from "@crossline/core";

/**
 * The Windows foreground window, read once a minute by one long-running PowerShell rather than a new process each time.
 *
 * It reports four things and nothing else: how long since the last input, the app's process name, the window's title, and
 * (implicitly) when. No keystrokes, no screen contents, no clipboard. The title is the sensitive one, which is why the
 * tracker applies the private-window rules before anything is stored and why nothing downstream of the store can see it.
 */
const SCRIPT = (seconds: number) => `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CrosslineFg {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint IdleMs() { LASTINPUTINFO l = new LASTINPUTINFO(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return GetTickCount() - l.dwTime; }
  public static IntPtr Fg() { return GetForegroundWindow(); }
  public static string Title(IntPtr h) { StringBuilder s = new StringBuilder(512); GetWindowTextW(h, s, 512); return s.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
while ($true) {
  try {
    $h = [CrosslineFg]::Fg()
    $name = ''
    try { $name = (Get-Process -Id ([CrosslineFg]::Pid($h)) -ErrorAction Stop).ProcessName } catch {}
    @{ idleMs = [int64][CrosslineFg]::IdleMs(); app = $name; title = [CrosslineFg]::Title($h) } | ConvertTo-Json -Compress
  } catch {}
  Start-Sleep -Seconds ${seconds}
}
`;

export function parseReadingLine(line: string, at: Date): ActivityReading | undefined {
  try {
    const parsed = JSON.parse(line) as { idleMs?: unknown; app?: unknown; title?: unknown };
    if (!Number.isFinite(parsed.idleMs) || typeof parsed.app !== "string" || typeof parsed.title !== "string") return undefined;
    return { at: at.toISOString(), idleMs: Number(parsed.idleMs), app: parsed.app.slice(0, 120), title: parsed.title.slice(0, 300) };
  } catch { return undefined; }
}

export function createWindowsActivitySource(options: { intervalSeconds?: number; now?: () => Date } = {}): ActivitySource {
  const seconds = Math.max(5, options.intervalSeconds ?? 60);
  const now = options.now ?? (() => new Date());
  let child: ChildProcessWithoutNullStreams | undefined;
  let stopped = true;
  let restart: NodeJS.Timeout | undefined;

  const launch = (onReading: (reading: ActivityReading) => void) => {
    if (stopped) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(SCRIPT(seconds), "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: child.stdout }).on("line", (line) => { const reading = parseReadingLine(line, now()); if (reading) onReading(reading); });
    child.stderr.on("data", () => { /* PowerShell chatter is not a reading */ });
    // If it dies (the user's PowerShell was killed, a policy change), start it again later rather than going quiet.
    child.on("exit", () => { child = undefined; if (!stopped) restart = setTimeout(() => launch(onReading), 15_000); });
  };

  return {
    id: "windows-foreground",
    start(onReading) {
      if (process.platform !== "win32" || !stopped) return;
      stopped = false;
      launch(onReading);
    },
    stop() {
      stopped = true;
      if (restart) clearTimeout(restart);
      child?.kill();
      child = undefined;
    }
  };
}
