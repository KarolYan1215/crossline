import "server-only";
import { VOICE_SETTING, readVoicePreferences, type AccessContext, type VoicePreferences } from "@crossline/core";
import { requestCodexSupervisor } from "./codex-runtime";
import { getStore } from "./crossline";

/**
 * Voice input's settings and the state of Crossline's own engine (docs/voice-input.md), as every page's microphone reads them once:
 * whether the microphone is shown, the language, whether the text is corrected, and whether the server engine can take a clip — `ready`,
 * `model_missing` (an installed copy, before its download), `downloading` or `unavailable`.
 */
export type VoiceServer = "ready" | "model_missing" | "downloading" | "unavailable";
export type VoiceStatus = { preferences: VoicePreferences; server: VoiceServer; mode: "server" | "local"; modelBytes: number };

export function voicePreferences(ctx: AccessContext): VoicePreferences {
  return readVoicePreferences(getStore().getSetting(ctx.workspaceId, VOICE_SETTING));
}

export function saveVoicePreferences(ctx: AccessContext, patch: Partial<VoicePreferences>): VoicePreferences {
  const next = { ...voicePreferences(ctx), ...patch };
  getStore().setSetting(ctx.workspaceId, VOICE_SETTING, JSON.stringify(next));
  return readVoicePreferences(JSON.stringify(next));
}

export async function voiceStatus(ctx: AccessContext): Promise<VoiceStatus> {
  const preferences = voicePreferences(ctx);
  const engine = await requestCodexSupervisor<{ server?: VoiceServer; mode?: "server" | "local"; modelBytes?: number }>(ctx, "/v1/voice/status",
    { method: "GET", signal: AbortSignal.timeout(4_000) }).catch(() => undefined);
  return { preferences, server: engine?.server ?? "unavailable", mode: engine?.mode ?? (process.env.CROSSLINE_PUBLIC_BETA === "1" ? "server" : "local"),
    modelBytes: engine?.modelBytes ?? 240_000_000 };
}
