import type { VoiceLanguage } from "@crossline/core";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { saveVoicePreferences } from "../../../../lib/voice";

const LANGUAGES: readonly string[] = ["auto", "zh", "en", "yue"];

/** Settings → 通用 「语音输入」: whether the microphone is shown, the language it listens for, and whether the text is corrected. */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const body = await request.json().catch(() => null) as { enabled?: unknown; correct?: unknown; language?: unknown } | null;
  const patch = { ...(typeof body?.enabled === "boolean" ? { enabled: body.enabled } : {}), ...(typeof body?.correct === "boolean" ? { correct: body.correct } : {}),
    ...(typeof body?.language === "string" && LANGUAGES.includes(body.language) ? { language: body.language as VoiceLanguage } : {}) };
  if (!Object.keys(patch).length) return Response.json({ ok: false, code: "INVALID_VOICE_SETTING" }, { status: 400 });
  return Response.json({ ok: true, preferences: saveVoicePreferences(access.ctx, patch) });
}
