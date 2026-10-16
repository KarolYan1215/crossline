"use client";

import { useState, type DragEvent } from "react";
import {
  ATTRIBUTE_KIND_LABEL, cleanAttribute, composeGoal, duplicateAttributes, guessKind, insertByKind, orderAttributes, type AttributeKind
} from "@crossline/core";
import "./attribute-picker.css";
import { useLocale, useT } from "../locale-context";

/** One attribute offered to choose from: its words and its kind (field, ability or lasting state). */
export type AttributeOption = { text: string; kind: AttributeKind };

/**
 * A line's long-term goal built from attributes (§4.1): the candidates as chips, any number chosen; a pick lands where Chinese puts that
 * kind of attributive (领域 → 能力 → 状态) without undoing an order the person dragged into place; each chosen one can be reworded before
 * adopting; and the sentence 「成为 A 的、B 的<身份>」 is previewed live. 「采用」 hands the parts, in order, to `onAdopt`.
 */
export function AttributePicker({ noun, candidates, initial, onAdopt, label = "长期目标的定语" }: {
  noun: string; candidates: AttributeOption[]; initial: string[]; label?: string;
  /** Saves the parts; resolves to an error message, or "" when saved. */
  onAdopt: (parts: string[]) => Promise<string>;
}) {
  const t = useT();
  const locale = useLocale();
  const [selected, setSelected] = useState<string[]>(initial);
  const [editing, setEditing] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [extra, setExtra] = useState<AttributeOption[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  // What is already chosen stays in the pool, so taking it out does not lose it.
  const pool = orderAttributes([...candidates, ...initial.map((text) => ({ text, kind: guessKind(text) })), ...extra].filter((item, index, list) => list.findIndex((other) => other.text === item.text) === index));
  const kindOf = (text: string) => pool.find((item) => item.text === text)?.kind ?? guessKind(text);
  const toggle = (text: string) => setSelected((list) => list.includes(text) ? list.filter((item) => item !== text) : insertByKind(list, text, kindOf));
  const move = (from: number, to: number) => setSelected((list) => {
    if (to < 0 || to >= list.length || from === to) return list;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  });
  const rename = (index: number, value: string) => setSelected((list) => list.map((item, i) => i === index ? value : item));
  const addCustom = () => {
    const text = cleanAttribute(custom);
    if (!text) return;
    setCustom("");
    if (!pool.some((item) => item.text === text)) setExtra((list) => [...list, { text, kind: guessKind(text) }]);
    setSelected((list) => list.includes(text) ? list : insertByKind(list, text, kindOf));
  };
  const parts = selected.map(cleanAttribute).filter(Boolean);
  const duplicate = duplicateAttributes(parts)[0];
  const unchanged = parts.length === initial.length && parts.every((part, index) => part === initial[index]);
  const preview = composeGoal(parts, noun, locale);
  const adopt = async () => {
    setStatus(t("保存中…"));
    const error = await onAdopt(parts);
    setStatus(error || t("已采用"));
  };
  const drop = (event: DragEvent, index: number) => { event.preventDefault(); event.stopPropagation(); if (dragging !== null) move(dragging, index); setDragging(null); };

  return <div className="attr-picker" aria-label={t(label)} role="group">
    <p className="attr-preview"><small className="muted">{t("预览")}</small>
      {preview ? <span className="gen">{preview}</span> : <span className="muted">{t("从下方选择定语，组成「成为 … 的{{noun}}」", { noun })}</span>}</p>
    {parts.length > 0 && <ol className="attr-selected" aria-label={t("已选定语，可拖动或用箭头调整顺序")}>
      {selected.map((text, index) => <li key={`${index}-${text}`} draggable={editing !== index} data-kind={kindOf(text)}
        onDragStart={(event) => { event.stopPropagation(); setDragging(index); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onDrop={(event) => drop(event, index)}>
        {editing === index
          ? <input value={text} maxLength={40} autoFocus aria-label={t("修改定语")} onChange={(event) => rename(index, event.target.value)}
              onBlur={() => setEditing(null)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setEditing(null); } }} />
          : <button type="button" className="attr-text gen" title={t("点击修改文字")} onClick={() => setEditing(index)}>{text}</button>}
        <span className="attr-moves">
          <button type="button" aria-label={t("「{{text}}」前移", { text })} disabled={index === 0} onClick={() => move(index, index - 1)}>←</button>
          <button type="button" aria-label={t("「{{text}}」后移", { text })} disabled={index === selected.length - 1} onClick={() => move(index, index + 1)}>→</button>
          <button type="button" aria-label={t("移除「{{text}}」", { text })} onClick={() => setSelected((list) => list.filter((_, i) => i !== index))}>×</button>
        </span>
      </li>)}
    </ol>}
    {pool.length > 0 && <div className="attr-pool" role="group" aria-label={t("定语候选，可多选")}>
      {pool.map((item) => <button key={item.text} type="button" className="attr-chip" aria-pressed={selected.includes(item.text)} data-kind={item.kind}
        onClick={() => toggle(item.text)}><small>{t(ATTRIBUTE_KIND_LABEL[item.kind])}</small><span className="gen">{item.text}</span></button>)}
    </div>}
    <div className="attr-add">
      <input value={custom} maxLength={40} placeholder={t("补充一个定语")} aria-label={t("补充一个定语")} onChange={(event) => setCustom(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustom(); } }} />
      <button type="button" className="text-button" disabled={!cleanAttribute(custom)} onClick={addCustom}>{t("添加")}</button>
    </div>
    {duplicate && <p className="attr-warning" role="alert">{t("「{{a}}」与「{{b}}」重复，保留一个", { a: duplicate[0], b: duplicate[1] })}</p>}
    <div className="attr-actions">
      <button type="button" className="primary-button" disabled={!parts.length || Boolean(duplicate) || unchanged} onClick={() => void adopt()}>{t("采用")}</button>
      {status && <small role="status">{status}</small>}
    </div>
  </div>;
}
