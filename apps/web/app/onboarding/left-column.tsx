"use client";

import { useState } from "react";
import { lineAttributes } from "@crossline/core";
import { AttributePicker, type AttributeOption } from "../ui/attribute-picker";
import { CalendarSubscriptions } from "../connectors/calendar-subscriptions";
import { SourceFolders } from "../connectors/source-folders";
import { FolderPicker } from "./folder-picker";
import { FactList } from "./profile-panel";
import { QuestionCard } from "./question-card";
import type { Answer, DocumentRow, OnboardingState, Question } from "./onboarding-types";

/**
 * The interview's left column (docs/onboarding-v3.md, decided 2026-10-14): what goes in and what is decided beside the conversation —
 * the person's materials and calendar, each line's long-term goal built from attributes, the facts recorded so far (correct or confirm in
 * place), and during a deep round the fact questions held back from it, answered here and sent with the next reply.
 */
const DOC_STATUS: Record<DocumentRow["extractionStatus"], string> = { pending: "读取中", done: "已读取", failed: "读取失败", unsupported: "无法读取文字" };

async function post(path: string, body: Record<string, unknown>): Promise<Response | undefined> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}

export function LeftColumn({ state, busy, accept, onUpload, onChanged, heldQuestions, answers, onAnswer }: {
  state: OnboardingState; busy: boolean; accept: string;
  onUpload: (files: FileList | File[]) => void; onChanged: () => void;
  /** Fact questions waiting while the round is a deep one; answered here, sent with the next reply. */
  heldQuestions: Question[]; answers: Record<string, Answer>; onAnswer: (id: string, answer: Answer) => void;
}) {
  const change = async (body: Record<string, unknown>) => { if ((await post("/api/profile", body))?.ok) onChanged(); };
  const adopt = async (lineId: string, goalParts: string[]) => {
    const response = await post("/api/lines", { id: lineId, goalParts });
    const body = await response?.json().catch(() => null) as { message?: string } | null;
    if (!response?.ok) return body?.message ?? "未保存，请重试";
    onChanged();
    return "";
  };
  const facts = state.facts.filter((fact) => !fact.slot.startsWith("flywheel_"));
  // Files from an authorized folder are summed up in its own card.
  const uploads = state.documents.filter((doc) => !doc.fromFolder);
  const confirmed = facts.filter((fact) => fact.status === "confirmed").length;
  return <aside className="ob-left" aria-label="材料与决定">
    <section className="ob-card" aria-label="材料与日历">
      <h3>材料与日历</h3>
      <label className="ob-drop">
        <input type="file" multiple accept={accept} hidden disabled={busy} onChange={(event) => { if (event.target.files) onUpload(event.target.files); event.target.value = ""; }} />
        <b>{busy ? "处理中…" : "添加文件或录音"}</b>
        <small>简历、课表、课程大纲、项目说明；也可以直接拖进页面</small>
      </label>
      <FolderPicker busy={busy} onUpload={onUpload} />
      {uploads.length > 0 && <ul className="ob-doclist">{uploads.map((doc) => <li key={doc.id} data-status={doc.extractionStatus}>
        <span>{doc.fileName}</span><small>{DOC_STATUS[doc.extractionStatus]}{doc.projectId ? ` · ${state.projects.find((project) => project.id === doc.projectId)?.name ?? ""}` : ""}</small>
      </li>)}</ul>}
      <SourceFolders onChanged={onChanged} />
      {/* Only the subscription link brings calendar events in: the ChatGPT connectors' card shows a status and imports nothing, and
          on the interview it sent an invitee off to connect Google for nothing (2026-10-15 walkthrough). It stays under 设置. */}
      <CalendarSubscriptions onChanged={onChanged} />
    </section>

    {heldQuestions.length > 0 && <section className="ob-card ob-voice" aria-label="待补充的事实">
      <h3>待补充的事实 <small>随下一次回答一起发送</small></h3>
      {heldQuestions.map((question) => <QuestionCard key={question.id} question={question} answer={answers[question.id] ?? { picked: [], other: "" }}
        identities={state.identities} projects={state.projects} disabled={busy} onChange={(next) => onAnswer(question.id, next)} />)}
    </section>}

    {state.lines.length > 0 && <section className="ob-card" aria-label="长期目标">
      <h3>长期目标</h3>
      {state.lines.map((line) => {
        const candidates = lineAttributes(state.lineProfiles[line.id], line.label).map(({ text, kind }) => ({ text, kind }));
        return <GoalCard key={line.id} line={line} candidates={candidates} onAdopt={(parts) => adopt(line.id, parts)} />;
      })}
    </section>}

    <section className="ob-card" aria-label="已记下的事实">
      <h3>已记下 <small>{confirmed} 条确认 · {facts.length - confirmed} 条推断</small></h3>
      {facts.length ? state.identities.map((identity) => {
        const own = facts.filter((fact) => fact.identityId === identity.id);
        return own.length ? <div key={identity.id} className="ob-fact-group" data-line={identity.id}><b>{identity.label}</b><FactList facts={own} onChange={change} /></div> : null;
      }) : <p className="ob-muted">回答后，这里列出记下的每一条，点击可以修改，推断的可以确认或去掉。</p>}
      {facts.some((fact) => fact.identityId === "person") && <div className="ob-fact-group"><b>关于本人</b>
        <FactList facts={facts.filter((fact) => fact.identityId === "person")} onChange={change} /></div>}
    </section>
  </aside>;
}

type GoalLine = OnboardingState["lines"][number];
/** An adopted goal stays one line with 修改; the picker opens only before one is chosen or when the person asks to change it. */
function GoalCard({ line, candidates, onAdopt }: { line: GoalLine; candidates: AttributeOption[]; onAdopt: (parts: string[]) => Promise<string> }) {
  const [editing, setEditing] = useState(false);
  const adopted = Boolean(line.goals[0]);
  const picking = (!adopted || editing) && (candidates.length > 0 || line.goalParts.length > 0);
  return <article className="ob-goal" data-line={line.id}>
    <b>{line.label}</b>
    {adopted ? <p className="ob-goal-now">{line.goals[0]}</p> : <small className="ob-muted">{candidates.length ? "选几项拼成长期目标，再点采用" : "访谈谈到这条主线后给出候选"}</small>}
    {adopted && !editing && candidates.length > 0 && <button type="button" className="ob-btn ob-quiet" onClick={() => setEditing(true)}>修改</button>}
    {picking && <AttributePicker key={`${line.goalParts.join("|")}:${candidates.length}`} noun={line.label} candidates={candidates}
      initial={line.goalParts} onAdopt={async (parts) => { const error = await onAdopt(parts); if (!error) setEditing(false); return error; }} />}
  </article>;
}
