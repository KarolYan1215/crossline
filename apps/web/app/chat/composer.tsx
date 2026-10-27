"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useAttachmentDrop } from "../attachment-drop";
import { MenuButton } from "../ui/controls";

export type Mention = { kind: "material" | "task" | "milestone" | "goal"; id: string; title: string };
export type ComposerInput = { text: string; files: File[]; mentions: Mention[]; batch: boolean };
const KIND_LABEL: Record<Mention["kind"], string> = { material: "资料", task: "任务", milestone: "里程碑", goal: "长期目标" };
/**
 * An `@` being typed at the end of the text, and the words after it. It may follow any character but a letter, digit or one that
 * makes an email address (「name@site」 is not a mention): Chinese is written without spaces, and requiring one before `@` meant
 * 「看看@作业」 never opened the list (2026-10-15).
 */
export const MENTION_AT = /(^|[^A-Za-z0-9._%+-])@([^\s@]*)$/;
const ACCEPTED ="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.md,.csv,.txt,.docx";

/**
 * The one input box, for 快速收集 and 小帮手 alike, laid out like the chat products people already know: a ＋ menu on the left (files,
 * existing materials, batch input, a task or milestone to link), the text in the middle, send on the right. Pasting and dropping files
 * work anywhere on it; typing `@` searches materials, tasks and milestones and turns the choice into a chip. Enter sends, Shift+Enter
 * starts a new line.
 */
/**
 * A textarea as tall as what it holds — the hint included while it is empty — up to 220px. `field-sizing: content` (composer.css) does
 * this where the browser has it; elsewhere the hint is measured by putting it in the box for a moment.
 */
export function fitTextarea(el: HTMLTextAreaElement | null) {
  if (!el || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
  el.style.height = "auto";
  const empty = !el.value;
  if (empty) el.value = el.placeholder;
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  if (empty) el.value = "";
}

/** Width under which the box shows its short hint: a phone held upright. */
const NARROW_HINT = "(max-width: 480px)";

/** The hint to show: the short one on a narrow screen, where the long one took three lines (2026-10-21 walkthrough). */
export function hintFor(placeholder: string, short: string | undefined, narrow: boolean): string {
  return narrow && short ? short : placeholder;
}

function useNarrow(query: string): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return narrow;
}

export function Composer({ mode, placeholder, shortPlaceholder, onSubmit, busy = false, children, name = "title", takeShare = false }: {
  mode: "capture" | "chat"; placeholder: string; busy?: boolean; name?: string;
  /** A shorter hint for a phone; the long one stays the box's accessible name. */
  shortPlaceholder?: string;
  /** Fill the box from a share-sheet arrival (`share_title`/`share_text`/`share_url` on the address, see the manifest). */
  takeShare?: boolean;
  /** Returns true when the input was taken (the box then clears). */
  onSubmit: (input: ComposerInput) => Promise<boolean>;
  /** Status and results shown under the box. */
  children?: ReactNode;
}) {
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [batch, setBatch] = useState(false);
  const [picker, setPicker] = useState<{ query: string; kind?: Mention["kind"] | "linkable"; fromAt: boolean } | null>(null);
  const [results, setResults] = useState<Mention[]>([]);
  // 「无匹配」 only once the answer for what is typed now is in; before that the list says it is searching.
  const [searching, setSearching] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const hint = hintFor(placeholder, shortPlaceholder, useNarrow(NARROW_HINT));
  // Neither what is typed nor the hint may be cut off on a narrow phone: fit on every change, on mount and when the width changes.
  useEffect(() => {
    const el = textRef.current;
    fitTextarea(el);
    const refit = () => fitTextarea(el);
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, [text, hint]);
  const { fileInputRef, fileNames, dragOver, setDragOver, onDrop, onPaste, onInputChange, reset } = useAttachmentDrop(ACCEPTED.split(","));

  useEffect(() => {
    if (!takeShare) return;
    const params = new URLSearchParams(location.search);
    // 「记一下」 from the installed app's shortcuts: the box, ready to type in.
    if (params.get("focus") === "input") { history.replaceState(null, "", location.pathname); textRef.current?.focus(); return; }
    const shared = [params.get("share_title"), params.get("share_text"), params.get("share_url")].map((part) => part?.trim()).filter(Boolean);
    if (!shared.length) return;
    setText([...new Set(shared)].join(" "));
    history.replaceState(null, "", location.pathname);
    textRef.current?.focus();
  }, [takeShare]);

  useEffect(() => {
    if (!picker) return;
    const controller = new AbortController();
    // 「linkable」 is asked of the server: filtering files out here, after the server had cut the list, left nothing once files filled it.
    const kind = picker.kind ? `&kind=${picker.kind}` : "";
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/mentions?q=${encodeURIComponent(picker.query)}${kind}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : { results: [] })
        .then((body: { results?: Mention[] }) => { setResults(body.results ?? []); setSearching(false); })
        .catch(() => { if (!controller.signal.aborted) { setResults([]); setSearching(false); } });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [picker]);

  const choose = (item: Mention) => {
    setMentions((list) => list.some((m) => m.kind === item.kind && m.id === item.id) ? list : [...list, item]);
    if (picker?.fromAt) setText((value) => value.replace(MENTION_AT, (whole, before: string) => before));
    setPicker(null);
    textRef.current?.focus();
  };
  const onChange = (value: string) => {
    setText(value);
    const at = MENTION_AT.exec(value);
    setPicker(at ? { query: at[2]!, fromAt: true } : picker?.fromAt ? null : picker);
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || (!text.trim() && !fileNames.length)) return;
    const files = [...(fileInputRef.current?.files ?? [])];
    if (await onSubmit({ text: text.trim(), files, mentions, batch })) { setText(""); setMentions([]); setBatch(false); reset(); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker && event.key === "Escape") { setPicker(null); return; }
    // Enter while an input method is composing confirms the characters, not the first result.
    if (picker && event.key === "Enter" && results[0] && !event.nativeEvent.isComposing) { event.preventDefault(); choose(results[0]); return; }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };
  const menu = [
    { label: "上传文件", hint: "PDF、Word、文本、图片", onSelect: () => fileInputRef.current?.click() },
    { label: "从已有资料中选", hint: "已上传的文件", onSelect: () => setPicker({ query: "", kind: "material", fromAt: false }) },
    ...(mode === "capture" ? [{ label: batch ? "取消批量输入" : "批量输入", hint: "多项内容由 AI 拆分", onSelect: () => setBatch((value) => !value) }] : []),
    { label: "关联任务或里程碑", hint: "也可输入 @", onSelect: () => setPicker({ query: "", kind: "linkable", fromAt: false }) }
  ];

  return <form className={`composer${dragOver ? " dragging" : ""}`} data-mode={mode} onSubmit={(event) => void submit(event)} onPaste={onPaste}
    onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
    <div className="composer-box">
      <MenuButton label="添加" icon="＋" items={menu} />
      <div className="composer-main">
        {(mentions.length > 0 || fileNames.length > 0 || batch) && <div className="composer-chips">
          {batch && <span className="composer-chip" data-kind="batch">批量 · AI 拆分 <button type="button" aria-label="取消批量" onClick={() => setBatch(false)}>×</button></span>}
          {mentions.map((item) => <span key={`${item.kind}:${item.id}`} className="composer-chip" data-kind={item.kind}>{KIND_LABEL[item.kind]} · {item.title}
            <button type="button" aria-label={`移除 ${item.title}`} onClick={() => setMentions((list) => list.filter((m) => m !== item))}>×</button></span>)}
          {fileNames.map((file) => <span key={file} className="composer-chip" data-kind="file">{file}</span>)}
          {fileNames.length > 0 && <button type="button" className="composer-clear" onClick={reset}>清除文件</button>}
        </div>}
        <textarea ref={textRef} name={name} rows={batch ? 4 : 1} value={text} maxLength={4000} placeholder={hint} aria-label={placeholder}
          onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown}
          onInput={(event) => fitTextarea(event.currentTarget)} />
      </div>
      <button type="submit" className="composer-send" disabled={busy || (!text.trim() && !fileNames.length)} aria-label="发送">{busy ? "…" : "↑"}</button>
      <input ref={fileInputRef} type="file" multiple accept={ACCEPTED} hidden onChange={onInputChange} name="attachments" />
    </div>
    {picker && <div className="composer-picker" role="listbox" aria-label="引用">
      {!picker.fromAt && <input autoFocus value={picker.query} placeholder="搜索" aria-label="搜索引用" onChange={(event) => setPicker({ ...picker, query: event.target.value })}
        onKeyDown={(event) => { if (event.key === "Escape") setPicker(null); if (event.key === "Enter") { event.preventDefault(); if (results[0]) choose(results[0]); } }} />}
      {results.length ? results.map((item) => <button key={`${item.kind}:${item.id}`} type="button" role="option" aria-selected="false" onClick={() => choose(item)}>
        <span className="composer-kind" data-kind={item.kind}>{KIND_LABEL[item.kind]}</span>{item.title}</button>)
        : <small className="muted">{searching ? "正在搜索…" : "无匹配"}</small>}
      <button type="button" className="composer-picker-close" onClick={() => setPicker(null)}>关闭</button>
    </div>}
    {children}
  </form>;
}
