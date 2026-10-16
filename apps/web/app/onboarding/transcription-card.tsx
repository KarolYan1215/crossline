"use client";

import { useT } from "../locale-context";
import { withLink } from "./rich-text";

export type TranscriptionStatus =
  | { state: "ready" }
  | { state: "needs_download"; model: string; source: string; approxMegabytes: number }
  | { state: "downloading"; progress: number }
  | { state: "unavailable"; code: string; message: string };

/**
 * Shown while a recording is waiting to be turned into text. Speech recognition runs on this computer, so the
 * first time it needs a model file; the button says where that file comes from and how large it is, and nothing
 * is fetched until it is pressed. After that the audio never leaves the machine and no connection is needed.
 */
export function TranscriptionCard({ status, busy, onDownload }: { status: TranscriptionStatus; busy: boolean; onDownload: () => void }) {
  const t = useT();
  if (status.state === "ready") return null;
  return <section className="ob-design" aria-label={t("录音转写")}>
    {status.state === "needs_download" && <>
      <b>{t("转写录音需要先下载一个语音识别模型")}</b>
      <span className="ob-muted">{withLink(t("模型：{{model}}（Whisper small，8 位量化），约 {{mb}} MB，来源 <a>{{source}}</a>。只下载这一次；之后录音只在这台电脑上识别，不上传，也不需要网络。",
        { model: status.model, mb: status.approxMegabytes, source: status.source.replace("https://", "") }),
        (inner) => <a href={status.source} target="_blank" rel="noreferrer noopener">{inner}</a>)}</span>
      <button type="button" className="ob-btn" disabled={busy} onClick={onDownload}>{t("同意并下载（约 {{mb}} MB）", { mb: status.approxMegabytes })}</button>
    </>}
    {status.state === "downloading" && <>
      <b>{t("正在下载语音识别模型…")}</b>
      <progress value={status.progress} max={1} aria-label={t("下载进度")} />
      <span className="ob-muted">{t("{{percent}}%。下载完成后，等待中的录音会自动开始转写。", { percent: Math.round(status.progress * 100) })}</span>
    </>}
    {status.state === "unavailable" && <>
      <b>{t("暂时不能转写录音")}</b>
      <span className="ob-muted">{status.message}</span>
    </>}
  </section>;
}
