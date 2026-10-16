"use client";

import { useState } from "react";
import { AI_TOOL_KIND_LABEL, type AiTool, type AiToolKind } from "@crossline/core";
import { Markdown } from "../ui/markdown";
import { Clamp } from "../ui/clamp";
import { LineTag, Tag } from "../ui/tag";
import type { GrownSkillView, MineSkillView, PublicSkillView, SkillLibraryView } from "../../lib/skill-library";
import { useLocale, useT } from "../locale-context";
import { joinList } from "../../lib/i18n";

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
  const t = useT();
  const { sep, aside } = marks(useLocale());
  const [mine, setMine] = useState(library.mine);
  const [publics, setPublics] = useState(library.publics);
  const [grown, setGrown] = useState(library.grown);
  return <div className="st-modules">
    <AiToolsCard initial={library.aiTools} />
    <section className="st-card st-card-wide" aria-label={t("本人的主线 skill")}>
      <header><h3>{t("本人的主线 skill")}</h3><small>{t("每条主线一份，从本人的话与验收中整理；助手、步骤拆分、教程与验收都按它执行；不会被自动删除")}</small></header>
      <ul className="sk-lines">{mine.map((line) => <MineLine key={line.lineId} line={line} onSaved={(next) => setMine((all) => all.map((item) => item.lineId === next.lineId ? next : item))} />)}</ul>
    </section>
    <section className="st-card st-card-wide" aria-label={t("生长的工作流")}>
      <header><h3>{t("生长的工作流 · {{n}}", { n: grown.length })}</h3><small>{t("同类的事采纳过两次，或在输入框里说「以后都这样做」「每周五提醒」，助手会把它写成工作流，建好后通知；发出、发布一类的步骤始终由本人完成")}</small></header>
      {library.growing > 0 && <p className="st-note">{t("{{count}} 个工作流正在生成，建好后会通知。", { count: library.growing })}</p>}
      {grown.length === 0 ? <p className="muted">{t("尚无。")}</p>
        : <ul className="sk-publics">{grown.map((flow) => <GrownFlow key={flow.id} flow={flow}
          onChanged={(next) => setGrown((all) => next ? all.map((item) => item.id === next.id ? next : item) : all.filter((item) => item.id !== flow.id))} />)}</ul>}
    </section>
    <section className="st-card st-card-wide" aria-label={t("公开 skills")}>
      <header><h3>{t("公开 skills · {{n}}", { n: publics.length })}</h3><small>{t("按主线检索的公开 skill，取回后经代码扫描与模型审查；30 天未调用自动删除")}</small></header>
      {publics.length === 0 ? <p className="muted">{t("尚无。首次检索在主线建立后进行，之后每月一次；任务需要而库中没有时会提前检索。")}</p>
        : <ul className="sk-publics">{publics.map((skill) => <PublicSkill key={skill.id} skill={skill} onRemoved={() => setPublics((all) => all.filter((item) => item.id !== skill.id))} />)}</ul>}
      {library.removed.length > 0 && <p className="st-note">{t("最近删除：{{list}}", { list: library.removed.map((item) => aside(item.name, `${item.by === "person" ? t("本人删除") : item.reason}${sep === "；" ? "，" : ", "}${day(item.at)}`)).join(sep) })}</p>}
    </section>
  </div>;
}

function MineLine({ line, onSaved }: { line: MineSkillView; onSaved: (line: MineSkillView) => void }) {
  const t = useT();
  const { sep, quote } = marks(useLocale());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(line.current?.markdown ?? "");
  const [note, setNote] = useState("");
  const save = async (body: { markdown: string } | { restore: number }) => {
    setNote(t("保存中"));
    const response = await fetch(`/api/skills/mine/${encodeURIComponent(line.lineId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((result) => result.json() as Promise<{ ok: boolean; version?: number; code?: string }>).catch((): { ok: boolean; version?: number; code?: string } => ({ ok: false }));
    if (!response.ok) { setNote(response.code === "SKILL_EMPTY" ? t("还没有写任何规则，未保存") : response.code === "SKILL_TOO_LONG" ? t("超过 2 万字，未保存") : t("未保存")); return; }
    const restored = "restore" in body ? line.versions.find((item) => item.version === body.restore) : undefined;
    const next = { version: response.version ?? 0, by: "person" as const, at: new Date().toISOString(),
      markdown: restored?.markdown ?? ("markdown" in body ? body.markdown : ""), rules: restored?.rules ?? [], ...(restored ? { restoredFrom: restored.version } : {}) };
    onSaved({ ...line, current: next, versions: [next, ...line.versions] });
    setEditing(false);
    setNote(restored ? t("已回到第 {{from}} 版，保存为第 {{version}} 版", { from: restored.version, version: next.version }) : t("已保存为第 {{version}} 版", { version: next.version }));
  };
  const current = line.current;
  return <li className="sk-line">
    <div className="sk-line-head">
      <LineTag line={line.lineId}>{line.lineLabel}</LineTag>
      {current ? <small>{t("第 {{version}} 版", { version: current.version })} · {current.by === "person" ? (current.restoredFrom ? t("回到第 {{version}} 版", { version: current.restoredFrom }) : t("本人编辑")) : t("整理", { context: "compiled" })} · {day(current.at)}</small>
        : <p className="sk-status">{t("尚未整理：本人对这条主线的验收备注、纠正或回顾出现后自动整理")}</p>}
      <span className="sk-actions">
        <button type="button" className="secondary-button" onClick={() => { setDraft(current?.markdown ?? [t("# {{line}}：本人的做法", { line: line.lineLabel }), ...(["打法", "偏好", "红线"] as const).map((heading) => `## ${t(heading, { context: "heading" })}\n\n1. `)].join("\n\n") + "\n"); setEditing(!editing); }}>{editing ? t("取消") : current ? t("编辑") : t("手写一份")}</button>
      </span>
    </div>
    {editing ? <div className="sk-edit">
      <textarea aria-label={t("「{{line}}」主线 skill 全文", { line: line.lineLabel })} value={draft} rows={14} onChange={(event) => setDraft(event.target.value)} />
      <button type="button" className="secondary-button" onClick={() => save({ markdown: draft })} disabled={!draft.trim()}>{t("保存为新版本")}</button>
    </div> : current && <>
      {current.rules.length > 0 && <ol className="sk-rules">{current.rules.map((rule, index) => <li key={index}>
        <Tag tone={rule.kind === "redline" ? "risk" : "neutral"}>{t(KIND[rule.kind])}</Tag>
        <p className="gen">{rule.text}</p>
        {/* Where the rule came from is mostly the person's own words, quoted. */}
        <p className="sk-source" data-user-text>{rule.sources.length ? <Clamp lines={1} text={t("来源：{{sources}}", { sources: rule.sourceLabels.join(sep) }) + (rule.quote ? quote(rule.quote) : "")} />
          : <>{t("来源：")}<a href={rule.url} target="_blank" rel="noreferrer">{t("平台规则页面")}</a>{rule.quote && quote(rule.quote)}</>}</p>
      </li>)}</ol>}
      <details className="advanced sk-full"><summary>{t("全文")}</summary><Markdown className="long-form" text={current.markdown.replace(/^---[\s\S]*?\n---\n/, "")} /></details>
      {line.versions.length > 1 && <details className="advanced"><summary>{t("历次版本 · {{n}}", { n: line.versions.length })}</summary>
        <ul className="st-list">{line.versions.map((version) => <li key={version.version}>
          <span>{t("第 {{version}} 版", { version: version.version })}</span><small>{version.by === "person" ? (version.restoredFrom ? t("回到第 {{version}} 版", { version: version.restoredFrom }) : t("本人编辑")) : t("整理 · {{count}} 条", { count: version.rules.length })} · {day(version.at)}</small>
          {version.version !== current.version && <button type="button" className="secondary-button" onClick={() => save({ restore: version.version })}>{t("回到此版")}</button>}
        </li>)}</ul>
      </details>}
    </>}
    {note && <p role="status" className="st-note">{note}</p>}
  </li>;
}

function PublicSkill({ skill, onRemoved }: { skill: PublicSkillView; onRemoved: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { sep } = marks(locale);
  const [note, setNote] = useState("");
  const verdict = VERDICT[skill.verdict];
  const flagged = [...new Set(skill.findings.map((finding) => t(RULE[finding.rule] ?? finding.rule)))];
  return <li className="sk-public">
    <div className="sk-line-head">
      <strong>{skill.name}</strong><Tag>{t(skill.category)}</Tag><Tag tone={verdict.tone}>{t(verdict.label)}</Tag>
      <span className="sk-actions"><ConfirmDelete name={t("公开 skill「{{name}}」", { name: skill.name })} onConfirm={async () => {
        const ok = await fetch(`/api/skills/public/${encodeURIComponent(skill.id)}`, { method: "DELETE" }).then((response) => response.ok).catch(() => false);
        if (ok) onRemoved(); else setNote(t("删除未完成"));
      }} /></span>
    </div>
    <p className="sk-desc" data-user-text><Clamp text={skill.description} /></p>
    <dl className="sk-facts">
      <dt>{t("来源")}</dt><dd><a href={skill.url} target="_blank" rel="noreferrer">{skill.repo.replace("https://github.com/", "")}{skill.path ? `/${skill.path}` : ""}</a> · {t("提交", { context: "commit" })} <span className="mono">{skill.commit.slice(0, 7)}</span></dd>
      <dt>{t("许可证")}</dt><dd>{skill.license}</dd>
      <dt>{t("扫描")}</dt><dd>{skill.risk === "high" || skill.injection ? t("发现{{found}}，脚本未安装", { found: locale === "en" ? joinList(locale, flagged) : flagged.join("、") }) : t("未发现风险")} · {t("{{count}} 个文件已记录校验值", { count: skill.files })}{skill.skipped ? t("，{{count}} 个非文本文件未取回", { count: skill.skipped }) : ""}</dd>
      <dt>{t("审查")}</dt><dd className="gen"><Clamp lines={1} text={skill.reasons.join(sep)} /></dd>
      <dt>{t("上次调用")}</dt><dd>{skill.lastUsedAt === skill.installedAt ? t("尚未调用（{{day}} 安装）", { day: day(skill.installedAt) }) : day(skill.lastUsedAt)}</dd>
    </dl>
    {note && <p role="status" className="st-note">{note}</p>}
  </li>;
}

function GrownFlow({ flow, onChanged }: { flow: GrownSkillView; onChanged: (flow: GrownSkillView | undefined) => void }) {
  const t = useT();
  const { sep, aside, colon } = marks(useLocale());
  const [note, setNote] = useState("");
  const send = async (method: "POST" | "DELETE", body?: object) => fetch(`/api/skills/grown/${encodeURIComponent(flow.id)}`,
    { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((response) => response.ok).catch(() => false);
  // 「登录」 and 「立即运行」 are carried out by the worker; its refusal says why in words.
  const act = async (body: object, success: string): Promise<{ ok: boolean; code?: string }> => {
    const result = await fetch(`/api/skills/grown/${encodeURIComponent(flow.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((response) => response.json() as Promise<{ ok: boolean; code?: string; message?: string }>).catch(() => ({ ok: false, message: t("未完成") }));
    setNote(result.ok ? success : result.message || t("未完成"));
    return result;
  };
  // Services whose login window this page opened: 「我已登录」 closes it and records the login.
  const [opened, setOpened] = useState<string[]>([]);
  const verdict = VERDICT[flow.verdict];
  const person = flow.steps.filter((step) => step.person);
  const waiting = flow.status === "needs_consent";
  // 「按需」 is how the schedule label names a workflow used on request (compared, not shown; i18n-ignore on the next line).
  const onRequest = flow.schedule === "按需" || flow.schedule === t("按需");
  const accessLogin = (item: GrownSkillView["access"][number]) => item.login ? item.loggedInAt ? t("{{day}} 登录", { day: day(item.loggedInAt) }) : t("需本人登录") : t("公开页面");
  return <li className="sk-public">
    <div className="sk-line-head">
      {flow.lines[0] && <LineTag line={flow.lines[0]}>{flow.lineLabel || flow.lines[0]}</LineTag>}<strong className="gen"><Clamp text={flow.summary} /></strong><Tag>{t(flow.category)}</Tag>
      <Tag tone={flow.status === "active" ? "ok" : waiting ? "warn" : "neutral"}>{flow.status === "active" ? t("启用", { context: "state" }) : waiting ? t("待本人确认风险") : t("已关闭")}</Tag>
      {flow.verdict === "text_only" && <Tag tone={verdict.tone}>{t(verdict.label)}</Tag>}
      <span className="sk-actions">
        {waiting ? <button type="button" className="secondary-button" onClick={async () => {
          if (await send("POST", { action: "consent" })) onChanged({ ...flow, status: "active", consentedAt: new Date().toISOString() }); else setNote(t("未保存"));
        }}>{t("接受风险并启用")}</button> : <button type="button" className="secondary-button" onClick={async () => {
          const status = flow.status === "active" ? "off" : "active";
          if (await send("POST", { status })) onChanged({ ...flow, status }); else setNote(t("未保存"));
        }}>{flow.status === "active" ? t("关闭") : t("启用")}</button>}
        {flow.access.filter((item) => item.login).map((item) => opened.includes(item.service)
          ? <button key={item.service} type="button" className="secondary-button" onClick={async () => {
            if ((await act({ action: "login_done", service: item.service }, t("已记下{{service}}的登录，登录窗口已关闭", { service: item.service }))).ok) {
              setOpened((all) => all.filter((name) => name !== item.service));
              onChanged({ ...flow, access: flow.access.map((one) => one.service === item.service ? { ...one, loggedInAt: new Date().toISOString() } : one) });
            }
          }}>{t("我已登录{{service}}", { service: item.service })}</button>
          : <button key={item.service} type="button" className="secondary-button" onClick={async () => {
            // A window opened from another page or tab is still open: offer 「我已登录」 here too.
            const result = await act({ action: "login", service: item.service }, t("已打开{{service}}的登录窗口：在窗口里自己登录，登录后点「我已登录{{service}}」", { service: item.service }));
            if (result.ok || result.code === "LOGIN_WINDOW_OPEN") setOpened((all) => [...all, item.service]);
          }}>{item.loggedInAt ? t("重新登录{{service}}", { service: item.service }) : t("登录{{service}}", { service: item.service })}</button>)}
        {flow.status === "active" && flow.action === "run" && <button type="button" className="secondary-button"
          onClick={() => { void act({ action: "run" }, t("已交给助手，做好后通知")); }}>{t("立即运行")}</button>}
        <button type="button" className="secondary-button" aria-pressed={flow.pinned} onClick={async () => {
          if (await send("POST", { pinned: !flow.pinned })) onChanged({ ...flow, pinned: !flow.pinned }); else setNote(t("未保存"));
        }}>{flow.pinned ? t("已保留") : t("保留")}</button>
        <ConfirmDelete name={t("工作流「{{name}}」", { name: flow.summary })} onConfirm={async () => { if (await send("DELETE")) onChanged(undefined); else setNote(t("删除未完成")); }} />
      </span>
    </div>
    <dl className="sk-facts">
      <dt>{t("时间")}</dt><dd>{flow.schedule}{flow.action === "remind" ? t("，到点提醒") : onRequest ? t("，同类任务出现时使用") : t("，到点由助手执行")}</dd>
      <dt>{t("来由")}</dt><dd>{flow.origin} · {day(flow.createdAt)}</dd>
      {flow.access.length > 0 && <><dt>{t("读取")}</dt><dd>{flow.consentedAt
          // Like the risks: in full until accepted, then one line with 「全文」.
          ? <span className="gen"><Clamp lines={1} text={flow.access.map((item) => aside(item.service, accessLogin(item)) + colon + item.how).join(sep)} /></span>
          : flow.access.map((item) => <span key={item.service} className="gen">
        {aside(item.service, accessLogin(item)) + colon + item.how}<br /></span>)}</dd>
        <dt>{t("风险")}</dt><dd className="gen">{flow.consentedAt
          // Read in full before 「接受风险并启用」; once accepted, one line with 「全文」.
          ? <Clamp lines={1} text={t("{{risks}}。本人于 {{day}} 接受", { risks: flow.risks.join(sep), day: day(flow.consentedAt) })} />
          : <>{flow.risks.map((risk) => <span key={risk}>{risk}<br /></span>)}{t("本人接受前不会运行")}</>}</dd></>}
      <dt>{t("步骤")}</dt><dd><Clamp text={flow.steps.map((step) => step.person ? t("{{step}}（本人）", { step: step.title }) : step.title).join(" → ")} /></dd>
      {person.length > 0 && <><dt>{t("本人完成")}</dt><dd>{person.map((step) => step.title).join(sep)}</dd></>}
      <dt>{t("检查")}</dt><dd>{flow.risk === "high" ? t("脚本扫描发现风险，只用文字") : t("脚本扫描未发现风险")} · {t("{{count}} 个文件已记录校验值", { count: flow.files })}</dd>
      <dt>{t("审查")}</dt><dd className="gen"><Clamp lines={1} text={flow.reasons.join(sep)} /></dd>
      <dt>{t("上次使用")}</dt><dd>{flow.lastRunAt ? t("{{day}} 执行", { day: day(flow.lastRunAt) }) : day(flow.lastUsedAt)}{flow.pinned ? "" : t("；30 天未用会被移除，保留后不再移除")}</dd>
    </dl>
    {flow.skillText && <details className="advanced sk-full"><summary>{t("工作流全文")}</summary><Markdown className="long-form" text={flow.skillText} /></details>}
    {note && <p role="status" className="st-note">{note}</p>}
  </li>;
}

/** Removing is not undone, so it takes a second click: 「删除」 becomes 「确认删除」 for a few seconds. */
function ConfirmDelete({ name, onConfirm }: { name: string; onConfirm: () => Promise<void> }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  return <button type="button" className="secondary-button" aria-label={armed ? t("确认删除{{name}}", { name }) : t("删除{{name}}", { name })} onClick={async () => {
    if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 5000); return; }
    await onConfirm();
  }}>{armed ? t("确认删除") : t("删除")}</button>;
}

/** The list separator and quotation marks of the page's language: 「a；b」 and 「quote」, or "a; b" and "quote". */
const marks = (locale: string) => locale === "en"
  ? { sep: "; ", quote: (text: string) => `"${text}"`, aside: (head: string, note: string) => `${head} (${note})`, colon: ": " }
  : { sep: "；", quote: (text: string) => `「${text}」`, aside: (head: string, note: string) => `${head}（${note}）`, colon: "：" };

const SOURCE = { built_in: "内置", detected: "使用记录", person: "本人添加" } as const;

/**
 * The AI tools plans assume (docs/skills-library.md §7): the assistant's own, the coding agents seen in use, and what the person names.
 * Each step of a plan says which one speeds it and is timed with it, so a tool listed here changes how much a day can hold.
 */
function AiToolsCard({ initial }: { initial: AiTool[] }) {
  const t = useT();
  const [tools, setTools] = useState(initial);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AiToolKind>("chat");
  const [goodFor, setGoodFor] = useState("");
  const [note, setNote] = useState("");
  const send = (method: "POST" | "DELETE", body: object) => fetch("/api/ai-tools", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => (response.ok ? await response.json() : undefined) as { tool?: AiTool } | undefined).catch(() => undefined);
  return <section className="st-card st-card-wide" aria-label={t("可用的 AI 工具")}>
    <header><h3>{t("可用的 AI 工具 · {{n}}", { n: tools.length })}</h3><small>{t("步骤拆分、估时、教程与工作流按这些工具规划：能由助手整份做的交给助手，本人的步骤写明用哪个工具、怎么用，时间按用了工具计算")}</small></header>
    <ul className="st-prefs">{tools.map((tool) => <li key={tool.id}>
      <Tag>{t(AI_TOOL_KIND_LABEL[tool.kind])}</Tag><strong>{tool.source === "built_in" ? t(tool.name) : tool.name}</strong>
      <span className="st-pref-text">{tool.source === "person" ? tool.goodFor : t(tool.goodFor)}{tool.by === "system" ? t("（由助手执行）") : ""}</span>
      <small>{t(SOURCE[tool.source])}</small>
      {tool.source === "person" && <button type="button" className="st-pref-remove" aria-label={t("删除工具：{{name}}", { name: tool.name })} title={t("删除")} onClick={async () => {
        if (await send("DELETE", { id: tool.id })) setTools((all) => all.filter((item) => item.id !== tool.id)); else setNote(t("删除未完成"));
      }}>×</button>}
    </li>)}</ul>
    <form className="sk-tool-form" onSubmit={async (event) => {
      event.preventDefault();
      const result = await send("POST", { name, kind, goodFor });
      if (!result?.tool) { setNote(t("未添加：请写工具名称")); return; }
      setTools((all) => [...all.filter((item) => item.name.toLowerCase() !== result.tool!.name.toLowerCase()), result.tool!]);
      setName(""); setGoodFor(""); setNote(t("已添加「{{name}}」，之后的规划会用到它", { name: result.tool.name }));
    }}>
      <label><span>{t("工具")}</span><input value={name} maxLength={40} placeholder={t("例如 剪映、NotebookLM")} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>{t("类别")}</span><select value={kind} onChange={(event) => setKind(event.target.value as AiToolKind)}>
        {(Object.keys(AI_TOOL_KIND_LABEL) as AiToolKind[]).filter((item) => item !== "assistant").map((item) => <option key={item} value={item}>{t(AI_TOOL_KIND_LABEL[item])}</option>)}
      </select></label>
      <label className="sk-tool-good"><span>{t("用来做什么")}</span><input value={goodFor} maxLength={120} placeholder={t("例如 自动字幕、粗剪")} onChange={(event) => setGoodFor(event.target.value)} /></label>
      <button type="submit" className="secondary-button" disabled={!name.trim()}>{t("添加")}</button>
    </form>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
