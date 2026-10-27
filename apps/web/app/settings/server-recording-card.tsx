"use client";

import { useEffect, useRef, useState } from "react";
import type { RecordingOverview, ServerRecordings, VoiceprintState } from "../../lib/recordings";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { recordingUploadGuide } from "../../lib/setup-guides";
import { useLocale, useT } from "../locale-context";
import { intlLocale, type Locale, type Translate } from "../../lib/i18n";

const later = (minutes: number, t: Translate) => minutes < 60 ? t("约 {{minutes}} 分钟后", { minutes })
  : minutes % 60 ? t("约 {{hours}} 小时 {{minutes}} 分钟后", { hours: Math.floor(minutes / 60), minutes: minutes % 60 }) : t("约 {{hours}} 小时后", { hours: Math.floor(minutes / 60) });
const day = (iso: string, timeZone: string, locale: Locale) => {
  try { return new Intl.DateTimeFormat(intlLocale(locale), { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)); }
  catch { return iso.slice(0, 16).replace("T", " "); }
};

/** 已转写 / 等待转写（何时开始）/ 无人声 / 失败（原因）, and the last few transcripts with whether their summary exists yet. */
export function ServerRecordingStatus({ server }: { server: ServerRecordings }) {
  const t = useT();
  const locale = useLocale();
  const { opens } = server;
  return <>
    <p className="st-note" aria-label={t("服务器转写进度")}>{t("已转写 {{transcribed}} 个 · 等待转写 {{waiting}} 个 · 无人声 {{silent}} 个 · 失败 {{failed}} 个",
      { transcribed: server.transcribed, waiting: server.waiting, silent: server.silent, failed: server.failedCount })}</p>
    {server.waiting > 0 && <p className="st-note">{opens.inMinutes === 0
      ? t("现在是夜间转写时段，等待的录音按收到的先后逐个转写。")
      : t("等待的录音在本人时区（{{zone}}）{{at}} 开始转写，{{later}}。", { zone: opens.timeZone, at: opens.at, later: later(opens.inMinutes, t) })}</p>}
    {server.recent.length > 0 && <ul className="st-list" aria-label={t("最近转写的录音")}>{server.recent.map((item) =>
      <li key={item.documentId}><a href={`/api/source-documents/${encodeURIComponent(item.documentId)}/file`}>{item.file}</a>
        <small>{t("{{when}} 转写，{{minutes}} 分钟；{{digest}}", { when: day(item.at, opens.timeZone, locale), minutes: item.minutes,
          digest: item.digested ? t("摘要已整理进材料") : t("摘要待整理（需要模型额度）") })}</small></li>)}</ul>}
    {server.failed.length > 0 && <ul className="st-list" aria-label={t("没有转写成的上传")}>{server.failed.map((item, index) =>
      <li key={`${item.file}-${index}`}><span>{item.file}</span><small>{t("没有转写成：{{note}}", { note: item.note })}</small></li>)}</ul>}
  </>;
}

/**
 * 录音在服务器转写 (docs/phone-recording.md 「服务器转写」): the phone's shortcut uploads recordings with a token of their own, the server
 * transcribes them in the person's night and deletes the audio. Off by default; turning it off deletes what still waits and asks what
 * becomes of the transcripts.
 */
export function ServerRecordingCard({ server, done }: { server: NonNullable<RecordingOverview["server"]>; done: number }) {
  const t = useT();
  const [on, setOn] = useState(server.on);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [token, setToken] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const save = async (next: boolean, keep?: boolean) => {
    const response = await fetch("/api/settings/recordings/server", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(keep === undefined ? { on: next } : { on: next, keep }) }).catch(() => undefined);
    if (!response?.ok) { setNote(t("未保存，请重试")); return; }
    const result = await response.json() as { deleted: number; discarded: number };
    setOn(next); setAsking(false);
    setNote(next ? t("已开启：生成上传令牌后按下面的步骤设置快捷指令")
      : keep ? t("已关闭，已删除 {{count}} 个还没转写的录音，已转写的文字保留", { count: result.discarded })
        : t("已关闭，已删除 {{count}} 个还没转写的录音和 {{deleted}} 份转写文字", { count: result.discarded, deleted: result.deleted }));
  };
  const issue = async () => {
    const response = await fetch("/api/health/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "recording" }) }).catch(() => undefined);
    const body = await response?.json().catch(() => null) as { token?: string } | null;
    if (!body?.token) { setNote(t("未能生成，请重试")); return; }
    setToken(body.token);
    setNote(t("令牌只显示这一次；重新生成后旧的立即失效。"));
  };
  const endpoint = `${origin || t("https://<网址>")}/api/recordings/upload?name=`;

  return <section className="st-card" aria-label={t("录音在服务器转写")}>
    <header><h3>{t("录音在服务器转写")}</h3><small>{t("手机快捷指令把录音上传到服务器，本人时区夜间 1–6 点用 SenseVoice 转写成文字放进材料；录音转完即删，不进备份")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("服务器转写")}<small>{on ? t("开启；录音会离开本人的设备") : t("关闭；录音会离开本人的设备")}</small></span>
      <SegmentedControl label={t("录音在服务器转写")} value={on ? "on" : "off"} onChange={(next) => { if (next === "on") void save(true); else if (on) setAsking(true); }}
        options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]} /></div>
    {asking && <div className="st-row st-row-wrap" role="group" aria-label={t("关闭后已转写的文字")}>
      <span className="st-row-label">{t("还没转写的录音会删除；已转写的 {{count}} 份文字", { count: done })}<small>{t("关闭后不再接收上传")}</small></span>
      <span className="st-row-actions">
        <button type="button" onClick={() => void save(false, true)}>{t("关闭并保留文字")}</button>
        <button type="button" onClick={() => void save(false, false)}>{t("关闭并删除文字")}</button>
        <button type="button" onClick={() => setAsking(false)}>{t("取消")}</button>
      </span></div>}
    {note && <p role="status" className="st-note">{note}</p>}
    {(on || server.transcribed + server.silent + server.failedCount + server.waiting > 0) && <ServerRecordingStatus server={server} />}
    {on && <>
      <p className="st-note">{t("转完的录音会整理成摘要：闲聊和视频声不保留，本人答应做的事记为收集，需本人确认后才排进日程。")}</p>
      <div className="st-row st-row-wrap"><span className="st-row-label">{t("上传令牌")}<small>{t("只能上传录音，不能读任何内容")}</small></span>
        <button type="button" onClick={() => void issue()}>{token ? t("重新生成") : t("生成上传令牌")}</button></div>
      {token && <ul className="st-list" aria-label={t("快捷指令要填的内容")}>
        <li><span>{t("网址")}</span><small className="mono">{endpoint}</small></li>
        <li><span>{t("请求头 Authorization")}</span><small className="mono">Bearer {token}</small></li>
      </ul>}
      <SetupGuide guide={recordingUploadGuide(endpoint)} {...(token ? { open: true } : {})} />
    </>}
    {on && <VoiceprintSection initial={server.voiceprint} />}
    <p className="st-note">{t("录到别人说话前，需让对方知情，并遵守当地关于录音的法律。")}</p>
  </section>;
}

const VOICEPRINT_STATE: Record<VoiceprintState["state"], string> = {
  none: "还没有录入", pending: "已收到录音，几分钟内处理", ready: "已录入", failed: "没有录成"
};

/**
 * 识别本人声音: every server transcript already separates speakers (「说话人 1」「说话人 2」); with this consent the person's own lines
 * read 「本人」, from a voiceprint made of a recording of them alone. Its own consent because a voiceprint is biometric; off deletes it.
 */
function VoiceprintSection({ initial }: { initial: VoiceprintState }) {
  const t = useT();
  const [state, setState] = useState(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const setOn = async (on: boolean) => {
    const response = await fetch("/api/settings/recordings/voiceprint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => undefined);
    if (!response?.ok) { setNote(t("未保存，请重试")); return; }
    setState(on ? { ...state, on } : { on, state: "none" });
    setNote(on ? t("已开启：上传一段只有本人说话的录音") : t("已关闭，声纹已删除"));
  };
  const upload = async (file: File) => {
    setBusy(true);
    const response = await fetch("/api/recordings/voiceprint", { method: "POST", body: file }).catch(() => undefined);
    const body = await response?.json().catch(() => null) as { message?: string } | null;
    setBusy(false);
    if (!response?.ok) { setNote(body?.message ?? t("上传失败，请重试")); return; }
    setState({ on: true, state: "pending" });
    setNote(t("已收到，处理完会显示「已录入」；录音本身处理后删除。"));
  };
  return <>
    <div className="st-row"><span className="st-row-label">{t("识别本人声音")}<small>{state.on ? t("开启；转写稿本来就分说话人，开启后本人说的话标为「本人」") : t("关闭；转写稿本来就分说话人，开启后本人说的话标为「本人」")}</small></span>
      <SegmentedControl label={t("识别本人声音")} value={state.on ? "on" : "off"} onChange={(next) => void setOn(next === "on")}
        options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]} /></div>
    {state.on && <div className="st-row st-row-wrap"><span className="st-row-label">{t("本人声纹")}<small>{t(VOICEPRINT_STATE[state.state])}{state.state === "ready" && state.seconds ? t("（用了约 {{seconds}} 秒人声）", { seconds: state.seconds }) : ""}{state.state === "failed" && state.message ? t("：{{message}}", { message: state.message }) : ""}</small></span>
      <input ref={picker} type="file" accept="audio/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.webm,.flac" hidden
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      <button type="button" disabled={busy} onClick={() => picker.current?.click()}>{busy ? t("上传中…") : state.state === "ready" ? t("重新录入") : t("上传本人录音")}</button></div>}
    {state.on && <p className="st-note">{t("用语音备忘录录 30 秒到 2 分钟只有本人说话的内容（念一段文字即可），录完「共享 → 存储到文件」，再在这里选那个文件。只保存从中算出的一串数字（声纹），不保存录音；别人的声音只在单个录音里区分，不保存。关闭即删除。")}</p>}
    {note && <p role="status" className="st-note">{note}</p>}
  </>;
}
