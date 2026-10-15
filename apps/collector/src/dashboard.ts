import { ONBOARDING_STAGES } from "../../../packages/core/src/onboarding-turn-schema";
import type { D1 } from "./index";

/**
 * The owner's view of every installed copy (docs/local-installer.md, 接收端): who is active, how far each got, where work sits
 * longest, which codes come up, and how each Skill runs. Built from the events table alone; nothing here can show what a tester
 * wrote, because none of it was ever received.
 */
export type DashboardData = {
  installs: Array<{ install: string; account: string | null; version: string; firstSeen: string; lastSeen: string; events: number }>;
  funnel: Array<{ step: string; installs: number }>;
  stuck: Array<{ stage: string; open: number; oldest: string }>;
  errors: Array<{ code: string; count: number; installs: number }>;
  skills: Array<{ skill: string; runs: number; failed: number; repaired: number; averageMs: number; longestMs: number; input: number; cached: number; output: number }>;
  pages: Array<{ page: string; views: number }>;
  snapshots: Array<{ id: string; install: string; version: string; receivedAt: string; bytes: number; feedback: string }>;
};

/** Steps after the interview, each counted when an install has at least one such event. */
const LATER_STEPS: Array<[string, string]> = [["capture.created", "首次收集"], ["milestone.proposed", "首个里程碑"], ["human.started", "首次计时"],
  ["portrait.written", "画像"], ["agent.task.completed", "首次助手任务"], ["evidence.accepted", "首次验收"]];
const STAGE_LABEL: Record<string, string> = { orientation: "访谈·开场", lines: "访谈·主线", situation: "访谈·现状", compass: "访谈·指南针",
  energy: "访谈·精力", details: "访谈·细节" };
const TERMINAL = new Set(["accepted", "archived"]);

export async function dashboardData(db: D1): Promise<DashboardData> {
  const installs = (await db.prepare(`SELECT i.install, i.account, i.version, i.first_seen, i.last_seen,
      (SELECT COUNT(*) FROM events e WHERE e.install = i.install) AS events
    FROM installs i ORDER BY i.last_seen DESC LIMIT 200`).all<{ install: string; account: string | null; version: string; first_seen: string; last_seen: string; events: number }>()).results;

  const rounds = (await db.prepare("SELECT install, stage FROM events WHERE type = 'onboarding.round' AND stage IS NOT NULL").all<{ install: string; stage: string }>()).results;
  const furthest = new Map<string, number>();
  for (const round of rounds) {
    const index = (ONBOARDING_STAGES as readonly string[]).indexOf(round.stage);
    if (index >= 0) furthest.set(round.install, Math.max(furthest.get(round.install) ?? -1, index));
  }
  const reached = (await db.prepare(`SELECT type, COUNT(DISTINCT install) AS installs FROM events WHERE type IN (${LATER_STEPS.map(() => "?").join(", ")}) GROUP BY type`)
    .bind(...LATER_STEPS.map(([type]) => type)).all<{ type: string; installs: number }>()).results;
  const started = (await db.prepare("SELECT COUNT(*) AS n FROM installs").first<{ n: number }>())?.n ?? 0;
  const funnel = [{ step: "安装", installs: Number(started) },
    ...ONBOARDING_STAGES.map((stage, index) => ({ step: STAGE_LABEL[stage] ?? stage, installs: [...furthest.values()].filter((value) => value >= index).length })),
    ...LATER_STEPS.map(([type, step]) => ({ step, installs: Number(reached.find((row) => row.type === type)?.installs ?? 0) }))];

  // Where work orders are sitting now: each one's latest transition, grouped by the state it moved into.
  const latest = (await db.prepare(`SELECT e.stage, e.at FROM events e WHERE e.type = 'work_order.transitioned' AND e.stage IS NOT NULL
      AND e.id = (SELECT MAX(x.id) FROM events x WHERE x.install = e.install AND x.entity = e.entity AND x.type = 'work_order.transitioned')`)
    .all<{ stage: string; at: string }>()).results;
  const byStage = new Map<string, { open: number; oldest: string }>();
  for (const row of latest) {
    if (TERMINAL.has(row.stage)) continue;
    const entry = byStage.get(row.stage) ?? { open: 0, oldest: row.at };
    entry.open += 1;
    if (row.at < entry.oldest) entry.oldest = row.at;
    byStage.set(row.stage, entry);
  }
  const stuck = [...byStage].map(([stage, entry]) => ({ stage, ...entry })).sort((a, b) => a.oldest.localeCompare(b.oldest));

  const errors = (await db.prepare(`SELECT code, COUNT(*) AS count, COUNT(DISTINCT install) AS installs FROM events WHERE code IS NOT NULL
    GROUP BY code ORDER BY count DESC LIMIT 25`).all<{ code: string; count: number; installs: number }>()).results.map((row) => ({ code: row.code, count: Number(row.count), installs: Number(row.installs) }));
  const skills = (await db.prepare(`SELECT skill, COUNT(*) AS runs, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN repairs > 0 THEN 1 ELSE 0 END) AS repaired, AVG(ms) AS average_ms, MAX(ms) AS longest_ms,
      SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output
    FROM events WHERE type = 'skill.run' AND skill IS NOT NULL GROUP BY skill ORDER BY runs DESC`).all<Record<string, number | string | null>>()).results
    .map((row) => ({ skill: String(row.skill), runs: Number(row.runs), failed: Number(row.failed ?? 0), repaired: Number(row.repaired ?? 0),
      averageMs: Math.round(Number(row.average_ms ?? 0)), longestMs: Number(row.longest_ms ?? 0), input: Number(row.input ?? 0), cached: Number(row.cached ?? 0), output: Number(row.output ?? 0) }));
  const pages = (await db.prepare("SELECT page, COUNT(*) AS views FROM events WHERE type = 'page.viewed' AND page IS NOT NULL GROUP BY page ORDER BY views DESC")
    .all<{ page: string; views: number }>()).results.map((row) => ({ page: row.page, views: Number(row.views) }));
  const snapshots = (await db.prepare("SELECT id, install, version, received_at, bytes, feedback FROM snapshots ORDER BY received_at DESC LIMIT 50")
    .all<{ id: string; install: string; version: string; received_at: string; bytes: number; feedback: string }>()).results
    .map((row) => ({ id: row.id, install: row.install, version: row.version, receivedAt: row.received_at, bytes: Number(row.bytes), feedback: row.feedback }));

  return { installs: installs.map((row) => ({ install: row.install, account: row.account, version: row.version, firstSeen: row.first_seen,
    lastSeen: row.last_seen, events: Number(row.events) })), funnel, stuck, errors, skills, pages, snapshots };
}

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
const table = (head: string[], rows: unknown[][]) => rows.length
  ? `<table><thead><tr>${head.map((cell) => `<th>${escape(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : "<p class=\"empty\">暂无</p>";
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "—";

/** Every value is escaped, whatever it is: the whitelist is the first guard, this is the second. */
export function renderDashboard(data: DashboardData): string {
  const top = Math.max(1, ...data.funnel.map((step) => step.installs));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crossline 内测</title>
<style>body{font:14px Arial,"Microsoft YaHei",sans-serif;margin:16px;color:#1c1c1c;background:#fff}h1{font-size:18px}h2{font-size:15px;margin-top:24px}
table{border-collapse:collapse;width:100%;max-width:1100px}th,td{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left;font-size:13px;vertical-align:top}
.bar{display:inline-block;height:10px;background:#3a5a8c;margin-right:6px}.empty{color:#555}code{font-size:12px}</style></head><body>
<h1>Crossline 内测使用记录</h1>
<h2>安装（${data.installs.length}）</h2>
${table(["安装", "账号哈希", "版本", "首次", "最近", "事件数"], data.installs.map((row) => [`<code>${escape(row.install.slice(0, 8))}</code>`,
    `<code>${escape((row.account ?? "").slice(0, 10))}</code>`, escape(row.version), escape(row.firstSeen.slice(0, 16)), escape(row.lastSeen.slice(0, 16)), escape(row.events)]))}
<h2>漏斗</h2>
${table(["步骤", "安装数"], data.funnel.map((step) => [escape(step.step), `<span class="bar" style="width:${Math.round((step.installs / top) * 240)}px"></span>${escape(step.installs)}`]))}
<h2>停留最久的状态</h2>
${table(["状态", "停留中的任务", "最早进入"], data.stuck.map((row) => [escape(row.stage), escape(row.open), escape(row.oldest.slice(0, 16))]))}
<h2>报错码</h2>
${table(["代码", "次数", "涉及安装"], data.errors.map((row) => [`<code>${escape(row.code)}</code>`, escape(row.count), escape(row.installs)]))}
<h2>Skill 运行</h2>
${table(["Skill", "次数", "失败率", "修正率", "平均耗时", "最长", "输入 token", "缓存", "输出"], data.skills.map((row) => [escape(row.skill), escape(row.runs),
    escape(percent(row.failed, row.runs)), escape(percent(row.repaired, row.runs)), escape(seconds(row.averageMs)), escape(seconds(row.longestMs)),
    escape(row.input), escape(row.cached), escape(row.output)]))}
<h2>页面</h2>
${table(["页面", "打开次数"], data.pages.map((row) => [`<code>${escape(row.page)}</code>`, escape(row.views)]))}
<h2>诊断快照</h2>
${table(["收到", "安装", "版本", "大小", "说明", ""], data.snapshots.map((row) => [escape(row.receivedAt.slice(0, 16)), `<code>${escape(row.install.slice(0, 8))}</code>`,
    escape(row.version), escape(`${Math.round(row.bytes / 1024)} KB`), escape(row.feedback), `<a href="/dashboard/snapshots/${escape(row.id)}">下载</a>`]))}
</body></html>`;
}
