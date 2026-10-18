"use client";

import { useState } from "react";
import type { Fact } from "./onboarding-types";

const SLOT_LABEL: Record<string, string> = {
  what: "在做什么", for_whom: "为谁", stage: "阶段", goal: "目标", deadline: "截止", blockers: "卡点",
  collaborators: "合作者", evidence: "进展证据", local_assets: "已有资料", weekly_hours: "每周时间", tools: "工具",
  no_deadline: "截止", grading: "评分", target_grade: "目标成绩", meetings: "上课时间", meeting_time: "上课时间", meeting_times: "上课时间", priority: "优先级", constraint: "约束",
  work_view: "工作观", life_view: "人生观", true_north: "方向", values: "价值观", flow: "心流", energy: "精力", schedule: "作息"
};
// About the person (`identityId: "person"`): the keys the interview writes most.
const PERSON_LABEL: Record<string, string> = {
  name: "称呼", nickname: "称呼", city: "所在城市", location: "所在地", timezone: "时区", age: "年龄", gender: "性别", hairstyle: "发型",
  clothing_preference: "穿着", appearance: "外形", appearance_skipped: "外形", school: "学校", major: "专业", degree: "学历", education: "教育",
  occupation: "职业", job: "工作", role: "角色", company: "公司", advisor: "导师", language: "语言", mbti: "自评类型", strengths: "长处",
  weaknesses: "短板", hobbies: "爱好", family: "家庭", health: "健康", sleep: "睡眠", character: "形象"
};
const SLOT_PREFIX: Array<[string, string]> = [["flywheel_", "线间关系"], ["date_", "日期"], ["step_answer_", "回答"], ["deadline_", "截止"],
  ["undated_", "待定日期"], ["gap_", "补充回答"]];
// A key the tables do not name is read by its words (「work_experience」 → 经历): every fact used to read 「备注」 (W-7).
const SLOT_WORDS: Array<[RegExp, string]> = [
  [/(^|_)(experience|history|background|career)(_|$)/, "经历"], [/(^|_)(goal|target|aim|ambition)s?(_|$)/, "目标"],
  [/(^|_)(deadline|due)(_|$)/, "截止"], [/(^|_)(meeting|class|lecture|schedule|routine)s?(_|$)/, "固定日程"],
  [/(^|_)(grade|grading|score|exam|midterm|final)s?(_|$)/, "成绩与考试"], [/(^|_)(evidence|progress|users?|traction)(_|$)/, "进展"],
  [/(^|_)(skill|strength|ability|abilities)s?(_|$)/, "能力"], [/(^|_)(value|belief|view)s?(_|$)/, "观念"],
  [/(^|_)(energy|flow|sleep|rest)(_|$)/, "精力"], [/(^|_)(hours|time|availability)(_|$)/, "时间"],
  [/(^|_)(constraint|limit|risk|blocker)s?(_|$)/, "约束"], [/(^|_)(tool|software|stack)s?(_|$)/, "工具"],
  [/(^|_)(income|money|budget|fund|funding|investment|portfolio)s?(_|$)/, "资金"], [/(^|_)(position|positioning|audience|market)(_|$)/, "定位"],
  [/(^|_)(advisor|mentor|partner|cofounder|collaborator|team)s?(_|$)/, "合作者"], [/(^|_)(project|course|product|channel)s?(_|$)/, "项目"],
  [/(^|_)(city|country|location|place)(_|$)/, "所在地"], [/(^|_)(school|university|major|degree|education)(_|$)/, "教育"],
  [/(^|_)(appearance|hair|clothing|outfit|look)(_|$)/, "外形"], [/(^|_)(priority|priorities|preference)(_|$)/, "偏好"]
];
/** A slot is the model's key, never shown as such: a known one gets its name, else what its words say, else 「其他」. */
export const slotLabel = (slot: string) => SLOT_LABEL[slot] ?? PERSON_LABEL[slot] ?? SLOT_PREFIX.find(([prefix]) => slot.startsWith(prefix))?.[1]
  ?? SLOT_WORDS.find(([pattern]) => pattern.test(slot.toLowerCase()))?.[1] ?? "其他";
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
