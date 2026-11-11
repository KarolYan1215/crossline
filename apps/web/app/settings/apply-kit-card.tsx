"use client";

import { useState } from "react";
import { KIT_DOCUMENT_KINDS, KIT_DOCUMENT_LABEL, type ApplyKit, type KitDocumentKind } from "@crossline/core";
import { useT } from "../locale-context";
import "./apply-kit-card.css";

/**
 * 申请资料包 (docs/opportunity-agent.md §18.3): the short answers and documents the form filler may reuse across sign-ups, beside the
 * profile items above. Each edit is a new version; the history says what changed, and each run records the version it used.
 */
export function ApplyKitSection({ kit }: { kit: ApplyKit }) {
  const t = useT();
  const [answer, setAnswer] = useState<{ id?: string; prompt: string; text: string } | undefined>();
  const [doc, setDoc] = useState<{ id?: string; kind: KitDocumentKind; label: string; path: string } | undefined>();
  const [note, setNote] = useState("");
  const send = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/apply-kit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    if (!response?.ok) { setNote(t("没有保存：内容为空、没有变化或已到上限")); return; }
    setNote("");
    window.location.reload();
  };
  return <div className="st-kit" id="apply-kit">
    <h4>{t("申请资料包")} <small className="muted">{t("v{{version}}", { version: kit.version })}</small></h4>
    <p className="muted">{t("可反复使用的短答和文件。代填遇到长回答时只用这里的短答；用了短答的报名不会自动提交，会停在提交前。")}</p>

    <h5>{t("短答")}</h5>
    {kit.answers.length === 0 && <p className="muted">{t("还没有短答，比如「一句话介绍自己」「为什么想参加」。")}</p>}
    {kit.answers.map((item) => <div className="st-row" key={item.id}>
      <span className="st-row-label">{item.prompt}<small>{item.text.length > 120 ? `${item.text.slice(0, 120)}…` : item.text}</small></span>
      <span className="st-inline-form">
        <button type="button" className="secondary-button" onClick={() => setAnswer({ id: item.id, prompt: item.prompt, text: item.text })}>{t("修改")}</button>
        <button type="button" className="text-button" onClick={() => void send({ op: "remove_answer", id: item.id })}>{t("删除")}</button>
      </span>
    </div>)}
    {answer
      ? <div className="st-kit-form">
        <input aria-label={t("问题")} placeholder={t("问题，例如：为什么想参加")} value={answer.prompt} onChange={(event) => setAnswer({ ...answer, prompt: event.target.value })} />
        <textarea aria-label={t("回答")} rows={4} maxLength={4000} value={answer.text} onChange={(event) => setAnswer({ ...answer, text: event.target.value })} />
        <span className="st-inline-form">
          <button type="button" className="secondary-button" onClick={() => void send({ op: "answer", ...answer })}>{t("保存")}</button>
          <button type="button" className="text-button" onClick={() => setAnswer(undefined)}>{t("取消")}</button>
        </span>
      </div>
      : <button type="button" className="text-button" onClick={() => setAnswer({ prompt: "", text: "" })}>{t("添加短答")}</button>}

    <h5>{t("文件")}</h5>
    {kit.documents.length === 0 && <p className="muted">{t("还没有文件，比如简历、成绩单。")}</p>}
    {kit.documents.map((item) => <div className="st-row" key={item.id}>
      <span className="st-row-label">{t(KIT_DOCUMENT_LABEL[item.kind])} · {item.label}<small>{item.path}</small></span>
      <span className="st-inline-form">
        <button type="button" className="secondary-button" onClick={() => setDoc({ id: item.id, kind: item.kind, label: item.label, path: item.path })}>{t("修改")}</button>
        <button type="button" className="text-button" onClick={() => void send({ op: "remove_document", id: item.id })}>{t("删除")}</button>
      </span>
    </div>)}
    {doc
      ? <div className="st-kit-form">
        <select aria-label={t("文件类型")} value={doc.kind} onChange={(event) => setDoc({ ...doc, kind: event.target.value as KitDocumentKind })}>
          {KIT_DOCUMENT_KINDS.map((kind) => <option key={kind} value={kind}>{t(KIT_DOCUMENT_LABEL[kind])}</option>)}
        </select>
        <input aria-label={t("名称")} placeholder={t("名称，例如：2026 秋简历")} value={doc.label} onChange={(event) => setDoc({ ...doc, label: event.target.value })} />
        <input aria-label={t("本机路径")} placeholder={t("本机路径")} value={doc.path} onChange={(event) => setDoc({ ...doc, path: event.target.value })} />
        <span className="st-inline-form">
          <button type="button" className="secondary-button" onClick={() => void send({ op: "document", ...doc })}>{t("保存")}</button>
          <button type="button" className="text-button" onClick={() => setDoc(undefined)}>{t("取消")}</button>
        </span>
      </div>
      : <button type="button" className="text-button" onClick={() => setDoc({ kind: "resume", label: "", path: "" })}>{t("添加文件")}</button>}

    {kit.history.length > 0 && <details className="st-kit-history"><summary>{t("版本记录（{{count}}）", { count: kit.history.length })}</summary>
      <ol reversed>{[...kit.history].reverse().slice(0, 20).map((item) => <li key={item.version}>v{item.version} · {item.at.slice(0, 10)} · {item.change}</li>)}</ol>
    </details>}
    {note && <small role="alert">{note}</small>}
  </div>;
}
