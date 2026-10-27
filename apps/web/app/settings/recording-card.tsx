"use client";

import { useEffect, useState } from "react";
import type { RecordingOverview } from "../../lib/recordings";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { LOCAL_RECORDING_GUIDE } from "../../lib/setup-guides";
import type { TranscriptionStatus } from "../onboarding/transcription-card";
import { useT } from "../locale-context";

/**
 * 录音自动转写 (docs/phone-recording.md): whether recordings a phone syncs into an authorized folder are transcribed on this computer.
 * Off by default. Turning it off asks what becomes of the transcripts already made; while it is on and the speech model is missing, the
 * card says so and offers the one-time download, naming its source and size, instead of the recordings waiting silently.
 */
export function RecordingCard({ overview }: { overview: RecordingOverview }) {
  const t = useT();
  const [on, setOn] = useState(overview.on);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [model, setModel] = useState<TranscriptionStatus | undefined>();
  const [look, setLook] = useState(0);

  useEffect(() => {
    if (!on) return;
    let stop = false;
    const read = async () => {
      const response = await fetch("/api/transcription", { cache: "no-store" }).catch(() => undefined);
      const status = response?.ok ? await response.json() as TranscriptionStatus : undefined;
      if (stop) return;
      setModel(status);
      if (status?.state === "downloading") setTimeout(() => void read(), 2000);
    };
    void read();
    return () => { stop = true; };
  }, [on, look]);

  const save = async (next: boolean, keep?: boolean) => {
    const response = await fetch("/api/settings/recordings", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(keep === undefined ? { on: next } : { on: next, keep }) }).catch(() => undefined);
    if (!response?.ok) { setNote(t("未保存，请重试")); return; }
    const { deleted } = await response.json() as { deleted: number };
    setOn(next); setAsking(false);
    setNote(next ? t("已开启：下一次读取文件夹时开始转写新录音")
      : keep ? t("已关闭，已转写的文字保留在材料里") : t("已关闭，已删除 {{count}} 份转写文字", { count: deleted }));
  };
  const download = async () => {
    const response = await fetch("/api/transcription", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: true }) }).catch(() => undefined);
    if (!response?.ok) { setNote(t("下载没有开始，请重试")); return; }
    setModel({ state: "downloading", progress: 0 });
    setLook((count) => count + 1);
  };

  return <section className="st-card" aria-label={t("录音自动转写")}>
    <header><h3>{t("录音自动转写")}</h3><small>{t("手机录音同步到已授权的文件夹后，在这台电脑上转写成文字放进材料；录音不上传，也不留副本")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("转写")}<small>{on ? t("开启", { context: "state" }) : t("关闭", { context: "state" })}</small></span>
      <SegmentedControl label={t("录音自动转写")} value={on ? "on" : "off"} onChange={(next) => { if (next === "on") void save(true); else if (on) setAsking(true); }}
        options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]} /></div>
    {asking && <div className="st-row st-row-wrap" role="group" aria-label={t("关闭后已转写的文字")}>
      <span className="st-row-label">{t("已转写的 {{count}} 份文字", { count: overview.done })}<small>{t("关闭后不再转写新录音")}</small></span>
      <span className="st-row-actions">
        <button type="button" onClick={() => void save(false, true)}>{t("关闭并保留")}</button>
        <button type="button" onClick={() => void save(false, false)}>{t("关闭并删除")}</button>
        <button type="button" onClick={() => setAsking(false)}>{t("取消")}</button>
      </span></div>}
    {note && <p role="status" className="st-note">{note}</p>}
    {on && model?.state === "needs_download" && <div className="st-row st-row-wrap">
      <span className="st-row-label">{t("需要先下载语音识别模型")}<small>{t("{{model}}（Whisper small），约 {{mb}} MB，来源 {{source}}；只下载这一次，之后录音只在本机识别", { model: model.model, mb: model.approxMegabytes, source: model.source.replace("https://", "") })}{overview.queued ? t("。{{count}} 个录音在等", { count: overview.queued }) : ""}</small></span>
      <button type="button" onClick={() => void download()}>{t("同意并下载")}</button></div>}
    {on && model?.state === "downloading" && <p className="st-note">{t("正在下载语音识别模型：{{pct}}%，完成后自动开始转写。", { pct: Math.round(model.progress * 100) })}</p>}
    {on && model?.state === "unavailable" && <p className="st-fail">{t("暂时不能转写：{{message}}", { message: model.message })}</p>}
    {on && overview.folders === 0 && <p className="st-note">{t("还没有授权文件夹：先在「日历与连接」里授权手机录音同步到的那个文件夹。")}</p>}
    {(on || overview.done > 0) && <p className="st-note">{t("已转写 {{done}} 个，无人声 {{silent}} 个，排队 {{queued}} 个。", { done: overview.done, silent: overview.silent, queued: overview.queued })}{" "}{t("同时转几个（按电脑核数和内存）；白天本人在用电脑时放慢，夜间与离开时全速。转完的录音会整理成摘要：闲聊和视频声不保留，本人答应做的事记为收集，需本人确认后才排进日程。")}</p>}
    {overview.cost && <p className="st-note">{t("最近 {{count}} 个录音（共 {{hours}} 小时）：每小时录音约用 {{minutes}} 分钟转写。", { count: overview.cost.recordings, hours: overview.cost.audioHours, minutes: overview.cost.minutesPerHour })}</p>}
    {overview.failed.length > 0 && <ul className="st-list" aria-label={t("没有转写成的录音")}>{overview.failed.map((item) =>
      <li key={item.file}><span>{item.file}</span><small>{item.note}</small></li>)}</ul>}
    <SetupGuide guide={LOCAL_RECORDING_GUIDE} />
    <p className="st-note">{t("录到别人说话前，需让对方知情，并遵守当地关于录音的法律。")}</p>
  </section>;
}
