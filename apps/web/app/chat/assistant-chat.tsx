"use client";

import { useEffect, useRef, useState } from "react";
import { Composer, type ComposerInput } from "./composer";

type Message = { from: "user" | "assistant"; text: string };
type AttachmentMeta = { id: string; fileName: string; mediaType: string };
type CaptureCard = { kind: "capture"; title: string; context: string };
type TemplateCard = { identityId: string; kind: string; titleHint: string; successCriteriaDefaults: unknown[] };
/** A change to the task in view, read out of what the person said; applied together on 应用 (and undoable). */
export type TaskOpCard = { type: string; date: string; minutes: number; stepId: string; text: string; who: string; energy: string; summary: string };
type TurnResponse =
  | { state: "replied"; reply: string; quickReplies: string[]; savedMaterial?: { uri: string; fileName: string };
      proposals?: CaptureCard[]; templateProposal?: TemplateCard; learned?: string[]; taskOps?: TaskOpCard[] }
  | { state: "blocked"; code: string; message: string }
  | { ok: false; blocker: { code: string; message: string } };

/**
 * The assistant's conversation, scoped: site-wide (the floating 小助手) or to one task (`workOrderId`, the task dialog's 对话 tab,
 * where the assistant sees that task first). The thread and its last 40 messages survive page loads in sessionStorage under
 * `storageKey`. Nothing the assistant proposes is written until the person clicks its card.
 */
export function AssistantChat({ workOrderId = null, storageKey, emptyText, mode = "chat", inputFirst = false, placeholder = "输入消息，@ 引用任务、里程碑或资料" }: {
  workOrderId?: string | null; storageKey: string; emptyText: string;
  /** `record`: the text is a note for the task's record, turned into operations rather than answered. */
  mode?: "chat" | "record";
  /** The task's own entry: the input box first, the conversation under it. */
  inputFirst?: boolean; placeholder?: string;
}) {
  const [threadId, setThreadId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Array<CaptureCard & { id: string; state: "new" | "saving" | "saved" | "failed" }>>([]);
  const [template, setTemplate] = useState<(TemplateCard & { state: "new" | "saving" | "saved" | "failed" }) | null>(null);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [ops, setOps] = useState<{ items: TaskOpCard[]; state: "new" | "saving" | "failed" } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { threadId?: string; messages?: Message[] } | null;
      if (saved?.threadId && /^[a-zA-Z0-9_-]{1,128}$/.test(saved.threadId)) setThreadId(saved.threadId);
      if (Array.isArray(saved?.messages)) setMessages(saved!.messages.slice(-40));
    } catch { /* private browsing */ }
  }, [storageKey]);
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify({ threadId, messages: messages.slice(-40) })); } catch { /* best effort */ } }, [storageKey, threadId, messages]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [messages, status]);

  const uploadAttachments = async (files: File[]): Promise<AttachmentMeta[]> => {
    if (!files.length) return [];
    setUploading(true); setStatus("");
    try {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      const response = await fetch(`/api/assistant/${encodeURIComponent(threadId)}/attachments`, { method: "POST", body: form });
      const body = await response.json().catch(() => null) as { saved?: AttachmentMeta[]; message?: string } | null;
      if (!response.ok || !body?.saved) { setStatus(body?.message ?? "附件上传失败，请重试"); return []; }
      return body.saved;
    } catch { setStatus("附件上传失败，请检查网络"); return []; }
    finally { setUploading(false); }
  };

  const sendMessage = async (text: string, attachments: AttachmentMeta[] = pendingAttachments) => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true); setStatus("");
    const history = messages.slice(-20);
    setMessages((current) => [...current, { from: "user", text: message }]);
    setQuickReplies([]);
    try {
      const response = await fetch("/api/assistant/turn", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, message, history, attachments, workOrderId, mode }) });
      const body = await response.json().catch(() => null) as TurnResponse | null;
      setPendingAttachments([]);
      if (!body || "blocker" in body) { setMessages((current) => [...current, { from: "assistant", text: `暂时无法回复：${body?.blocker.message ?? "小助手不可用"}` }]); return; }
      if (body.state === "blocked") { setMessages((current) => [...current, { from: "assistant", text: `暂时无法回复：${body.message}` }]); return; }
      setMessages((current) => [...current, { from: "assistant", text: body.reply }]);
      setQuickReplies(body.quickReplies ?? []);
      setCards((body.proposals ?? []).map((card) => ({ ...card, id: crypto.randomUUID(), state: "new" as const })));
      setTemplate(body.templateProposal ? { ...body.templateProposal, state: "new" } : null);
      setOps(body.taskOps?.length ? { items: body.taskOps, state: "new" } : null);
      if (body.savedMaterial) setStatus(`已保存为任务材料：${body.savedMaterial.fileName}`);
      else if (body.learned?.length) setStatus(`已记入个人偏好：${body.learned.join("；")}`);
    } catch { setMessages((current) => [...current, { from: "assistant", text: "网络不可用，消息未发送" }]); }
    finally { setSending(false); }
  };

  const captureCard = async (id: string) => {
    const card = cards.find((item) => item.id === id);
    if (!card || card.state === "saving" || card.state === "saved") return;
    setCards((current) => current.map((item) => item.id === id ? { ...item, state: "saving" } : item));
    const response = await fetch("/api/assistant/capture", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId: id, title: card.title, context: card.context }) }).catch(() => null);
    setCards((current) => current.map((item) => item.id === id ? { ...item, state: response?.ok ? "saved" : "failed" } : item));
  };
  const addTemplate = async () => {
    if (!template || template.state === "saving" || template.state === "saved") return;
    setTemplate({ ...template, state: "saving" });
    const { state: _state, ...input } = template;
    void _state;
    const response = await fetch("/api/milestones/templates", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, source: "assistant" }) }).catch(() => null);
    setTemplate({ ...template, state: response?.ok ? "saved" : "failed" });
  };
  const applyOps = async () => {
    if (!ops || !workOrderId || ops.state === "saving") return;
    setOps({ ...ops, state: "saving" });
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/ops`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops: ops.items }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { ok?: boolean; failed?: string[] } | null;
    if (response?.ok && body?.ok) { location.reload(); return; }
    setOps({ ...ops, state: "failed" });
    setStatus(body?.failed?.length ? `未应用：${body.failed.join("；")}` : "未能应用，请重试");
  };
  // Files go up first; a linked task, milestone or material travels as a reference line the assistant reads with the message.
  const submit = async ({ text, files, mentions }: ComposerInput): Promise<boolean> => {
    const uploaded = files.length ? await uploadAttachments(files) : [];
    const references = mentions.length ? `\n引用：${mentions.map((item) => `${{ material: "资料", task: "任务", milestone: "里程碑" }[item.kind]}「${item.title}」(${item.id})`).join("；")}` : "";
    const message = `${text || (uploaded.length ? "见附件" : "")}${references}`;
    if (!message.trim()) return false;
    void sendMessage(message, [...pendingAttachments, ...uploaded]);
    return true;
  };

  const composer = <Composer mode="chat" busy={sending || uploading} name="message" placeholder={placeholder} onSubmit={submit}>
    {status && <small className="muted" role="status">{status}</small>}
  </Composer>;
  return <div className="assistant-chat" data-input-first={inputFirst || undefined}>
    {inputFirst && composer}
    <div className="assistant-messages">
      {!messages.length && emptyText && <p className="muted assistant-empty">{emptyText}</p>}
      {messages.map((item, index) => <p key={index} className={`assistant-message assistant-message-${item.from}${item.from === "assistant" ? " gen" : ""}`}>{item.text}</p>)}
      {cards.map((card) => <div key={card.id} className="assistant-card" role="group" aria-label="建议收集">
        <span className="gen">{card.title}</span>
        <button type="button" className="secondary-button" disabled={card.state === "saving" || card.state === "saved"} onClick={() => void captureCard(card.id)}>
          {card.state === "saved" ? "已收集" : card.state === "saving" ? "收集中…" : card.state === "failed" ? "重试" : "收集"}</button>
      </div>)}
      {template && <div className="assistant-card" role="group" aria-label="建议的里程碑模板">
        <span className="gen">里程碑模板：{template.titleHint}</span>
        <button type="button" className="secondary-button" disabled={template.state === "saving" || template.state === "saved"} onClick={() => void addTemplate()}>
          {template.state === "saved" ? "已添加" : template.state === "saving" ? "添加中…" : template.state === "failed" ? "重试" : "添加"}</button>
      </div>}
      {ops && <div className="assistant-card assistant-ops" role="group" aria-label="待应用的任务操作">
        <ul>{ops.items.map((item, index) => <li key={index} className="gen">{item.summary}</li>)}</ul>
        <span className="assistant-ops-actions">
          <button type="button" className="primary-button" disabled={ops.state === "saving"} onClick={() => void applyOps()}>{ops.state === "saving" ? "应用中…" : ops.state === "failed" ? "重试" : "应用"}</button>
          <button type="button" className="secondary-button" onClick={() => setOps(null)}>忽略</button>
        </span>
      </div>}
      <div ref={endRef} />
    </div>
    {quickReplies.length > 0 && <div className="assistant-quick-replies">
      {quickReplies.map((reply) => <button key={reply} type="button" className="secondary-button" onClick={() => void sendMessage(reply)}>{reply}</button>)}
    </div>}
    {!inputFirst && composer}
  </div>;
}
