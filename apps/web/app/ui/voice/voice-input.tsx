"use client";

import { Check, Mic, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DICTATION_MAX_SECONDS, speechLang, type VoicePreferences } from "@crossline/core";
import { useLocale, useT } from "../../locale-context";
import { ICON, IconButton } from "../icon-button";
import {
  BROWSER_BROKEN_ERRORS, chooseEngine, clock, insertDictation, isIosStandalone, isSafari, mixDown, spanNow, toPcm16,
  type DictatedSpan, type VoiceEngine, type VoiceServerState
} from "./voice-model";

/**
 * The microphone beside every free-text box (docs/voice-input.md, decided with the owner on 2026-11-02). Tap to start and tap again to
 * finish, or hold and let go; ✓ finishes, × or Esc cancels; three minutes at most. What was heard goes in at the caret at once, a model's
 * correction against the person's own names replaces it a few seconds later (unless the person has edited it by then), and what the
 * person changes in it afterwards is sent back as their own wording. The audio is never kept: the browser's recogniser streams it to its
 * maker, and Crossline's engine gets decoded samples that are deleted as they are read.
 */

export type VoiceFieldKind = "conversation" | "interview" | "note" | "form";
export type VoicePage = { kind: string; entityId: string };
type Target = HTMLInputElement | HTMLTextAreaElement;
type Status = { preferences: VoicePreferences; server: VoiceServerState; mode: "server" | "local"; modelBytes: number };

let statusLoad: Promise<Status | undefined> | undefined;
const loadStatus = () => (statusLoad ??= fetch("/api/voice", { cache: "no-store" })
  .then((response) => response.ok ? response.json() as Promise<Status> : undefined).catch(() => undefined));
/** Called by Settings → 通用 「语音输入」 after a save, so every microphone on the page reads the new settings. */
export function refreshVoiceStatus(): void {
  statusLoad = undefined;
  window.dispatchEvent(new Event("crossline:voice-changed"));
}
function useVoiceStatus(): Status | undefined {
  const [status, setStatus] = useState<Status>();
  useEffect(() => {
    let live = true;
    const read = () => void loadStatus().then((value) => { if (live) setStatus(value); });
    read();
    window.addEventListener("crossline:voice-changed", read);
    return () => { live = false; window.removeEventListener("crossline:voice-changed", read); };
  }, []);
  return status;
}

/** Only one microphone records at a time: starting another cancels the first. */
let stopOther: (() => void) | undefined;

const BROKEN_KEY = "crossline.voice.browserBroken";
const noticeKey = (engine: string) => `crossline.voice.notice.${engine}`;
const stored = (key: string) => { try { return sessionStorage.getItem(key) ?? localStorage.getItem(key); } catch { return null; } };

type SpeechResultList = ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: SpeechResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
const recognitionClass = (): (new () => Recognition) | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;

/** Sets a React-controlled box's value as typing would, so its `onChange` sees it, and puts the caret after `caret`. */
function setValue(element: Target, value: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  if (setter) setter.call(element, value); else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.focus({ preventScroll: true });
  try { element.setSelectionRange(caret, caret); } catch { /* some input types have no selection */ }
}

type Phase = "idle" | "notice" | "model" | "recording" | "transcribing" | "correcting" | "done" | "error";

export function VoiceButton({ target, kind, label, page, className = "" }: {
  target: () => Target | null; kind: VoiceFieldKind; label?: string; page?: VoicePage; className?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const status = useVoiceStatus();
  const [mounted, setMounted] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [engine, setEngine] = useState<VoiceEngine>("none");
  const [caption, setCaption] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("");
  const [corrected, setCorrected] = useState(0);
  const session = useRef<{
    engine: VoiceEngine; caret: [number, number]; startedAt: number; stopping: boolean; cancelled: boolean; finals: string; interim: string;
    recognition?: Recognition; recorder?: MediaRecorder; stream?: MediaStream; audio?: AudioContext; chunks: Blob[]; tick?: number; raf?: number;
  } | undefined>(undefined);
  const restore = useRef<{ element: Target; raw: string; span: DictatedSpan } | undefined>(undefined);
  const pressAt = useRef(0);
  const hideTimer = useRef<number | undefined>(undefined);
  const lexicon = useRef<(() => void) | undefined>(undefined);
  useEffect(() => setMounted(true), []);

  const facts = useCallback((server: VoiceServerState, mode: "server" | "local") => {
    const nav = navigator as Navigator & { standalone?: boolean };
    return { hasSpeechRecognition: !!recognitionClass(), online: navigator.onLine, browserBroken: stored(BROKEN_KEY) === "1", server, mode,
      iosStandalone: isIosStandalone(nav, window.matchMedia?.("(display-mode: standalone)").matches ?? false) };
  }, []);

  const teardown = useCallback(() => {
    const current = session.current;
    if (!current) return;
    window.clearInterval(current.tick);
    if (current.raf) cancelAnimationFrame(current.raf);
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.audio?.close().catch(() => undefined);
    session.current = undefined;
    if (stopOther === cancelRef.current) stopOther = undefined;
  }, []);

  const flash = useCallback((next: Phase, text = "", ms = 6000) => {
    setPhase(next); setMessage(text);
    window.clearTimeout(hideTimer.current);
    if (next === "done" || next === "error") hideTimer.current = window.setTimeout(() => setPhase("idle"), ms);
  }, []);

  const cancelRef = useRef<() => void>(() => {});
  const cancel = useCallback(() => {
    const current = session.current;
    if (current) {
      current.cancelled = true;
      try { current.recognition?.abort(); } catch { /* already ended */ }
      try { if (current.recorder?.state !== "inactive") current.recorder?.stop(); } catch { /* already stopped */ }
    }
    teardown();
    setPhase("idle"); setCaption("");
  }, [teardown]);
  cancelRef.current = cancel;

  /** What was heard into the box, then the correction, then the person's own edits watched for their wordings. */
  const deliver = useCallback(async (raw: string) => {
    const element = target();
    const text = raw.trim();
    if (!element || !text) { flash("error", t("没有听清，再说一次试试。"), 4000); return; }
    const caret = session.current?.caret ?? [element.value.length, element.value.length];
    teardown();
    const placed = insertDictation(element.value, Math.min(caret[0], element.value.length), Math.min(caret[1], element.value.length), text,
      element.maxLength > 0 ? element.maxLength : undefined);
    setValue(element, placed.value, placed.at + placed.inserted.length);
    let span: DictatedSpan = { prefix: placed.value.slice(0, placed.at), suffix: placed.value.slice(placed.at + placed.inserted.length), text: placed.inserted };
    lexicon.current?.();
    const preferences = status?.preferences;
    if (preferences?.correct && placed.inserted.trim()) {
      setPhase("correcting");
      const language = preferences.language === "auto" ? locale : preferences.language;
      const answer = await fetch("/api/voice/correct", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw: placed.inserted, language, field: { kind, label: label ?? "" }, ...(page ? { page } : {}) }) })
        .then((response) => response.ok ? response.json() as Promise<{ text?: string; count?: number }> : undefined).catch(() => undefined);
      const now = spanNow(span, element.value);
      if (answer?.text && answer.count && now === placed.inserted && answer.text !== placed.inserted) {
        const value = `${span.prefix}${answer.text}${span.suffix}`;
        setValue(element, value, span.prefix.length + answer.text.length);
        restore.current = { element, raw: placed.inserted, span: { ...span, text: answer.text } };
        span = { ...span, text: answer.text };
        setCorrected(answer.count);
        flash("done", "", 10_000);
      } else setPhase("idle");
    } else setPhase("idle");
    watchEdits(element, span);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash, kind, label, locale, page, status, t, target, teardown]);

  /** The person's change to the dictated text, sent once when they leave the box or the text around it changes (they sent it). */
  const watchEdits = (element: Target, span: DictatedSpan) => {
    let latest = span.text, done = false;
    const finish = () => {
      if (done) return;
      done = true;
      element.removeEventListener("input", onInput); element.removeEventListener("blur", finish);
      window.clearTimeout(timer);
      if (lexicon.current === finish) lexicon.current = undefined;
      if (latest !== span.text && latest.trim()) {
        void fetch("/api/voice/lexicon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dictated: span.text, edited: latest }) }).catch(() => undefined);
      }
    };
    const onInput = () => { const now = spanNow(span, element.value); if (now === undefined) finish(); else latest = now; };
    element.addEventListener("input", onInput); element.addEventListener("blur", finish);
    const timer = window.setTimeout(finish, 5 * 60_000);
    lexicon.current = finish;
  };

  const undoCorrection = () => {
    const kept = restore.current;
    restore.current = undefined;
    setPhase("idle");
    if (!kept) return;
    const now = spanNow(kept.span, kept.element.value);
    if (now === undefined) return;
    lexicon.current?.();
    setValue(kept.element, `${kept.span.prefix}${kept.raw}${kept.span.suffix}`, kept.span.prefix.length + kept.raw.length);
    watchEdits(kept.element, { ...kept.span, text: kept.raw });
  };

  const finish = useCallback(() => {
    const current = session.current;
    if (!current || current.stopping) return;
    current.stopping = true;
    window.clearInterval(current.tick);
    if (current.engine === "browser") { try { current.recognition?.stop(); } catch { void deliver(`${current.finals}${current.interim}`); } }
    else { setPhase("transcribing"); try { current.recorder?.stop(); } catch { cancel(); } }
  }, [cancel, deliver]);

  const failText = useCallback((code: string) => ({
    VOICE_ENGINE_UNAVAILABLE: t("语音识别服务暂时不可用，稍后再试。"), VOICE_TRANSCRIBER_TIMEOUT: t("识别用时过长，没有完成，请再说一次。"),
    VOICE_CLIP_LENGTH: t("录音太短，没有听到内容。"), VOICE_MODEL_MISSING: t("本机还没有语音识别模型。")
  } as Record<string, string>)[code] ?? t("语音没能转成文字，请再试一次。"), [t]);

  const sendClip = useCallback(async (blob: Blob) => {
    try {
      const context = new AudioContext();
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      void context.close().catch(() => undefined);
      const pcm = toPcm16(mixDown(Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))), decoded.sampleRate);
      const response = await fetch("/api/voice/transcribe", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: pcm.buffer as ArrayBuffer });
      const body = await response.json().catch(() => ({})) as { text?: string; blocker?: { code?: string } };
      if (!response.ok) { teardown(); flash("error", failText(body.blocker?.code ?? "")); return; }
      await deliver(body.text ?? "");
    } catch { teardown(); flash("error", failText("")); }
  }, [deliver, failText, flash, teardown]);

  const begin = useCallback(async (chosen: VoiceEngine) => {
    const element = target();
    if (!element) return;
    stopOther?.();
    stopOther = cancelRef.current;
    const active = document.activeElement === element;
    const caret: [number, number] = active ? [element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length] : [element.value.length, element.value.length];
    session.current = { engine: chosen, caret, startedAt: Date.now(), stopping: false, cancelled: false, finals: "", interim: "", chunks: [] };
    setEngine(chosen); setCaption(""); setSeconds(0); setLevel(0); setPhase("recording");
    const current = session.current;
    current.tick = window.setInterval(() => {
      const elapsed = (Date.now() - current.startedAt) / 1000;
      setSeconds(elapsed);
      if (elapsed >= DICTATION_MAX_SECONDS) finish();
    }, 250);
    const preferences = status?.preferences ?? { enabled: true, correct: true, language: "auto" as const };
    if (chosen === "browser") {
      const Class = recognitionClass()!;
      const recognition = new Class();
      recognition.lang = speechLang(preferences, locale, isSafari(navigator.userAgent));
      recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index]!;
          if (result.isFinal) current.finals += result[0]!.transcript; else interim += result[0]!.transcript;
        }
        current.interim = interim;
        setCaption(`${current.finals}${interim}`);
      };
      recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;
        const heardNothing = !current.finals && !current.interim;
        if (BROWSER_BROKEN_ERRORS.has(event.error) && heardNothing) {
          try { sessionStorage.setItem(BROKEN_KEY, "1"); } catch { /* not remembered: the next tap tries again */ }
          current.cancelled = true;
          teardown();
          // Straight on with Crossline's own engine when it is there, so the tap is not lost.
          if (status?.server === "ready") void begin("server"); else flash("error", t("这个浏览器的语音识别连不上，这里暂时不能语音输入。"));
          return;
        }
        if (event.error === "not-allowed") { current.cancelled = true; teardown(); flash("error", t("没有麦克风权限：在浏览器的网站设置里允许麦克风后再试。"), 8000); }
      };
      recognition.onend = () => {
        if (current.cancelled || session.current !== current) return;
        // Chrome ends a continuous session by itself after a pause: it goes on until the person finishes.
        if (!current.stopping) { try { recognition.start(); return; } catch { /* could not restart: what was heard is delivered */ } }
        void deliver(`${current.finals}${current.interim}`);
      };
      current.recognition = recognition;
      try { recognition.start(); } catch { teardown(); flash("error", failText("")); }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (current.cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
      current.stream = stream;
      const audio = new AudioContext();
      current.audio = audio;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const draw = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
        setLevel(Math.min(1, peak / 64));
        current.raf = requestAnimationFrame(draw);
      };
      draw();
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size) current.chunks.push(event.data); };
      recorder.onstop = () => {
        if (current.cancelled) return;
        void sendClip(new Blob(current.chunks, { type: recorder.mimeType }));
      };
      current.recorder = recorder;
      recorder.start(1000);
    } catch (error) {
      teardown();
      const denied = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
      flash("error", denied ? t("没有麦克风权限：在浏览器的网站设置里允许麦克风后再试。") : t("没有找到可用的麦克风。"), 8000);
    }
  }, [failText, finish, flash, locale, sendClip, status, t, target, teardown]);

  const start = useCallback(() => {
    if (!status) return;
    const chosen = chooseEngine(facts(status.server, status.mode));
    if (chosen === "none") { flash("error", t("这个浏览器不能语音输入。Chrome、Edge 和 Safari 可以。"), 6000); return; }
    if (chosen === "model_needed") { setPhase("model"); return; }
    if (stored(noticeKey(chosen)) !== "1") { setEngine(chosen); setPhase("notice"); return; }
    void begin(chosen);
  }, [begin, facts, flash, status, t]);

  const acceptNotice = () => {
    try { localStorage.setItem(noticeKey(engine), "1"); } catch { /* shown again next time */ }
    void begin(engine);
  };

  const download = async () => {
    setMessage(t("正在下载语音识别模型…"));
    const response = await fetch("/api/voice/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: true }) }).catch(() => undefined);
    if (!response?.ok) { flash("error", t("模型没能开始下载，稍后再试。")); return; }
    const poll = window.setInterval(async () => {
      statusLoad = undefined;
      const next = await loadStatus();
      if (next?.server === "ready") { window.clearInterval(poll); refreshVoiceStatus(); flash("done", t("语音识别模型已就绪，再点一下麦克风开始。"), 6000); setCorrected(0); }
      else if (next?.server === "model_missing") { window.clearInterval(poll); flash("error", t("模型下载没有完成，请再试一次。")); }
    }, 3000);
  };

  useEffect(() => {
    if (phase !== "recording" && phase !== "notice" && phase !== "model") return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cancel, phase]);
  useEffect(() => () => { cancelRef.current(); lexicon.current?.(); window.clearTimeout(hideTimer.current); }, []);

  if (!mounted || !status || !status.preferences.enabled) return null;
  const recording = phase === "recording";
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Keeps the caret where it is in the box.
    event.preventDefault();
    if (recording) { pressAt.current = 0; finish(); return; }
    if (phase === "notice" || phase === "model") return;
    pressAt.current = Date.now();
    start();
  };
  const onPointerUp = () => { if (recording && pressAt.current && Date.now() - pressAt.current > 400) finish(); pressAt.current = 0; };
  const onClick = (event: React.MouseEvent) => { if (event.detail !== 0) return; if (recording) finish(); else start(); };

  const correctNote = status.preferences.correct ? t("转出的文字会按主线、项目和任务的名称纠正错字（使用模型额度），可在设置 → 通用里关闭。") : "";
  const panel = phase === "idle" ? null : <div className="voice-panel" role={phase === "error" ? "alert" : "status"} aria-live="polite" data-phase={phase}>
    {phase === "notice" && <>
      <p>{engine === "browser" ? t("语音由浏览器自带的识别服务转成文字：Chrome 交给 Google，Edge 交给 Microsoft，Safari 交给 Apple。Crossline 不保存录音。")
        : status.mode === "local" ? t("录音在这台电脑上转成文字，不离开本机，转完立即删除。")
          : t("录音发到 Crossline 的服务器转成文字，转完立即删除，不保存。")}</p>
      {correctNote && <p>{correctNote}</p>}
      <p className="voice-hint">{t("点一下开始，再点一下结束；也可以按住说话，松开结束。最长 3 分钟。")}</p>
      <div className="voice-actions"><button type="button" className="primary-button" onClick={acceptNotice}>{t("开始说话")}</button>
        <button type="button" className="secondary-button" onClick={cancel}>{t("取消")}</button></div>
    </>}
    {phase === "model" && <>
      <p>{message || t("这台电脑上的浏览器没有自带语音识别。下载 SenseVoice 语音识别模型（约 {{mb}} MB，来自 Hugging Face）后，语音在本机转成文字，不离开这台电脑。",
        { mb: String(Math.round(status.modelBytes / 1_000_000)) })}</p>
      <div className="voice-actions">{!message && <button type="button" className="primary-button" onClick={() => void download()}>{t("下载模型")}</button>}
        <button type="button" className="secondary-button" onClick={cancel}>{t("关闭")}</button></div>
    </>}
    {recording && <>
      <span className="voice-meter" data-engine={engine} aria-hidden="true">
        {engine === "server" ? [0.5, 0.8, 1, 0.8, 0.5].map((weight, index) => <i key={index} style={{ transform: `scaleY(${Math.max(0.15, level * weight)})` }} />) : <i />}
      </span>
      <span className="voice-caption">{caption || (engine === "browser" ? t("正在听…") : t("正在录音…"))}</span>
      <span className="voice-clock">{clock(seconds)} / {clock(DICTATION_MAX_SECONDS)}</span>
      <IconButton label={t("取消（Esc）")} icon={<X {...ICON} />} onClick={cancel} tip={false} />
      <IconButton label={t("完成")} tone="primary" icon={<Check {...ICON} />} onClick={finish} tip={false} />
    </>}
    {phase === "transcribing" && <span className="voice-caption">{t("正在转成文字…")}</span>}
    {phase === "correcting" && <span className="voice-caption">{t("已填入，正在纠正错字…")}</span>}
    {phase === "done" && <>
      <span className="voice-caption">{message || t("已纠正 {{n}} 处", { n: String(corrected) })}</span>
      {!message && restore.current && <button type="button" className="secondary-button" onClick={undoCorrection}>{t("恢复原文")}</button>}
      <IconButton label={t("关闭")} icon={<X {...ICON} />} onClick={() => setPhase("idle")} tip={false} />
    </>}
    {phase === "error" && <>
      <span className="voice-caption">{message}</span>
      <IconButton label={t("关闭")} icon={<X {...ICON} />} onClick={() => setPhase("idle")} tip={false} />
    </>}
  </div>;

  return <>
    <IconButton className={`voice-button ${className}`.trim()} label={recording ? t("结束语音输入") : t("语音输入")} icon={<Mic {...ICON} />}
      tone={recording ? "alarm" : "plain"} aria-pressed={recording} data-voice={phase} onPointerDown={onPointerDown} onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp} onClick={onClick} />
    {panel && createPortal(panel, document.body)}
  </>;
}

/**
 * A free-text box with its microphone in the corner: wraps one `<input>` or `<textarea>`, which keeps its own props, state and styles.
 * The box gets room on the right for the button; nothing else of the layout changes.
 */
export function VoiceField({ kind, label, page, children, className = "" }: {
  kind: VoiceFieldKind; label?: string; page?: VoicePage; children: ReactNode; className?: string;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const target = useCallback(() => wrap.current?.querySelector<Target>("textarea, input") ?? null, []);
  return <span ref={wrap} className={`voice-field ${className}`.trim()}>
    {children}
    <VoiceButton target={target} kind={kind} {...(label ? { label } : {})} {...(page ? { page } : {})} />
  </span>;
}
