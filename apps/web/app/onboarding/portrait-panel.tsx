"use client";

import { lineAttributes, type StoredLineProfile } from "@crossline/core";
import { AttributePicker } from "../ui/attribute-picker";

export type ProfileModelView = {
  portrait: string; coreConflict: string; problem: string; gravity: string[]; designable: string[]; reframes: Array<{ fallacy: string; reframe: string }>;
  workView: string; lifeView: string; consistency: string; trueNorth: string;
  energyMap: Array<{ activity: string; skill: "high" | "low"; love: "high" | "low"; charge: "charge" | "drain" }>;
  flow: string[]; says: string; does: string; anchor: string; realWant: string; allocation: string;
};
export type LineView = { id: string; label: string; rank: number | null; hard: boolean; goals: string[]; goalParts: string[] };

export const STAGES: Array<[string, string]> = [["orientation", "开场与规则"], ["lines", "主线"], ["situation", "现状"], ["compass", "指南针"], ["energy", "能量"], ["details", "细节"]];

/** Where the interview is, as a row of stages. */
export function StageBar({ stage, line }: { stage: string; line?: string | undefined }) {
  if (line) return <ol className="ob-stages"><li data-state="current">{line} · 细节</li></ol>;
  const at = Math.max(0, STAGES.findIndex(([id]) => id === stage));
  return <ol className="ob-stages" aria-label="访谈阶段">{STAGES.map(([id, label], index) =>
    <li key={id} data-state={index < at ? "done" : index === at ? "current" : "next"}>{label}</li>)}</ol>;
}

/** The skill × liking map: four quadrants, each activity a chip coloured by whether it charges or drains. */
function EnergyMap({ items }: { items: ProfileModelView["energyMap"] }) {
  const cell = (skill: "high" | "low", love: "high" | "low", label: string) => <div className="ob-quad" data-q={`${skill}-${love}`}>
    <small>{label}</small>
    {items.filter((item) => item.skill === skill && item.love === love).map((item) => <span key={item.activity} className="ob-energy" data-charge={item.charge}>{item.activity}</span>)}
  </div>;
  return <div className="ob-quads" aria-label="能量地图：擅长 × 热爱">
    {cell("high", "high", "擅长且热爱")}{cell("low", "high", "热爱、尚不擅长")}{cell("high", "low", "擅长、不热爱")}{cell("low", "low", "既不擅长也不热爱")}
  </div>;
}

/**
 * What the interview has understood about the person so far, kept beside the conversation: the portrait and core conflict, the problem
 * split into gravity and design, the compass, the energy map, and for each line its description and the attribute candidates its long-term
 * goal is built from (「成为 A 的、B 的<身份>」, §4.1): picked, ordered, reworded and adopted in one place.
 */
export function PortraitPanel({ profile, lines, lineProfiles, onChanged }: {
  profile: ProfileModelView | null; lines: LineView[];
  lineProfiles: Record<string, StoredLineProfile>; onChanged: () => void;
}) {
  const saveGoals = async (line: LineView, goals: string[]) => {
    const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: line.id, goals }) }).catch(() => null);
    if (response?.ok) onChanged();
  };
  /** 「采用」 on the attribute picker: the parts in order become the line's goal (the composed sentence is `goals[0]`). */
  const adoptParts = async (line: LineView, goalParts: string[]) => {
    const response = await fetch("/api/lines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: line.id, goalParts }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { message?: string } | null;
    if (!response?.ok) return body?.message ?? "未保存，请重试";
    onChanged();
    return "";
  };
  const has = (value: string | unknown[] | undefined) => Array.isArray(value) ? value.length > 0 : Boolean(value);
  return <section className="ob-portrait" aria-label="实时画像">
    {profile && has(profile.portrait) && <div className="ob-portrait-head"><p className="gen ob-portrait-line">{profile.portrait}</p>
      {has(profile.coreConflict) && <p className="gen"><b>核心矛盾</b> {profile.coreConflict}</p>}</div>}
    {profile && (has(profile.gravity) || has(profile.designable)) && <div className="ob-two">
      <div><h4>需要接受的现实</h4><ul>{profile.gravity.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
      <div><h4>可以设计的问题</h4><ul>{profile.designable.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
    </div>}
    {profile && has(profile.reframes) && <ul className="ob-reframes">{profile.reframes.map((item) => <li key={item.fallacy}>
      <s className="gen">{item.fallacy}</s><span aria-hidden="true">→</span><span className="gen">{item.reframe}</span></li>)}</ul>}
    {profile && (has(profile.workView) || has(profile.lifeView)) && <dl className="ob-compass">
      {has(profile.workView) && <div><dt>工作观</dt><dd className="gen">{profile.workView}</dd></div>}
      {has(profile.lifeView) && <div><dt>人生观</dt><dd className="gen">{profile.lifeView}</dd></div>}
      {has(profile.trueNorth) && <div><dt>正北</dt><dd className="gen">{profile.trueNorth}</dd></div>}
    </dl>}
    {profile && has(profile.energyMap) && <EnergyMap items={profile.energyMap} />}
    <div className="ob-lines">{lines.map((line) => {
      const drawn = lineProfiles[line.id];
      const candidates = lineAttributes(drawn, line.label).map(({ text, kind }) => ({ text, kind }));
      return <article key={line.id} className="ob-line" data-line={line.id}>
        <header><b>{line.label}</b>{line.hard && <span className="tag">硬约束</span>}<small className="mono">{line.rank ? line.rank === 1 ? "底座" : `第 ${line.rank}` : "平行"}</small></header>
        {drawn?.description && <p className="gen">{drawn.description}</p>}
        {line.goals.length > 0 && <ul className="ob-goals">{line.goals.map((goal) => <li key={goal}>{goal}
          <button type="button" aria-label="移除该长期目标" onClick={() => void saveGoals(line, line.goals.filter((item) => item !== goal))}>×</button></li>)}</ul>}
        {(candidates.length > 0 || line.goalParts.length > 0) && <AttributePicker key={`${line.goalParts.join("|")}:${candidates.length}`} noun={line.label}
          candidates={candidates} initial={line.goalParts} onAdopt={(parts) => adoptParts(line, parts)} />}
      </article>;
    })}</div>
  </section>;
}
