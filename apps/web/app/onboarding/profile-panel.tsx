"use client";

import { useState } from "react";
import type { Fact } from "./onboarding-types";

const SLOT_LABEL: Record<string, string> = {
  what: "在做什么", for_whom: "为谁", stage: "阶段", goal: "目标", deadline: "截止", blockers: "卡点",
  collaborators: "合作者", evidence: "进展证据", local_assets: "已有资料", weekly_hours: "每周时间", tools: "工具",
  no_deadline: "截止", grading: "评分", target_grade: "目标成绩", meetings: "上课时间", priority: "优先级", constraint: "约束",
  work_view: "工作观", life_view: "人生观", true_north: "方向", values: "价值观", flow: "心流", energy: "精力", schedule: "作息"
};
const SLOT_PREFIX: Array<[string, string]> = [["flywheel_", "线间关系"], ["date_", "日期"], ["step_answer_", "回答"], ["deadline_", "截止"]];
/** A slot is the model's key, never shown as such: a known one gets its name, anything else a neutral 「备注」. */
export const slotLabel = (slot: string) => SLOT_LABEL[slot] ?? SLOT_PREFIX.find(([prefix]) => slot.startsWith(prefix))?.[1] ?? "备注";
export function FactList({ facts, onChange }: { facts: Fact[]; onChange: (body: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const key = (fact: Fact) => `${fact.projectId}|${fact.slot}`;
  return <dl className="ob-facts">
    {facts.map((fact) => <div key={key(fact)} data-status={fact.status}>
      <dt>{slotLabel(fact.slot)}</dt>
      <dd>
        {editing === key(fact)
          ? <form onSubmit={(event) => {
              event.preventDefault();
              void onChange({ action: "confirm_fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot, value: draft });
              setEditing(undefined);
            }}><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" className="ob-btn">保存</button></form>
          : <>
              <button type="button" className="ob-text" title="点击修改" onClick={() => { setEditing(key(fact)); setDraft(fact.value); }}>{fact.value}</button>
              {fact.status === "inferred" && <span className="ob-actions">
                <span className="ob-tag" data-kind="inferred">推断</span>
                <button type="button" className="ob-btn" aria-label={`确认${slotLabel(fact.slot)}`} onClick={() => void onChange({ action: "confirm_fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot })}>确认</button>
                <button type="button" className="ob-btn ob-quiet" aria-label={`去掉${slotLabel(fact.slot)}`} onClick={() => void onChange({ action: "remove_fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot })}>去掉</button>
              </span>}
            </>}
      </dd>
    </div>)}
  </dl>;
}
