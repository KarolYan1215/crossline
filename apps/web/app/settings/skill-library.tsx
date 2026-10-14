"use client";

import { useState } from "react";
import { AI_TOOL_KIND_LABEL, type AiTool, type AiToolKind } from "@crossline/core";
import { Markdown } from "../ui/markdown";
import { LineTag, Tag } from "../ui/tag";
import type { GrownSkillView, MineSkillView, PublicSkillView, SkillLibraryView } from "../../lib/skill-library";

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
  const [grown, setGrown] = useState(library.grown);
  return <div className="st-modules">
    <AiToolsCard initial={library.aiTools} />
    <section className="st-card st-card-wide" aria-label="本人的主线 skill">
      <header><h3>本人的主线 skill</h3><small>每条主线一份，从本人的话与验收中整理；助手、步骤拆分、教程与验收都按它执行；不会被自动删除</small></header>
      <ul className="sk-lines">{mine.map((line) => <MineLine key={line.lineId} line={line} onSaved={(next) => setMine((all) => all.map((item) => item.lineId === next.lineId ? next : item))} />)}</ul>
    </section>
    <section className="st-card st-card-wide" aria-label="生长的工作流">
      <header><h3>生长的工作流 · {grown.length}</h3><small>同类的事采纳过两次，或在输入框里说「以后都这样做」「每周五提醒」，助手会把它写成工作流，建好后通知；发出、发布一类的步骤始终由本人完成</small></header>
      {library.growing > 0 && <p className="st-note">{library.growing} 个工作流正在生成，建好后会通知。</p>}
      {grown.length === 0 ? <p className="muted">尚无。</p>
        : <ul className="sk-publics">{grown.map((flow) => <GrownFlow key={flow.id} flow={flow}
          onChanged={(next) => setGrown((all) => next ? all.map((item) => item.id === next.id ? next : item) : all.filter((item) => item.id !== flow.id))} />)}</ul>}
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
      .then((result) => result.json() as Promise<{ ok: boolean; version?: number; code?: string }>).catch((): { ok: boolean; version?: number; code?: string } => ({ ok: false }));
    if (!response.ok) { setNote(response.code === "SKILL_EMPTY" ? "还没有写任何规则，未保存" : response.code === "SKILL_TOO_LONG" ? "超过 2 万字，未保存" : "未保存"); return; }
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
        : <p className="sk-status">尚未整理：本人对这条主线的验收备注、纠正或回顾出现后自动整理</p>}
      <span className="sk-actions">
        <button type="button" className="secondary-button" onClick={() => { setDraft(current?.markdown ?? `# ${line.lineLabel}：本人的做法\n\n## 打法\n\n1. \n\n## 偏好\n\n1. \n\n## 红线\n\n1. \n`); setEditing(!editing); }}>{editing ? "取消" : current ? "编辑" : "手写一份"}</button>
      </span>
    </div>
    {editing ? <div className="sk-edit">
      <textarea aria-label={`「${line.lineLabel}」主线 skill 全文`} value={draft} rows={14} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" className="secondary-button" onClick={() => save({ markdown: draft })} disabled={!draft.trim()}>保存为新版本</button>
    </div> : current && <>
      {current.rules.length > 0 && <ol className="sk-rules">{current.rules.map((rule, index) => <li key={index}>
        <Tag tone={rule.kind === "redline" ? "risk" : "neutral"}>{KIND[rule.kind]}</Tag>
        <p className="gen">{rule.text}</p>
        {/* Where the rule came from is mostly the person's own words, quoted. */}
        <p className="sk-source" data-user-text>来源：{rule.sources.length ? rule.sourceLabels.join("；") : <a href={rule.url} target="_blank" rel="noreferrer">平台规则页面</a>}
          {rule.quote && `「${rule.quote}」`}</p>
      </li>)}</ol>}
      <details className="advanced sk-full"><summary>全文</summary><Markdown className="long-form" text={current.markdown.replace(/^---[\s\S]*?\n---\n/, "")} /></details>
      {line.versions.length > 1 && <details className="advanced"><summary>历次版本 · {line.versions.length}</summary>
        <ul className="st-list">{line.versions.map((version) => <li key={version.version}>
          <span>第 {version.version} 版</span><small>{version.by === "person" ? (version.restoredFrom ? `回到第 ${version.restoredFrom} 版` : "本人编辑") : `整理 · ${version.rules.length} 条`} · {day(version.at)}</small>
          {version.version !== current.version && <button type="button" className="secondary-button" onClick={() => save({ restore: version.version })}>回到此版</button>}
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
      <span className="sk-actions"><ConfirmDelete name={`公开 skill「${skill.name}」`} onConfirm={async () => {
        const ok = await fetch(`/api/skills/public/${encodeURIComponent(skill.id)}`, { method: "DELETE" }).then((response) => response.ok).catch(() => false);
        if (ok) onRemoved(); else setNote("删除未完成");
      }} /></span>
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

function GrownFlow({ flow, onChanged }: { flow: GrownSkillView; onChanged: (flow: GrownSkillView | undefined) => void }) {
  const [note, setNote] = useState("");
  const send = async (method: "POST" | "DELETE", body?: object) => fetch(`/api/skills/grown/${encodeURIComponent(flow.id)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((response) => response.ok).catch(() => false);
  const verdict = VERDICT[flow.verdict];
  const person = flow.steps.filter((step) => step.person);
  return <li className="sk-public">
    <div className="sk-line-head">
      <strong className="gen">{flow.summary}</strong><Tag>{flow.category}</Tag><Tag tone={flow.status === "active" ? "ok" : "neutral"}>{flow.status === "active" ? "启用" : "已关闭"}</Tag>
      {flow.verdict === "text_only" && <Tag tone={verdict.tone}>{verdict.label}</Tag>}
      <span className="sk-actions">
        <button type="button" className="secondary-button" onClick={async () => {
          const status = flow.status === "active" ? "off" : "active";
          if (await send("POST", { status })) onChanged({ ...flow, status }); else setNote("未保存");
        }}>{flow.status === "active" ? "关闭" : "启用"}</button>
        <button type="button" className="secondary-button" aria-pressed={flow.pinned} onClick={async () => {
          if (await send("POST", { pinned: !flow.pinned })) onChanged({ ...flow, pinned: !flow.pinned }); else setNote("未保存");
        }}>{flow.pinned ? "已保留" : "保留"}</button>
        <ConfirmDelete name={`工作流「${flow.summary}」`} onConfirm={async () => { if (await send("DELETE")) onChanged(undefined); else setNote("删除未完成"); }} />
      </span>
    </div>
    <dl className="sk-facts">
      <dt>时间</dt><dd>{flow.schedule}{flow.action === "remind" ? "，到点提醒" : flow.schedule === "按需" ? "，同类任务出现时使用" : "，到点由助手执行"}</dd>
      <dt>来由</dt><dd>{flow.origin} · {day(flow.createdAt)}</dd>
      <dt>步骤</dt><dd>{flow.steps.map((step) => step.person ? `${step.title}（本人）` : step.title).join(" → ")}</dd>
      {person.length > 0 && <><dt>本人完成</dt><dd>{person.map((step) => step.title).join("；")}</dd></>}
      <dt>检查</dt><dd>{flow.risk === "high" ? "脚本扫描发现风险，只用文字" : "脚本扫描未发现风险"} · {flow.files} 个文件已记录校验值</dd>
      <dt>审查</dt><dd className="gen">{flow.reasons.join("；")}</dd>
      <dt>上次使用</dt><dd>{flow.lastRunAt ? `${day(flow.lastRunAt)} 执行` : day(flow.lastUsedAt)}{flow.pinned ? "" : "；30 天未用会被移除，保留后不再移除"}</dd>
    </dl>
    {flow.skillText && <details className="advanced sk-full"><summary>工作流全文</summary><Markdown className="long-form" text={flow.skillText} /></details>}
    {note && <p role="status" className="st-note">{note}</p>}
  </li>;
}

/** Removing is not undone, so it takes a second click: 「删除」 becomes 「确认删除」 for a few seconds. */
function ConfirmDelete({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  return <button type="button" className="secondary-button" aria-label={armed ? `确认删除${name}` : `删除${name}`} onClick={async () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 5000); return; }
    await onConfirm();
  }}>{armed ? "确认删除" : "删除"}</button>;
}

const SOURCE = { built_in: "内置", detected: "使用记录", person: "本人添加" } as const;

/**
 * The AI tools plans assume (docs/skills-library.md §7): the assistant's own, the coding agents seen in use, and what the person names.
 * Each step of a plan says which one speeds it and is timed with it, so a tool listed here changes how much a day can hold.
 */
function AiToolsCard({ initial }: { initial: AiTool[] }) {
  const [tools, setTools] = useState(initial);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AiToolKind>("chat");
  const [goodFor, setGoodFor] = useState("");
  const [note, setNote] = useState("");
  const send = (method: "POST" | "DELETE", body: object) => fetch("/api/ai-tools", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => (response.ok ? await response.json() : undefined) as { tool?: AiTool } | undefined).catch(() => undefined);
  return <section className="st-card st-card-wide" aria-label="可用的 AI 工具">
    <header><h3>可用的 AI 工具 · {tools.length}</h3><small>步骤拆分、估时、教程与工作流按这些工具规划：能由助手整份做的交给助手，本人的步骤写明用哪个工具、怎么用，时间按用了工具计算</small></header>
    <ul className="st-prefs">{tools.map((tool) => <li key={tool.id}>
      <Tag>{AI_TOOL_KIND_LABEL[tool.kind]}</Tag><strong>{tool.name}</strong>
      <span className="st-pref-text">{tool.goodFor}{tool.by === "system" ? "（由助手执行）" : ""}</span>
      <small>{SOURCE[tool.source]}</small>
      {tool.source === "person" && <button type="button" className="st-pref-remove" aria-label={`删除工具：${tool.name}`} title="删除" onClick={async () => {
        if (await send("DELETE", { id: tool.id })) setTools((all) => all.filter((item) => item.id !== tool.id)); else setNote("删除未完成");
      }}>×</button>}
    </li>)}</ul>
    <form className="sk-tool-form" onSubmit={async (event) => {
      event.preventDefault();
      const result = await send("POST", { name, kind, goodFor });
      if (!result?.tool) { setNote("未添加：请写工具名称"); return; }
      setTools((all) => [...all.filter((item) => item.name.toLowerCase() !== result.tool!.name.toLowerCase()), result.tool!]);
      setName(""); setGoodFor(""); setNote(`已添加「${result.tool.name}」，之后的规划会用到它`);
    }}>
      <label><span>工具</span><input value={name} maxLength={40} placeholder="例如 剪映、NotebookLM" onChange={(event) => setName(event.target.value)} /></label>
      <label><span>类别</span><select value={kind} onChange={(event) => setKind(event.target.value as AiToolKind)}>
        {(Object.keys(AI_TOOL_KIND_LABEL) as AiToolKind[]).filter((item) => item !== "assistant").map((item) => <option key={item} value={item}>{AI_TOOL_KIND_LABEL[item]}</option>)}
      </select></label>
      <label className="sk-tool-good"><span>用来做什么</span><input value={goodFor} maxLength={120} placeholder="例如 自动字幕、粗剪" onChange={(event) => setGoodFor(event.target.value)} /></label>
      <button type="submit" className="secondary-button" disabled={!name.trim()}>添加</button>
    </form>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
