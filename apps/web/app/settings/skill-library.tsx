"use client";

import { useEffect, useRef, useState } from "react";
import { AI_TOOL_KIND_LABEL, type AiTool, type AiToolKind } from "@crossline/core";
import { Markdown } from "../ui/markdown";
import { Clamp } from "../ui/clamp";
import { LineTag, Tag } from "../ui/tag";
import { SetupGuide } from "../ui/setup-guide";
import { RemoteLogin, remoteWindowSize } from "../ui/remote-login";
import { SKILL_LINK_GUIDE } from "../../lib/setup-guides";
import type { GrownSkillView, MineSkillView, PublicSkillView, ScriptsView, SkillLibraryView } from "../../lib/skill-library";

const day = (iso: string) => iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "—";
const KIND = { play: "打法", preference: "偏好", redline: "红线" } as const;
const VERDICT = { usable: { label: "可用", tone: "ok" }, text_only: { label: "只用文字", tone: "warn" }, reject: { label: "拒绝", tone: "risk" } } as const;
const RULE = { net: "联网", delete: "删除", "delete.recursive": "删除", outside: "越出目录", "secret.path": "读取凭据", system: "改系统设置",
  "download.execute": "下载并执行", injection: "要求越权", "hidden.text": "隐藏文字" } as Record<string, string>;

type Kind = "mine" | "grown" | "public" | "tools";
const KINDS: Array<[Kind, string]> = [["mine", "主线 skill"], ["grown", "工作流"], ["public", "公开 skill"], ["tools", "AI 工具"]];

/** The skills a run used most recently, newest first: public skills by their last call, workflows by their last run or use. */
export function recentSkills(publics: PublicSkillView[], grown: GrownSkillView[], limit = 4): Array<{ kind: "public" | "grown"; id: string; name: string; at: string }> {
  return [
    ...publics.filter((skill) => skill.lastUsedAt && skill.lastUsedAt !== skill.installedAt).map((skill) => ({ kind: "public" as const, id: skill.id, name: skill.name, at: skill.lastUsedAt })),
    ...grown.filter((flow) => flow.lastRunAt || flow.lastUsedAt).map((flow) => ({ kind: "grown" as const, id: flow.id, name: flow.summary, at: flow.lastRunAt ?? flow.lastUsedAt }))
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** What a search matches: the words the person would remember a skill by (name, line, category, source, what it is for). */
export const matchesSkill = (query: string, ...texts: Array<string | undefined>) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/**
 * 设置 → Skill 库 (docs/skills-library.md §5). Folded to a summary by default (2026-10-21: the full lists filled several screens and pushed
 * every module below them out of reach): how many of each kind, what needs the person, the few used last, and a search. A kind's list
 * opens from its count, a search shows what matches across all of them, and each item opens on its own for its rules, sources and scan.
 * The person's own line skills: the one in force in full, where each rule came from, every earlier version (回到此版 makes it a new version),
 * and editing in place. The public skills: where each came from (repository, directory, commit), its licence, what the scan and the review
 * found, when a run last used it, and removing it.
 */
export function SkillLibraryModule({ library }: { library: SkillLibraryView }) {
  const [mine, setMine] = useState(library.mine);
  const [publics, setPublics] = useState(library.publics);
  const [grown, setGrown] = useState(library.grown);
  const [kind, setKind] = useState<Kind | "all" | undefined>();
  const [query, setQuery] = useState("");
  // An item opened from 「最近用过」 or 「待确认」 is shown open.
  const [focus, setFocus] = useState<string | undefined>();
  // 「去登录」 in a message leads here with `?login=<workflow>`: that workflow is shown open and its login started.
  const [autoLogin, setAutoLogin] = useState<string | undefined>();
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("login");
    if (!wanted || !library.grown.some((flow) => flow.id === wanted)) return;
    setKind("grown"); setFocus(wanted); setAutoLogin(wanted);
  }, [library.grown]);
  const searching = query.trim().length > 0;
  const listed = (which: Kind) => searching || kind === "all" || kind === which;
  const all = kind === "all";
  const mineShown = mine.filter((line) => matchesSkill(query, line.lineLabel, line.current?.markdown));
  const grownShown = grown.filter((flow) => matchesSkill(query, flow.summary, flow.category, flow.lineLabel, flow.origin, flow.steps.map((step) => step.title).join(" ")));
  const publicShown = publics.filter((skill) => matchesSkill(query, skill.name, skill.category, skill.description, skill.repo, skill.path));
  const toolsShown = library.aiTools.filter((tool) => matchesSkill(query, tool.name, tool.goodFor));
  const recent = recentSkills(publics, grown);
  const waiting = grown.filter((flow) => flow.status === "needs_consent");
  const counts: Record<Kind, { count: number; detail: string }> = {
    mine: { count: mine.length, detail: `已整理 ${mine.filter((line) => line.current).length}` },
    grown: { count: grown.length, detail: `启用 ${grown.filter((flow) => flow.status === "active").length}${library.growing ? ` · 生成中 ${library.growing}` : ""}` },
    public: { count: publics.length, detail: `只用文字 ${publics.filter((skill) => skill.verdict === "text_only").length}` },
    tools: { count: library.aiTools.length, detail: `本人添加 ${library.aiTools.filter((tool) => tool.source === "person").length}` }
  };
  const open = (which: Kind, id: string) => { setKind(which); setQuery(""); setFocus(id); };
  const nothing = searching && !mineShown.length && !grownShown.length && !publicShown.length && !toolsShown.length;
  return <div className="st-modules">
    <section className="st-card st-card-wide sk-overview" aria-label="Skill 库概览">
      <header><h3>Skill 库</h3><small>助手、步骤拆分、教程与验收按这些 skill 执行；点类别看清单，点单项看规则、来源与扫描结果</small></header>
      <div className="sk-counts" role="group" aria-label="按类查看">
        {KINDS.map(([id, label]) => <button key={id} type="button" aria-pressed={kind === id} onClick={() => { setKind(kind === id ? undefined : id); setFocus(undefined); }}>
          <b>{counts[id].count}</b><span>{label}</span><small>{counts[id].detail}</small></button>)}
      </div>
      {waiting.length > 0 && <p className="sk-attention"><Tag tone="warn">待本人确认风险</Tag>
        {waiting.map((flow) => <button key={flow.id} type="button" className="text-button" onClick={() => open("grown", flow.id)}>{flow.summary}</button>)}</p>}
      {recent.length > 0 && <p className="sk-recent"><span>最近用过</span>
        {recent.map((item) => <button key={`${item.kind}:${item.id}`} type="button" className="text-button" onClick={() => open(item.kind, item.id)}>
          {item.name}<small>{day(item.at)}</small></button>)}</p>}
      <div className="sk-search">
        <label className="sk-search-field"><span>搜索</span>
          <input type="search" value={query} placeholder="名称、主线、来源或用途" onChange={(event) => { setQuery(event.target.value); setFocus(undefined); }} /></label>
        <button type="button" className="secondary-button" onClick={() => { setKind(all ? undefined : "all"); setQuery(""); setFocus(undefined); }}>{all ? "全部收起" : "全部展开"}</button>
      </div>
      {nothing && <p className="muted">没有与「{query.trim()}」相符的 skill。</p>}
    </section>
    {listed("tools") && (!searching || toolsShown.length > 0) && <AiToolsCard initial={library.aiTools} />}
    {listed("mine") && mineShown.length > 0 && <section className="st-card st-card-wide" aria-label="本人的主线 skill">
      <header><h3>本人的主线 skill · {mine.length}</h3><small>每条主线一份，从本人的话与验收中整理；助手、步骤拆分、教程与验收都按它执行；不会被自动删除</small></header>
      <ul className="sk-lines">{mineShown.map((line) => <MineLine key={`${line.lineId}:${kind}`} line={line} open={all || focus === line.lineId}
        onSaved={(next) => setMine((items) => items.map((item) => item.lineId === next.lineId ? next : item))} />)}</ul>
    </section>}
    {listed("grown") && (!searching || grownShown.length > 0) && <section className="st-card st-card-wide" aria-label="生长的工作流">
      <header><h3>生长的工作流 · {grown.length}</h3><small>同类的事采纳过两次，或在输入框里说「以后都这样做」「每周五提醒」，助手会把它写成工作流，建好后通知；发出、发布一类的步骤始终由本人完成</small></header>
      {library.growing > 0 && <p className="st-note">{library.growing} 个工作流正在生成，建好后会通知。</p>}
      {grown.length === 0 ? <p className="muted">尚无。</p>
        : <ul className="sk-publics">{grownShown.map((flow) => <GrownFlow key={`${flow.id}:${kind}`} flow={flow} shell={library.shell} open={all || focus === flow.id} autoLogin={autoLogin === flow.id}
          onChanged={(next) => setGrown((items) => next ? items.map((item) => item.id === next.id ? next : item) : items.filter((item) => item.id !== flow.id))} />)}</ul>}
    </section>}
    {listed("public") && (!searching || publicShown.length > 0) && <section className="st-card st-card-wide" aria-label="公开 skills">
      <header><h3>公开 skills · {publics.length}</h3><small>按主线检索的公开 skill，取回后经代码扫描与模型审查；30 天未调用自动删除</small></header>
      {publics.length === 0 ? <p className="muted">尚无。主线建立时检索一轮，之后每月补充一次；也可以在下面为一条主线再检索一轮。</p>
        : <ul className="sk-publics">{publicShown.map((skill) => <PublicSkill key={`${skill.id}:${kind}`} skill={skill} shell={library.shell} open={all || focus === skill.id}
          onChanged={(next) => setPublics((items) => next ? items.map((item) => item.id === next.id ? next : item) : items.filter((item) => item.id !== skill.id))} />)}</ul>}
      {!searching && <>
        <SearchAgain lines={library.mine.map((line) => ({ id: line.lineId, label: line.lineLabel }))} />
        <LinkInstall lines={library.mine.map((line) => ({ id: line.lineId, label: line.lineLabel }))} />
        <SetupGuide guide={SKILL_LINK_GUIDE} />
      </>}
      {library.removed.length > 0 && <p className="st-note">最近删除：{library.removed.map((item) => `${item.name}（${item.by === "person" ? "本人删除" : item.reason}，${day(item.at)}）`).join("；")}</p>}
    </section>}
  </div>;
}

function MineLine({ line, open, onSaved }: { line: MineSkillView; open: boolean; onSaved: (line: MineSkillView) => void }) {
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
  return <li className="sk-line"><details className="advanced sk-item" open={open || editing}>
    <summary><LineTag line={line.lineId}>{line.lineLabel}</LineTag>
      <small>{current ? `第 ${current.version} 版 · ${current.rules.length} 条规则` : "尚未整理"}</small></summary>
    <div className="sk-line-head">
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
        <p className="sk-source" data-user-text>{rule.sources.length ? <Clamp lines={1} text={`来源：${rule.sourceLabels.join("；")}${rule.quote ? `「${rule.quote}」` : ""}`} />
          : <>来源：<a href={rule.url} target="_blank" rel="noreferrer">平台规则页面</a>{rule.quote && `「${rule.quote}」`}</>}</p>
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
  </details></li>;
}

function PublicSkill({ skill, shell, open, onChanged }: { skill: PublicSkillView; shell: boolean; open: boolean; onChanged: (skill: PublicSkillView | undefined) => void }) {
  const [note, setNote] = useState("");
  const verdict = VERDICT[skill.verdict];
  const flagged = [...new Set(skill.findings.map((finding) => RULE[finding.rule] ?? finding.rule))];
  return <li className="sk-public"><details className="advanced sk-item" open={open}>
    <summary><strong>{skill.name}</strong><Tag>{skill.category}</Tag><Tag tone={verdict.tone}>{verdict.label}</Tag>
      <small>{skill.lastUsedAt === skill.installedAt ? "尚未调用" : `${day(skill.lastUsedAt)} 调用`}</small></summary>
    <div className="sk-line-head">
      <span className="sk-actions"><ConfirmDelete name={`公开 skill「${skill.name}」`} onConfirm={async () => {
        const ok = await fetch(`/api/skills/public/${encodeURIComponent(skill.id)}`, { method: "DELETE" }).then((response) => response.ok).catch(() => false);
        if (ok) onChanged(undefined); else setNote("删除未完成");
      }} /></span>
    </div>
    <p className="sk-desc" data-user-text><Clamp text={skill.description} /></p>
    <dl className="sk-facts">
      <dt>来源</dt><dd><a href={skill.url} target="_blank" rel="noreferrer">{skill.repo.replace("https://github.com/", "")}{skill.path ? `/${skill.path}` : ""}</a> · 提交 <span className="mono">{skill.commit.slice(0, 7)}</span></dd>
      <dt>许可证</dt><dd>{skill.license}</dd>
      <dt>扫描</dt><dd>{skill.risk === "high" || skill.injection ? `发现${flagged.join("、")}，${skill.scriptsAllowedAt ? `本人于 ${day(skill.scriptsAllowedAt)} 允许运行脚本` : "脚本未安装"}` : "未发现风险"} · {skill.files} 个文件已记录校验值{skill.skipped ? `，${skill.skipped} 个非文本文件未取回` : ""}</dd>
      <dt>审查</dt><dd className="gen"><Clamp lines={1} text={skill.reasons.join("；")} /></dd>
      <dt>上次调用</dt><dd>{skill.lastUsedAt === skill.installedAt ? `尚未调用（${day(skill.installedAt)} 安装）` : day(skill.lastUsedAt)}</dd>
    </dl>
    <ScriptsConsent view={skill} shell={shell} endpoint={`/api/skills/public/${encodeURIComponent(skill.id)}`}
      onChanged={(allowedAt) => { const { scriptsAllowedAt: _was, ...rest } = skill; onChanged(allowedAt ? { ...rest, scriptsAllowedAt: allowedAt } : rest); }} />
    {note && <p role="status" className="st-note">{note}</p>}
  </details></li>;
}

/**
 * 「允许运行脚本」 (2026-10-19, the owner's decision): a skill the scan capped to text keeps its scripts once the person has read what the
 * scan found and allows them. The leave covers these files only — an update asks again — and is taken back with one click. The hosted
 * assistant has no command line, so there an allowed script is read for its method, not run; the page says which.
 */
function ScriptsConsent({ view, shell, endpoint, onChanged }: { view: ScriptsView; shell: boolean; endpoint: string; onChanged: (allowedAt: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!view.scriptsAllowable) return null;
  const send = async (allow: boolean) => {
    const ok = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: allow ? "allow_scripts" : "disallow_scripts" }) })
      .then((response) => response.ok).catch(() => false);
    if (!ok) { setNote("未保存"); return; }
    onChanged(allow ? new Date().toISOString() : undefined);
    setOpen(false);
    setNote(allow ? "已允许，下次运行时脚本随 skill 一起安装" : "已收回，下次运行时只用文字");
  };
  const where = shell ? "助手运行时可以按这份 skill 执行其中的脚本，命令仍逐条经过助手的检查。"
    : "托管版助手没有命令行：允许后脚本随 skill 安装，供助手阅读其中的方法，不会执行；本人电脑上的副本可以执行。";
  return <div className="sk-scripts">
    {view.scriptsAllowedAt
      ? <p className="st-note">{view.scripts} 个脚本已允许运行（{day(view.scriptsAllowedAt)}）。{where}
        <button type="button" className="secondary-button" onClick={() => { void send(false); }}>收回</button></p>
      : <button type="button" className="secondary-button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "收起" : `查看扫描结果并允许 ${view.scripts} 个脚本`}</button>}
    {open && !view.scriptsAllowedAt && <div className="sk-scripts-review">
      <p>扫描按模式逐行查找联网、删除、越出目录、读取凭据、改系统设置和下载执行，可能漏判，也可能误判。以下是它找到的：</p>
      <ul className="st-list">{view.findings.map((finding, index) => <li key={index}>
        <Tag tone="warn">{RULE[finding.rule] ?? finding.rule}</Tag><span className="mono">{finding.file}:{finding.line}</span>
        <code className="sk-excerpt">{finding.excerpt}</code>
      </li>)}</ul>
      <p>{where}文件更新后需要重新允许。</p>
      <button type="button" className="secondary-button" onClick={() => { void send(true); }}>允许运行脚本</button>
    </div>}
    {note && <p role="status" className="st-note">{note}</p>}
  </div>;
}

function GrownFlow({ flow, shell, open, autoLogin, onChanged }: { flow: GrownSkillView; shell: boolean; open: boolean; autoLogin?: boolean; onChanged: (flow: GrownSkillView | undefined) => void }) {
  const [note, setNote] = useState("");
  const send = async (method: "POST" | "DELETE", body?: object) => fetch(`/api/skills/grown/${encodeURIComponent(flow.id)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((response) => response.ok).catch(() => false);
  // 「登录」 and 「立即运行」 are carried out by the worker; its refusal says why in words.
  const act = async (body: object, success: string): Promise<{ ok: boolean; code?: string; remote?: boolean }> => {
    const result = await fetch(`/api/skills/grown/${encodeURIComponent(flow.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((response) => response.json() as Promise<{ ok: boolean; code?: string; message?: string; remote?: boolean }>)
      .catch((): { ok: boolean; code?: string; message?: string; remote?: boolean } => ({ ok: false, message: "未完成" }));
    setNote(result.ok ? (result.remote ? "" : success) : result.message || "未完成");
    return result;
  };
  // Services whose login window this page opened: 「我已登录」 closes it and records the login.
  const [opened, setOpened] = useState<string[]>([]);
  // A login opened as the server's browser (the hosted beta has no screen to open a window on): shown here in a dialog.
  const [remote, setRemote] = useState<string | undefined>();
  const login = async (service: string) => {
    setNote(`正在打开${service}的登录窗口`);
    const size = remoteWindowSize(window.innerWidth, window.innerHeight);
    const result = await act({ action: "login", service, ...size }, `已打开${service}的登录窗口：在窗口里自己登录，登录后点「我已登录${service}」`);
    if (result.ok && result.remote) setRemote(service);
    else if (result.ok || result.code === "LOGIN_WINDOW_OPEN") setOpened((all) => [...all, service]);
  };
  // While it runs, the card asks every 30 seconds whether it still does and how far the topics are.
  useEffect(() => {
    if (!flow.running) return;
    const timer = window.setInterval(async () => {
      const status = await fetch(`/api/skills/grown/${encodeURIComponent(flow.id)}`).then((response) => response.json() as Promise<Pick<GrownSkillView, "running" | "topics"> & { ok: boolean }>)
        .catch(() => undefined);
      if (!status?.ok) return;
      const { running: _was, ...rest } = flow;
      onChanged({ ...rest, ...(status.running ? { running: status.running } : {}), ...(status.topics ? { topics: status.topics } : {}) });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [flow, onChanged]);
  const started = useRef(false);
  useEffect(() => {
    if (!autoLogin || started.current || flow.status !== "active") return;
    const site = flow.access.find((item) => item.login && !item.loggedInAt) ?? flow.access.find((item) => item.login);
    if (!site) return;
    started.current = true;
    void login(site.service);
  });
  const verdict = VERDICT[flow.verdict];
  const person = flow.steps.filter((step) => step.person);
  const waiting = flow.status === "needs_consent";
  return <li className="sk-public"><details className="advanced sk-item" open={open}>
    <summary>{flow.lines[0] && <LineTag line={flow.lines[0]}>{flow.lineLabel || flow.lines[0]}</LineTag>}<strong className="gen">{flow.summary}</strong><Tag>{flow.category}</Tag>
      <Tag tone={flow.status === "active" ? "ok" : waiting ? "warn" : "neutral"}>{flow.status === "active" ? "启用" : waiting ? "待本人确认风险" : "已关闭"}</Tag>
      {flow.verdict === "text_only" && <Tag tone={verdict.tone}>{verdict.label}</Tag>}</summary>
    <div className="sk-line-head">
      <span className="sk-actions">
        {waiting ? <button type="button" className="secondary-button" onClick={async () => {
          if (await send("POST", { action: "consent" })) onChanged({ ...flow, status: "active", consentedAt: new Date().toISOString() }); else setNote("未保存");
        }}>接受风险并启用</button> : <button type="button" className="secondary-button" onClick={async () => {
          const status = flow.status === "active" ? "off" : "active";
          if (await send("POST", { status })) onChanged({ ...flow, status }); else setNote("未保存");
        }}>{flow.status === "active" ? "关闭" : "启用"}</button>}
        {flow.access.filter((item) => item.login).map((item) => opened.includes(item.service)
          ? <button key={item.service} type="button" className="secondary-button" onClick={async () => {
            if ((await act({ action: "login_done", service: item.service }, `已记下${item.service}的登录，登录窗口已关闭`)).ok) {
              setOpened((all) => all.filter((name) => name !== item.service));
              onChanged({ ...flow, access: flow.access.map((one) => one.service === item.service ? { ...one, loggedInAt: new Date().toISOString() } : one) });
            }
          }}>我已登录{item.service}</button>
          // A window opened from another page or tab is still open: offer 「我已登录」 here too.
          : <button key={item.service} type="button" className="secondary-button" onClick={() => { void login(item.service); }}>
            {item.loggedInAt ? `重新登录${item.service}` : `登录${item.service}`}</button>)}
        {flow.status === "active" && flow.action === "run" && (flow.running
          ? <button type="button" className="secondary-button" disabled title={`自 ${new Date(flow.running.since).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 起`}>
            运行中：{flow.running.what}</button>
          : <button type="button" className="secondary-button" onClick={async () => {
            const result = await act({ action: "run" }, "已开始运行，做好后通知");
            // Started: the button says so at once; the card then follows the worker's own record (polled below).
            if (result.ok) onChanged({ ...flow, running: { since: new Date().toISOString(), what: "启动中" } });
          }}>立即运行</button>)}
        <button type="button" className="secondary-button" aria-pressed={flow.pinned} onClick={async () => {
          if (await send("POST", { pinned: !flow.pinned })) onChanged({ ...flow, pinned: !flow.pinned }); else setNote("未保存");
        }}>{flow.pinned ? "已保留" : "保留"}</button>
        <ConfirmDelete name={`工作流「${flow.summary}」`} onConfirm={async () => { if (await send("DELETE")) onChanged(undefined); else setNote("删除未完成"); }} />
      </span>
    </div>
    <dl className="sk-facts">
      <dt>时间</dt><dd>{flow.schedule}{flow.action === "remind" ? "，到点提醒" : flow.schedule === "按需" ? "，同类任务出现时使用" : "，到点由助手执行"}</dd>
      <dt>来由</dt><dd>{flow.origin} · {day(flow.createdAt)}</dd>
      {flow.access.length > 0 && <><dt>读取</dt><dd>{flow.consentedAt
          // Like the risks: in full until accepted, then one line with 「全文」.
          ? <span className="gen"><Clamp lines={1} text={flow.access.map((item) => `${item.service}（${item.login ? item.loggedInAt ? `${day(item.loggedInAt)} 登录` : "需本人登录" : "公开页面"}）：${item.how}`).join("；")} /></span>
          : flow.access.map((item) => <span key={item.service} className="gen">
        {item.service}（{item.login ? item.loggedInAt ? `${day(item.loggedInAt)} 登录` : "需本人登录" : "公开页面"}）：{item.how}<br /></span>)}</dd>
        <dt>风险</dt><dd className="gen">{flow.consentedAt
          // Read in full before 「接受风险并启用」; once accepted, one line with 「全文」.
          ? <Clamp lines={1} text={`${flow.risks.join("；")}。本人于 ${day(flow.consentedAt)} 接受`} />
          : <>{flow.risks.map((risk) => <span key={risk}>{risk}<br /></span>)}本人接受前不会运行</>}</dd></>}
      {flow.topics && <TopicsPace flow={flow} topics={flow.topics} send={send} onChanged={onChanged} setNote={setNote} />}
      <dt>步骤</dt><dd><Clamp text={flow.steps.map((step) => step.person ? `${step.title}（本人）` : step.title).join(" → ")} /></dd>
      {person.length > 0 && <><dt>本人完成</dt><dd>{person.map((step) => step.title).join("；")}</dd></>}
      <dt>检查</dt><dd>{flow.risk === "high" ? flow.scriptsAllowedAt ? `脚本扫描发现风险，本人于 ${day(flow.scriptsAllowedAt)} 允许运行` : "脚本扫描发现风险，只用文字"
        : "脚本扫描未发现风险"} · {flow.files} 个文件已记录校验值</dd>
      <dt>审查</dt><dd className="gen"><Clamp lines={1} text={flow.reasons.join("；")} /></dd>
      <dt>上次使用</dt><dd>{flow.lastRunAt ? `${day(flow.lastRunAt)} 执行` : day(flow.lastUsedAt)}{flow.pinned ? "" : "；30 天未用会被移除，保留后不再移除"}</dd>
    </dl>
    {flow.skillText && <details className="advanced sk-full"><summary>工作流全文</summary><Markdown className="long-form" text={flow.skillText} /></details>}
    <ScriptsConsent view={flow} shell={shell} endpoint={`/api/skills/grown/${encodeURIComponent(flow.id)}`}
      onChanged={(allowedAt) => { const { scriptsAllowedAt: _was, ...rest } = flow; onChanged(allowedAt ? { ...rest, scriptsAllowedAt: allowedAt } : rest); }} />
    {note && <p role="status" className="st-note">{note}</p>}
    {remote && <RemoteLogin target={{ workflowId: flow.id, service: remote }} label={remote} onClose={(loggedIn) => {
      setRemote(undefined);
      setNote(loggedIn ? `已记下${remote}的登录` : "");
      if (loggedIn) onChanged({ ...flow, access: flow.access.map((one) => one.service === remote ? { ...one, loggedInAt: new Date().toISOString() } : one) });
    }} />}
  </details></li>;
}

/** Removing is not undone, so it takes a second click: 「删除」 becomes 「确认删除」 for a few seconds. */
type InstallStatus = { state: "running" | "installed" | "already" | "rejected" | "blocked"; jobId?: string; id?: string; final?: string; reason?: string; message?: string };
const INSTALL_POLL_MS = 4000;
const INSTALL_WAIT_MS = 40 * 60_000;

/**
 * 「按链接添加」 (docs/skills-library.md §2): a GitHub repository and the directory holding SKILL.md, for one line. The worker takes it
 * through the same fetch, scan and review as the scout's own finds; this waits on the job and reloads once the skill is in the library.
 */
/** One more search of a line's public skills, at the person's word; the worker runs it at its next tick. */
function SearchAgain({ lines }: { lines: Array<{ id: string; label: string }> }) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [note, setNote] = useState("");
  return <form className="sk-tool-form" aria-label="为一条主线再检索公开 skill" onSubmit={async (event) => {
    event.preventDefault();
    const response = await fetch("/api/skills/public/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lineId }) })
      .then((result) => result.ok).catch(() => false);
    setNote(response ? "已安排，下一次后台检查时开始检索；新加入的 skill 会出现在这里" : "未安排，请稍后再试");
  }}>
    <label><span>主线</span><select value={lineId} onChange={(event) => setLineId(event.target.value)}>
      {lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
    </select></label>
    <button type="submit" className="secondary-button" disabled={!lineId}>再检索一轮</button>
    {note && <p role="status" className="st-note">{note}</p>}
  </form>;
}

function LinkInstall({ lines }: { lines: Array<{ id: string; label: string }> }) {
  const [repo, setRepo] = useState("");
  const [dir, setDir] = useState("");
  const [lineId, setLineId] = useState(lines[0]?.id ?? "");
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const describe = (status: InstallStatus) => status.state === "installed" ? `已加入 Skill 库（${status.final === "text_only" ? "脚本有风险，只用文字" : "可用"}）`
    : status.state === "already" ? "库里已有这个 skill，已把这条主线加给它"
    : status.state === "rejected" ? `未加入：${status.reason ?? ""}` : status.state === "blocked" ? `未完成：${status.message ?? ""}` : "正在取回、扫描与审查……";
  const poll = async (jobId: string) => {
    const until = Date.now() + INSTALL_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_POLL_MS));
      const status = await fetch(`/api/skills/public/install?job=${encodeURIComponent(jobId)}`).then((response) => response.json() as Promise<InstallStatus>).catch(() => undefined);
      if (!status || status.state === "running") continue;
      setNote(describe(status));
      if (status.state === "installed" || status.state === "already") window.location.reload();
      return;
    }
    setNote("审查还没结束；稍后刷新页面查看。");
  };
  return <form className="sk-tool-form" aria-label="按链接添加公开 skill" onSubmit={async (event) => {
    event.preventDefault();
    setBusy(true); setNote("正在取回、扫描与审查……");
    try {
      const response = await fetch("/api/skills/public/install", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, path: dir, lineId, why }) });
      const answer = await response.json().catch(() => ({})) as InstallStatus & { blocker?: { message?: string } };
      if (!response.ok || !answer.jobId) { setNote(`未开始：${answer.blocker?.message ?? "请检查链接与目录"}`); return; }
      await poll(answer.jobId);
    } finally { setBusy(false); }
  }}>
    <label className="sk-tool-good"><span>仓库链接</span><input value={repo} maxLength={300} placeholder="https://github.com/owner/repo，或目录的链接" onChange={(event) => setRepo(event.target.value)} /></label>
    <label><span>目录</span><input value={dir} maxLength={300} placeholder="例如 skills/teach" onChange={(event) => setDir(event.target.value)} /></label>
    <label><span>主线</span><select value={lineId} onChange={(event) => setLineId(event.target.value)}>
      {lines.map((line) => <option key={line.id} value={line.id}>{line.label}</option>)}
    </select></label>
    <label className="sk-tool-good"><span>用来做什么</span><input value={why} maxLength={300} placeholder="可不填" onChange={(event) => setWhy(event.target.value)} /></label>
    <button type="submit" className="secondary-button" disabled={busy || !repo.trim() || !lineId}>按链接添加</button>
    {note && <p role="status" className="st-note">{note}</p>}
  </form>;
}

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

/**
 * Favourites organised by topic: the two paces, each the person's to change (2026-10-22) — notes a day for the day's topic, and the night
 * window's hours (equal hours: no night reading) — and how far each topic is read.
 */
function TopicsPace({ flow, topics, send, onChanged, setNote }: { flow: GrownSkillView; topics: NonNullable<GrownSkillView["topics"]>;
  send: (method: "POST" | "DELETE", body?: object) => Promise<boolean>; onChanged: (view: GrownSkillView | undefined) => void; setNote: (text: string) => void }) {
  const [perDay, setPerDay] = useState(topics.perDay);
  const [from, setFrom] = useState(topics.from);
  const [to, setTo] = useState(topics.to);
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const save = async () => {
    if (await send("POST", { action: "topics", perDay, from, to })) { onChanged({ ...flow, topics: { ...topics, perDay, from, to } }); setNote("已保存整理节奏"); }
    else setNote("未保存");
  };
  const total = topics.progress.reduce((sum, item) => sum + item.total, 0);
  const done = topics.progress.reduce((sum, item) => sum + item.read, 0);
  return <>
    <dt>整理节奏</dt><dd className="sk-topics-pace">
      <label>每天整理一个话题，最多 <input type="number" min={1} max={500} value={perDay} onChange={(event) => setPerDay(Number(event.target.value))} aria-label="每天最多篇数" /> 篇</label>
      <label>另在 <select value={from} onChange={(event) => setFrom(Number(event.target.value))} aria-label="夜间开始">{hours.map((hour) => <option key={hour} value={hour}>{hour} 点</option>)}</select>
        到 <select value={to} onChange={(event) => setTo(Number(event.target.value))} aria-label="夜间结束">{hours.map((hour) => <option key={hour} value={hour}>{hour} 点</option>)}</select>
        持续整理，不限篇数（两个时间相同则不在夜间整理）</label>
      <button type="button" className="secondary-button" onClick={() => { void save(); }}>保存</button>
    </dd>
    <dt>话题</dt><dd>{topics.progress.length
      ? <><span>{topics.progress.length} 个话题，已读 {done} / {total} 篇</span><br />
        <span className="gen"><Clamp lines={2} text={topics.progress.map((item) => `${item.name} ${item.read}/${item.total}`).join("；")} /></span></>
      : topics.listed ? `已读到 ${topics.listed} 条收藏，正在按标题分话题` : "登录后点「立即运行」读取收藏列表并分话题"}</dd>
  </>;
}
