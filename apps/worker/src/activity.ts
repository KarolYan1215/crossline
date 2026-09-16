import { execFile } from "node:child_process";

/**
 * Local activity, sampled through Windows' own APIs so no dependency and no input hook is needed.
 *
 * Two values only: how long since the last input, and an opaque foreground window handle. The handle
 * is a number, never a title — so nothing that could describe what you were reading or writing can
 * reach this process at all. Switch counts come from the handle changing, not from its identity.
 */
export type ActivitySample = { idleMs: number; fgHandle: number };

const SCRIPT = `
$src = @'
using System;
using System.Runtime.InteropServices;
public static class CrosslineIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static uint IdleMs() {
    LASTINPUTINFO l = new LASTINPUTINFO();
    l.cbSize = (uint)Marshal.SizeOf(l);
    GetLastInputInfo(ref l);
    return GetTickCount() - l.dwTime;
  }
  public static long Fg() { return GetForegroundWindow().ToInt64(); }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
@{ idleMs = [CrosslineIdle]::IdleMs(); fgHandle = [CrosslineIdle]::Fg() } | ConvertTo-Json -Compress
`;

export async function sampleLocalActivity(timeoutMs = 10_000): Promise<ActivitySample | undefined> {
  if (process.platform !== "win32") return undefined;
  const raw = await new Promise<string | undefined>((resolve) => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { idleMs?: unknown; fgHandle?: unknown };
    // Anything but two finite numbers means the boundary did not hold; report nothing rather than guess.
    if (!Number.isFinite(parsed.idleMs) || !Number.isFinite(parsed.fgHandle)) return undefined;
    return { idleMs: Number(parsed.idleMs), fgHandle: Number(parsed.fgHandle) };
  } catch { return undefined; }
}

export type ActivityAggregate = { activeMinutes: number; idleMinutes: number; windowSwitches: number };

/** Folds a day's samples into the only three numbers that leave this module. */
export function aggregateSamples(samples: ActivitySample[], intervalMinutes: number, idleThresholdMs = 120_000): ActivityAggregate {
  let activeMinutes = 0;
  let idleMinutes = 0;
  let windowSwitches = 0;
  let previousHandle: number | undefined;
  for (const sample of samples) {
    if (sample.idleMs < idleThresholdMs) activeMinutes += intervalMinutes; else idleMinutes += intervalMinutes;
    if (previousHandle !== undefined && sample.fgHandle !== previousHandle) windowSwitches += 1;
    previousHandle = sample.fgHandle;
  }
  return { activeMinutes, idleMinutes, windowSwitches };
}
