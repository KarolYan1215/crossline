"use client";

import { useState } from "react";
import { Tag } from "../ui/tag";
import { useT } from "../locale-context";

type Knob = { id: string; label: string; unit: string; min: number; max: number; default: number; consequence: string; value: number; changed: boolean; paused: boolean };
type Note = { id: string; label: string; text: string; paused: boolean; at: string };
type Preview = { kind: "knob" | "skill"; id: string; value: string; view: { label: string; from: string; to: string; consequence: string } };

const post = (body: unknown) => fetch("/api/design", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, body: await response.json().catch(() => ({})) as { message?: string; view?: Preview["view"] } }))
  .catch(() => ({ ok: false, body: {} as { message?: string; view?: Preview["view"] } }));

/**
 * 我的设计 (apps/web/lib/personal-design.ts): the rules' thresholds the person may set and the standing words they gave a Skill. Every
 * change is previewed (当前 → 改成 and what follows) before it is saved, and each saved change can be undone like any operation.
 */
export function DesignCard({ knobs, notes, skills }: { knobs: Knob[]; notes: Note[]; skills: Array<{ id: string; label: string }> }) {
  const t = useT();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview>();
  const [message, setMessage] = useState("");
  const [skill, setSkill] = useState(skills[0]?.id ?? "");
  const ask = async (kind: Preview["kind"], id: string, value: string) => {
    setMessage("");
    const result = await post({ kind, id, value, preview: true });
    if (!result.ok || !result.body.view) { setMessage(result.body.message ?? t("预览失败，请稍后重试")); return; }
    setPreview({ kind, id, value, view: result.body.view });
  };
  const confirm = async () => {
    if (!preview) return;
    const result = await post({ kind: preview.kind, id: preview.id, value: preview.value });
    setPreview(undefined);
    setMessage(result.ok ? t("已保存，可在待确认的「最近自动生效」里撤销") : result.body.message ?? t("保存失败"));
    if (result.ok) { setDraft({}); location.reload(); }
  };
  const pause = async (kind: Preview["kind"], id: string, paused: boolean) => {
    const result = await post({ kind, id, pause: paused });
    if (result.ok) location.reload(); else setMessage(t("保存失败"));
  };
  return <div className="st-modules">
    <section className="st-card st-card-wide" aria-label={t("规则阈值")}>
      <header><h3>{t("规则阈值")}</h3><small>{t("改动先预览，确认后生效；暂停后回到系统默认")}</small></header>
      <ul className="st-design">{knobs.map((knob) => <li key={knob.id}>
        <span className="st-row-label">{t(knob.label)}<small>{t(knob.consequence)}</small></span>
        <span className="st-design-value">
          <input type="number" min={knob.min} max={knob.max} aria-label={t(knob.label)} value={draft[knob.id] ?? String(knob.value)}
            onChange={(event) => setDraft({ ...draft, [knob.id]: event.target.value })} /> {t(knob.unit)}
          <small>{t("范围 {{min}}–{{max}}，默认 {{value}}", { min: knob.min, max: knob.max, value: knob.default })}</small>
        </span>
        {knob.paused && <Tag>{t("已暂停")}</Tag>}
        <span className="st-design-actions">
          <button type="button" className="ui-button" disabled={!draft[knob.id] || draft[knob.id] === String(knob.value)}
            onClick={() => void ask("knob", knob.id, draft[knob.id] ?? "")}>{t("预览")}</button>
          {knob.changed && <button type="button" className="ui-button" onClick={() => void pause("knob", knob.id, !knob.paused)}>{knob.paused ? t("恢复") : t("暂停")}</button>}
          {knob.changed && <button type="button" className="ui-button" onClick={() => void ask("knob", knob.id, "")}>{t("恢复默认")}</button>}
        </span>
      </li>)}</ul>
    </section>
    <section className="st-card st-card-wide" aria-label={t("给各环节的本人指令")}>
      <header><h3>{t("给各环节的本人指令")}</h3><small>{t("之后这一环节的每次运行都会读到；安全规则和输出格式不受影响")}</small></header>
      {notes.length > 0 && <ul className="st-design">{notes.map((note) => <li key={note.id}>
        <span className="st-row-label">{t(note.label)}{note.paused && <> <Tag>{t("已暂停")}</Tag></>}</span>
        <textarea aria-label={t(note.label)} maxLength={600} value={draft[`skill:${note.id}`] ?? note.text}
          onChange={(event) => setDraft({ ...draft, [`skill:${note.id}`]: event.target.value })} />
        <span className="st-design-actions">
          <button type="button" className="ui-button" disabled={!draft[`skill:${note.id}`] || draft[`skill:${note.id}`] === note.text}
            onClick={() => void ask("skill", note.id, draft[`skill:${note.id}`] ?? "")}>{t("预览")}</button>
          <button type="button" className="ui-button" onClick={() => void pause("skill", note.id, !note.paused)}>{note.paused ? t("恢复") : t("暂停")}</button>
          <button type="button" className="ui-button" onClick={() => void ask("skill", note.id, "")}>{t("删除")}</button>
        </span>
      </li>)}</ul>}
      <div className="st-design-add">
        <select aria-label={t("环节")} value={skill} onChange={(event) => setSkill(event.target.value)}>
          {skills.map((item) => <option key={item.id} value={item.id}>{t(item.label)}</option>)}
        </select>
        <textarea aria-label={t("新指令")} maxLength={600} placeholder={t("例如：教程先给结论，再给步骤")} value={draft["skill:new"] ?? ""}
          onChange={(event) => setDraft({ ...draft, "skill:new": event.target.value })} />
        <button type="button" className="ui-button" disabled={!draft["skill:new"]?.trim()} onClick={() => void ask("skill", skill, draft["skill:new"] ?? "")}>{t("预览")}</button>
      </div>
    </section>
    {preview && <section className="st-card st-card-wide st-design-preview" role="dialog" aria-label={t("确认改动")}>
      <header><h3>{preview.view.label}</h3></header>
      <p>{t("当前")}：{preview.view.from}</p>
      <p>{t("改成")}：{preview.view.to}</p>
      <p className="st-note">{preview.view.consequence}</p>
      <span className="st-design-actions">
        <button type="button" className="ui-button primary" onClick={() => void confirm()}>{t("确认")}</button>
        <button type="button" className="ui-button" onClick={() => setPreview(undefined)}>{t("取消")}</button>
      </span>
    </section>}
    {message && <p role="status" className="st-note">{message}</p>}
  </div>;
}
