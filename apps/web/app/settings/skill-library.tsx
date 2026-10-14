"use client";

import { useState } from "react";
import { Markdown } from "../ui/markdown";
import { LineTag, Tag } from "../ui/tag";
import type { MineSkillView, PublicSkillView, SkillLibraryView } from "../../lib/skill-library";

const day = (iso: string) => iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "—";
const KIND = { play: "打法", preference: "偏好", redline: "红线" } as const;
const VERDICT = { usable: { label: "可用", tone: "ok" }, text_only: { label: "只用文字", tone: "warn" }, reject: { label: "拒绝", tone: "risk" } } as const;
const RULE = { net: "联网", delete: "删除", "delete.recursive": "删除", outside: "越出目录", "secret.path": "读取凭据", system: "改系统设置",
  "download.execute": "下载并执行", injection: "要求越权", "hidden.text": "隐藏文字" } as Record<string, string>;

/**
 * 设置 → Skill 库 (docs/skills-library.md §5). The person's own line skills: the one in force in full, where each rule came from, every
 * earlier version (回到此版 makes it a new version), and editing in place. The public skills: where each came from (repository, directory,
 * commit), its licence, what the scan and the review found, when a run last used it, and removing it.
 */
export function SkillLibraryModule({ library }: { library: SkillLibraryView }) {
  const [mine, setMine] = useState(library.mine);
  const [publics, setPublics] = useState(library.publics);
  return <div className="st-modules">
    <section className="st-card st-card-wide" aria-label="本人的主线 skill">
      <header><h3>本人的主线 skill</h3><small>每条主线一份，从本人的话与验收中整理；助手、步骤拆分、教程与验收都按它执行；不会被自动删除</small></header>
      <ul className="sk-lines">{mine.map((line) => <MineLine key={line.lineId} line={line} onSaved={(next) => setMine((all) => all.map((item) => item.lineId === next.lineId ? next : item))} />)}</ul>
    </section>
    <section className="st-card st-card-wide" aria-label="公开 skills">
      <header><h3>公开 skills · {publics.length}</h3><small>按主线检索的公开 skill，取回后经代码扫描与模型审查；30 天未调用自动删除</small></header>
      {publics.length === 0 ? <p className="muted">尚无。首次检索在主线建立后进行，之后每月一次；任务需要而库中没有时会提前检索。</p>
        : <ul className="sk-publics">{publics.map((skill) => <PublicSkill key={skill.id} skill={skill} onRemoved={() => setPublics((all) => all.filter((item) => item.id !== skill.id))} />)}</ul>}
      {library.removed.length > 0 && <p className="st-note">最近删除：{library.removed.map((item) => `${item.name}（${item.by === "person" ? "本人删除" : item.reason}，${day(item.at)}）`).join("；")}</p>}
    </section>
  </div>;
}

function MineLine({ line, onSaved }: { line: MineSkillView; onSaved: (line: MineSkillView) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.current?.markdown ?? "");
  const [note, setNote] = useState("");
  const save = async (body: { markdown: string } | { restore: number }) => {
    setNote("保存中");
    const response = await fetch(`/api/skills/mine/${encodeURIComponent(line.lineId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((result) => result.json() as Promise<{ ok: boolean; version?: number }>).catch((): { ok: boolean; version?: number } => ({ ok: false }));
    if (!response.ok) { setNote("未保存"); return; }
    const restored = "restore" in body ? line.versions.find((item) => item.version === body.restore) : undefined;
    const next = { version: response.version ?? 0, by: "person" as const, at: new Date().toISOString(),
      markdown: restored?.markdown ?? ("markdown" in body ? body.markdown : ""), rules: restored?.rules ?? [], ...(restored ? { restoredFrom: restored.version } : {}) };
    onSaved({ ...line, current: next, versions: [next, ...line.versions] });
    setEditing(false);
    setNote(restored ? `已回到第 ${restored.version} 版，保存为第 ${next.version} 版` : `已保存为第 ${next.version} 版`);
  };
  const current = line.current;
  return <li className="sk-line">
    <div className="sk-line-head">
      <LineTag line={line.lineId}>{line.lineLabel}</LineTag>
      {current ? <small>第 {current.version} 版 · {current.by === "person" ? (current.restoredFrom ? `回到第 ${current.restoredFrom} 版` : "本人编辑") : "整理"} · {day(current.at)}</small>
        : <small>尚未整理：本人对这条主线的验收备注、纠正或回顾出现后自动整理</small>}
      <span className="sk-actions">
        <button type="button" onClick={() => { setDraft(current?.markdown ?? ""); setEditing(!editing); }}>{editing ? "取消" : current ? "编辑" : "手写一份"}</button>
      </span>
    </div>
    {editing ? <div className="sk-edit">
      <textarea aria-label={`「${line.lineLabel}」主线 skill 全文`} value={draft} rows={14} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" onClick={() => save({ markdown: draft })} disabled={!draft.trim()}>保存为新版本</button>
    </div> : current && <>
      {current.rules.length > 0 && <ol className="sk-rules">{current.rules.map((rule, index) => <li key={index}>
        <Tag tone={rule.kind === "redline" ? "risk" : "neutral"}>{KIND[rule.kind]}</Tag>
        <span className="gen">{rule.text}</span>
        <small>来源：{rule.sources.length ? rule.sourceLabels.join("；") : <a href={rule.url} target="_blank" rel="noreferrer">平台规则页面</a>}
          {rule.quote && <span data-user-text>「{rule.quote}」</span>}</small>
      </li>)}</ol>}
      <details className="advanced sk-full"><summary>全文</summary><Markdown className="long-form" text={current.markdown.replace(/^---[\s\S]*?\n---\n/, "")} /></details>
      {line.versions.length > 1 && <details className="advanced"><summary>历次版本 · {line.versions.length}</summary>
        <ul className="st-list">{line.versions.map((version) => <li key={version.version}>
          <span>第 {version.version} 版</span><small>{version.by === "person" ? (version.restoredFrom ? `回到第 ${version.restoredFrom} 版` : "本人编辑") : `整理 · ${version.rules.length} 条`} · {day(version.at)}</small>
          {version.version !== current.version && <button type="button" onClick={() => save({ restore: version.version })}>回到此版</button>}
        </li>)}</ul>
      </details>}
    </>}
    {note && <p role="status" className="st-note">{note}</p>}
  </li>;
}

function PublicSkill({ skill, onRemoved }: { skill: PublicSkillView; onRemoved: () => void }) {
  const [note, setNote] = useState("");
  const verdict = VERDICT[skill.verdict];
  const flagged = [...new Set(skill.findings.map((finding) => RULE[finding.rule] ?? finding.rule))];
  return <li className="sk-public">
    <div className="sk-line-head">
      <strong>{skill.name}</strong><Tag>{skill.category}</Tag><Tag tone={verdict.tone}>{verdict.label}</Tag>
      <span className="sk-actions"><button type="button" aria-label={`删除公开 skill「${skill.name}」`} onClick={async () => {
        const ok = await fetch(`/api/skills/public/${encodeURIComponent(skill.id)}`, { method: "DELETE" }).then((response) => response.ok).catch(() => false);
        if (ok) onRemoved(); else setNote("删除未完成");
      }}>删除</button></span>
    </div>
    <p className="sk-desc" data-user-text>{skill.description}</p>
    <dl className="sk-facts">
      <dt>来源</dt><dd><a href={skill.url} target="_blank" rel="noreferrer">{skill.repo.replace("https://github.com/", "")}{skill.path ? `/${skill.path}` : ""}</a> · 提交 <span className="mono">{skill.commit.slice(0, 7)}</span></dd>
      <dt>许可证</dt><dd>{skill.license}</dd>
      <dt>扫描</dt><dd>{skill.risk === "high" || skill.injection ? `发现${flagged.join("、")}，脚本未安装` : "未发现风险"} · {skill.files} 个文件已记录校验值{skill.skipped ? `，${skill.skipped} 个非文本文件未取回` : ""}</dd>
      <dt>审查</dt><dd className="gen">{skill.reasons.join("；")}</dd>
      <dt>上次调用</dt><dd>{skill.lastUsedAt === skill.installedAt ? `尚未调用（${day(skill.installedAt)} 安装）` : day(skill.lastUsedAt)}</dd>
    </dl>
    {note && <p role="status" className="st-note">{note}</p>}
  </li>;
}
