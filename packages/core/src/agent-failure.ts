import type { AskProgress } from "./asks";
import { joinList, tFor, type Locale } from "./i18n";

/**
 * Why the assistant did not finish something, and what follows from it (the owner's item 10, 2026-10-15).
 *
 * A stopped run used to become one line — 「助手不会自动重试，该任务转为本人处理」 — whatever had stopped it, so a run the
 * worker lost to its own restart landed on the person exactly like one that would have had to send something. Now every stop is
 * read into one of four kinds, and the kind decides what happens next:
 *
 * - `interrupted` — the run was cut off from outside (a restart, a stall, a timeout, the runtime gone, the quota out). Nothing about
 *   the work itself is wrong, so it is run again by itself, at most `AGENT_MAX_RUNS` runs in a row, each later than the last.
 * - `external` — going on could act beyond this machine: a site's security check or login (trying again may get the account
 *   restricted), paying, sending, publishing, uploading. Never tried again by itself; the person decides.
 * - `needs_input` — only the person knows or can choose what is missing (including the person having stopped it).
 * - `hard` — it cannot be done this way (the guard refused, the result did not hold up, it went round in circles); said plainly,
 *   with a way around it.
 */
export type AgentFailureKind = "interrupted" | "external" | "needs_input" | "hard";
export type AgentFailure = {
  kind: AgentFailureKind;
  /** Run again by itself (interrupted only). */
  retry: boolean;
  /** Where it stopped and why, in the person's words. */
  stuckAt: string;
  /** What only the person can supply or decide for it to go on. */
  needs: string[];
  /** For `external`: why it is not tried again by itself. */
  noRetryWhy?: string;
  /** For `hard`: another way to get it done. */
  workaround?: string;
  /** Going on could act outside this machine. */
  external: boolean;
};

/** What a stopped run says about itself: its status, the code and message it stopped with, and what the guard refused on the way. */
export type StoppedRun = {
  status: string; blockerCode: string; blockerMessage: string;
  /** Rules of the guard decisions the run was refused (`agent-guard.ts`). */
  deniedRules?: string[];
  /** A site it reads behind the person's login stopped it, or is paused after a security check. */
  siteStopped?: boolean;
};

/** Guard rules whose refusal means the run tried to act outside the machine. */
const EXTERNAL_RULES = new Set(["send.mail", "send.webhook", "publish.package", "publish.social", "money", "net.upload", "git.remote", "mcp.send", "mcp.write"]);
/** Guard rules that ask the person, refused because nobody answered in time. */
const ASK_RULES: Record<string, string> = {
  "install.global": "允许在系统里安装软件", "delete.recursive": "允许批量删除文件", "move.bulk": "允许批量移动文件"
};
const EXTERNAL_WORDS: Array<[RegExp, string, string]> = [
  [/安全验证|验证码|滑块|captcha|unusual traffic|访问异常|请求过于频繁|security check|verify (that )?you are (a )?human|too many requests|rate limited/i, "网站出现了安全验证", "再次尝试可能反复触发安全验证，账号可能因此受限"],
  [/需要登录|要求登录|未登录.*网站|登录已失效|(login|log in|sign in|sign-in) (is )?required|please (log|sign) in|not (logged|signed) in|session expired/i, "要读的网站需要本人登录", "登录只能由本人完成；未登录时反复读取可能触发网站的风控"],
  [/付款|支付|购买|下单|充值|\b(pay|payment|purchase|checkout|buy|top up)\b/i, "这一步要花钱", "花钱只能由本人决定"],
  [/发送|发邮件|发消息|发布|发帖|投稿|上传|\b(send|sending|email|e-mail|post|posting|publish|publishing|upload|uploading|submit)\b/i, "这一步要对外发送或发布", "对外发出的东西收不回来，只能由本人做"]
];
/** The runner's own refusals of a result (written for the model to repair, so never shown as they are). */
export const AGENT_REFUSAL_WORDS: Record<string, string> = {
  AGENT_ARTIFACT_MISSING: "助手报告的产出文件在任务目录里并不存在",
  AGENT_ARTIFACT_EMPTY: "助手报告的产出文件是空的",
  AGENT_ARTIFACT_PATH: "助手报告的产出不在任务目录内",
  AGENT_EVIDENCE_MISSING: "助手的结果缺少可以核对的证据",
  AGENT_UNCHECKED: "助手做出了产出，却没有做任何自查",
  AGENT_SUMMARY_INVALID: "助手的总结格式不完整"
};
const INTERRUPTED_WORDS: Record<string, string> = {
  AGENT_RUN_LOST: "后台进程重启，这次运行中断",
  SKILL_STALLED: "Codex 长时间没有任何输出，运行停滞",
  SKILL_TIMEOUT: "运行超时",
  SKILL_CANCELED: "Codex 运行时取消了这一轮",
  SKILL_CANCELLED: "Codex 运行时取消了这一轮",
  SKILL_RUNTIME_EXITED: "Codex 运行时退出了",
  // Runs recorded before the runner mapped a dropped compute node to SKILL_RUNTIME_EXITED.
  CROSSLINE_NODE_DISCONNECTED: "算力节点断开了连接，这次运行中断",
  SKILL_RUNTIME_FAILED: "Codex 运行时出错",
  SKILL_THREAD_LOST: "Codex 运行时重启过，这段运行丢失了",
  SKILL_CONFIG_FAILED: "Codex 运行时的设置没能切换",
  SKILL_USAGE_LIMIT: "Codex 用量额度用完了，额度恢复后再接着做",
  SKILL_UNAUTHENTICATED: "Codex 未登录或登录已失效，重新登录后再接着做",
  CODEX_SUPERVISOR_UNAVAILABLE: "Codex 运行时暂时不可用"
};
const NEEDS_INPUT = /缺少|缺乏|需要本人|请本人|没有提供|未提供|请提供|找不到.{0,12}(文件|资料|材料)|无法确定|需要选择|需要决定|\bmissing\b|\black(s|ing)?\b|needs? (the person|you|the user)|please provide|not provided|could not find .{0,20}(file|material|document|source)|cannot determine|can't determine|needs? (a )?(choice|decision)/i;
const clause = (text: string) => text.trim().replace(/[。．.；;，,\s]+$/u, "");

export function classifyAgentFailure(run: StoppedRun, locale?: Locale): AgentFailure {
  const t = tFor(locale);
  const code = run.blockerCode;
  const message = clause(run.blockerMessage);
  // The run's own words when it gave some (shown as written), else the fallback in the person's language.
  const said = (fallback: string) => message && !/^[A-Z][A-Z_]+$/.test(message) ? message : t(fallback);
  const denied = run.deniedRules ?? [];
  if (code === "AGENT_CANCELLED") return { kind: "needs_input", retry: false, external: false, stuckAt: t("本人中止了这次运行"),
    needs: [t("决定接下来怎么做：按补充的要求重试、本人接手，或不做了")] };
  const external = (stuckAt: string, why: string): AgentFailure => ({ kind: "external", retry: false, external: true, stuckAt, noRetryWhy: t(why),
    needs: [t("本人先处理好这一步（例如登录、完成验证、自己发出），再决定是否让助手接着做")] });
  if (run.siteStopped || (code === "AGENT_LOOP_STOPPED" && /网站|读取|\b(site|website|page|reading)\b/i.test(message)))
    return external(said("读取网站时被拦下"), "再次尝试可能反复触发网站的安全验证，账号可能因此受限");
  const outward = denied.find((rule) => EXTERNAL_RULES.has(rule));
  if (outward) return external(t("护栏拦下了一个对外的动作（{{action}}）", { action: t(outward.startsWith("send") || outward === "mcp.send" ? "发送"
    : outward.startsWith("publish") ? "发布" : outward === "money" ? "付款" : outward === "git.remote" ? "推送到远端" : "上传", { context: "act" }) }),
    "对外发出、付款一类的事只能由本人做，助手不会再试");
  if (run.status === "stale") return { kind: "interrupted", retry: true, external: false, stuckAt: t("运行超过 8 小时没有结果，进程大概已经中断"), needs: [] };
  if (INTERRUPTED_WORDS[code] || /^(SKILL_|CODEX_)/.test(code))
    return { kind: "interrupted", retry: true, external: false, stuckAt: INTERRUPTED_WORDS[code] ? t(INTERRUPTED_WORDS[code]) : said("Codex 运行时出错"), needs: [] };
  for (const [pattern, stuckAt, why] of EXTERNAL_WORDS) if (pattern.test(message)) return external(said(stuckAt), why);
  const asked = denied.find((rule) => ASK_RULES[rule]);
  if (asked) return { kind: "needs_input", retry: false, external: false, stuckAt: t("助手需要本人{{what}}，没人回答，已拒绝", { what: t(ASK_RULES[asked]!) }),
    needs: [t("是否{{what}}；或者告诉助手不这样做时该怎么办", { what: t(ASK_RULES[asked]!) })] };
  if (code === "CATEGORY_REQUIRED" || NEEDS_INPUT.test(message))
    return { kind: "needs_input", retry: false, external: false, stuckAt: said("缺少只有本人知道的信息"), needs: [said("补充助手缺的信息或做出选择")] };
  if (AGENT_REFUSAL_WORDS[code]) return { kind: "hard", retry: false, external: false, stuckAt: t("{{what}}，结果没有被采纳", { what: t(AGENT_REFUSAL_WORDS[code]) }), needs: [],
    workaround: t("只要求一份 Markdown 文件，每一条写明出处，写完自己读一遍再交") };
  if (code === "AGENT_LOOP_STOPPED") return { kind: "hard", retry: false, external: false, stuckAt: said("同一个做法反复失败，已自动停下"), needs: [],
    workaround: t("先用已经写出的文件，把这一步拆小，只做其中最明确的一部分") };
  if (denied.length) return { kind: "hard", retry: false, external: false, stuckAt: said("护栏拒绝了助手要做的事"), needs: [],
    workaround: t("不碰受保护的位置：需要的资料由本人放进任务材料，助手只在自己的目录里做") };
  if (code === "AGENT_OWNER_ONLY" || code === "WORKSPACE_OWNER_MISSING" || /^(MODEL_|RUNTIME_)/.test(code))
    return { kind: "hard", retry: false, external: false, stuckAt: said("这个账号不能用这台电脑上的助手"), needs: [], workaround: t("由本人完成") };
  return { kind: "hard", retry: false, external: false, stuckAt: said("运行没有完成，原因没有记录下来"), needs: [],
    workaround: t("把要求说得更具体（要哪份文件、写到什么程度），再让助手做一次") };
}

/**
 * The one retry rule for every run of the assistant (a preparation step, a whole order, a step handed over by hand or by 「自动交给
 * Agent」, a workflow being grown, a workflow's scheduled run): an interrupted run is run again, at most this many interrupted runs in
 * a row, the next no sooner than the backoff after the last. It replaces the preparation steps' and the growing runs' own copies.
 */
export const AGENT_MAX_RUNS = 3;
/** Minutes to wait after the first and the second interruption before running again. */
export const AGENT_RETRY_BACKOFF_MINUTES = [5, 30] as const;

/** One run of the assistant, as the ledger knows it (`listAgentTasks`). */
export type AgentRunRow = StoppedRun & {
  taskId: string; workOrderId: string; stepId: string; title: string; requestedAt: string;
  /** When it stopped (blocked); a stale run counts as stopped eight hours after it began. */
  endedAt?: string;
  /** Who started its chain: the person (「交给 Agent」, a retry they asked for) or the system. */
  by?: "person" | "system";
  /** A run stopped part way whose files were offered for review as they were. */
  partial?: boolean;
};
/** The person's answers about stopped runs: retry (with their words), or closed (they do it, or it is dropped). */
export type AgentChainMarks = {
  retries: Array<{ taskId: string; at: string; note: string; approach?: string }>;
  closed: Array<{ taskId: string; at: string; how: string }>;
};
export type AgentChainState = "running" | "done" | "closed" | "retry" | "stuck";
/** One piece of work and every run of it, oldest first. */
export type AgentChain = {
  key: string; runs: AgentRunRow[]; latest: AgentRunRow; state: AgentChainState;
  failure?: AgentFailure;
  /** When the next run is due (state `retry`). */
  retryAt?: string;
  /** Asked for by the person (the next run carries their words and is not held to the work-starting-soon window). */
  byPerson: boolean;
  /** Runs after the first. */
  retries: number;
  /** The person's words for the next run, oldest first. */
  notes: string[];
};

/** Runs of the same piece of work: one step of one order, a whole order, or a run tied to no order (a workflow) by its title. */
export const agentChainKey = (run: Pick<AgentRunRow, "workOrderId" | "stepId" | "title">): string =>
  run.workOrderId ? `order:${run.workOrderId}#${run.stepId}` : `title:${run.title}`;

const stopped = (run: AgentRunRow) => run.status === "blocked" || run.status === "stale" || (run.partial === true && run.status === "needs_review");
const endOf = (run: AgentRunRow) => run.endedAt ?? (run.status === "stale" ? new Date(Date.parse(run.requestedAt) + 8 * 3_600_000).toISOString() : run.requestedAt);
const plusMinutes = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();

export function agentChains(runs: AgentRunRow[], marks: AgentChainMarks = { retries: [], closed: [] }, locale?: Locale): AgentChain[] {
  const t = tFor(locale);
  const groups = new Map<string, AgentRunRow[]>();
  for (const run of [...runs].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) groups.set(agentChainKey(run), [...(groups.get(agentChainKey(run)) ?? []), run]);
  const retryOf = new Map(marks.retries.map((mark) => [mark.taskId, mark]));
  const closedOf = new Map(marks.closed.map((mark) => [mark.taskId, mark]));
  return [...groups].map(([key, list]): AgentChain => {
    const latest = list.at(-1)!;
    // Every request the person made, in order (asking again while one waited adds to it rather than replacing it), each said once.
    const notes = [...new Set(list.flatMap((run) => marks.retries.filter((mark) => mark.taskId === run.taskId)
      .map((mark) => mark.approach ? t("换个方法：{{approach}}", { approach: mark.approach }) + (mark.note ? t("；{{note}}", { note: mark.note }) : "") : mark.note)
      .filter(Boolean)))];
    const base = { key, runs: list, latest, retries: list.length - 1, notes,
      byPerson: list[0]!.by === "person" || list.some((run) => retryOf.has(run.taskId)) };
    if (latest.status === "running") return { ...base, state: "running" };
    // The person asked for another run (of a stopped run, or to redo a finished one): due at once, whatever stopped it.
    const asked = retryOf.get(latest.taskId);
    if (asked) return { ...base, state: "retry", retryAt: asked.at, ...(stopped(latest) ? { failure: classifyAgentFailure(latest, locale) } : {}) };
    if (!stopped(latest)) return { ...base, state: "done" };
    const failure = classifyAgentFailure(latest, locale);
    if (closedOf.has(latest.taskId)) return { ...base, state: "closed", failure };
    if (!failure.retry || latest.partial) return { ...base, state: "stuck", failure };
    // Interrupted runs in a row, back to the last run the person asked for: a retry they asked for starts the count again.
    let inRow = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!stopped(list[i]!) || !classifyAgentFailure(list[i]!, locale).retry) break;
      inRow += 1;
      if (i > 0 && retryOf.has(list[i - 1]!.taskId)) break;
    }
    if (inRow >= AGENT_MAX_RUNS) return { ...base, state: "stuck", failure };
    return { ...base, state: "retry", failure, retryAt: plusMinutes(endOf(latest), AGENT_RETRY_BACKOFF_MINUTES[Math.min(inRow, AGENT_RETRY_BACKOFF_MINUTES.length) - 1] ?? 30) };
  });
}
export const retryDue = (chain: AgentChain, now: Date) => chain.state === "retry" && Date.parse(chain.retryAt ?? "") <= now.getTime();

/**
 * Whether a finished result may be taken as accepted without the person (the owner's rule, 2026-10-15: by default automatic, the
 * exceptions are confirmed). It replaces counting accepted results per kind (`CLEAN_RUNS_TO_TRUST`). Returns why the person must look,
 * in their words; empty means accept it and tell them. A grown workflow's 「decide whether to keep it」 is not a reason: it is kept by
 * default and the message says it can be turned off in settings.
 */
export function resultNeedsPerson(result: {
  needsHuman: Array<{ what: string }>; checksPassed: boolean; inputsModified: string[];
  /** Guard decisions on the way: refused or asked rules. */
  decisions: Array<{ rule: string; decision?: string; outcome: string }>;
  growing?: boolean;
  locale?: Locale;
}): string[] {
  const t = tFor(result.locale);
  const keepWorkflow = (what: string) => /保留.{0,8}工作流|工作流.{0,8}保留|\bkeep\b.{0,20}\bworkflow|\bworkflow\b.{0,20}\bkeep/i.test(what);
  const needs = result.needsHuman.filter((item) => !(result.growing && keepWorkflow(item.what)));
  return [
    ...(needs.length ? [t("留了 {{count}} 件事给本人：{{items}}", { count: needs.length,
      items: needs.slice(0, 3).map((item) => clause(item.what)).join(result.locale === "en" ? "; " : "；") })] : []),
    ...(!result.checksPassed ? [t("自检没有全部通过")] : []),
    ...(result.inputsModified.length ? [t("本人的原文件被改动了")] : []),
    ...(result.decisions.some((item) => EXTERNAL_RULES.has(item.rule)) ? [t("涉及对外发送、发布、上传或付款")] : []),
    ...(result.decisions.some((item) => item.decision === "ask" || ASK_RULES[item.rule]) ? [t("运行中需要过本人的许可")] : [])
  ];
}

/** The run's own record of what it did (`progress.json` beside its files, written while it runs). */
export type AgentProgressRecord = {
  commands?: Array<{ command: string; exitCode: number | null }>;
  filesChanged?: string[]; searches?: string[];
  decisions?: Array<{ rule: string; reason: string; outcome: string }>;
  plan?: { explanation: string; steps: Array<{ step: string; status: string }> };
};
const base = (file: string) => file.split(/[\\/]/).at(-1) ?? file;
const list = (items: string[], max: number, locale?: Locale) => items.length > max
  ? tFor(locale)("{{items}} 等 {{count}} 个", { items: items.slice(0, max).join(locale === "en" ? ", " : "、"), count: items.length })
  : locale === "en" ? joinList("en", items) : items.join("、");

/** How far a stopped run got and where it stopped, for the card the person decides on (`Ask.progress`). */
export function agentAskProgress(input: { title: string; failure: AgentFailure; record?: AgentProgressRecord; retries: number; exhausted: boolean; locale?: Locale }): AskProgress {
  const { record = {}, failure, locale } = input;
  const t = tFor(locale);
  const files = [...new Set((record.filesChanged ?? []).map(base).filter((name) => name && !/^(progress|audit)\.json$/i.test(name)))];
  const commands = record.commands ?? [];
  const failed = commands.filter((command) => command.exitCode !== null && command.exitCode !== 0).length;
  const declined = record.decisions?.filter((item) => item.outcome === "declined") ?? [];
  const done = [
    ...(record.searches?.length ? [t("查了 {{count}} 次资料：{{queries}}", { count: record.searches.length,
      queries: list(record.searches.map((query) => t("「{{text}}」", { text: query.slice(0, 30) })), 3, locale) })] : []),
    ...(commands.length ? [failed ? t("运行了 {{count}} 条命令，其中 {{failed}} 条出错", { count: commands.length, failed }) : t("运行了 {{count}} 条命令", { count: commands.length })] : []),
    ...(files.length ? [t("写出了 {{files}}", { files: list(files, 6, locale) })] : []),
    ...(declined.length ? [t("被护栏拦下 {{count}} 次：{{reasons}}", { count: declined.length, reasons: list([...new Set(declined.map((item) => clause(item.reason)))], 2, locale) })] : [])
  ];
  const stuckAt = input.exhausted && failure.kind === "interrupted"
    ? t("{{stuckAt}}；已自动重试 {{count}} 次，仍没做完", { stuckAt: failure.stuckAt, count: input.retries })
    : failure.stuckAt;
  const needs = failure.needs.length ? failure.needs
    : failure.kind === "interrupted" ? [t("决定是否让助手再试一次，或本人接手")] : failure.workaround ? [t("决定是否按「{{workaround}}」换个方法做", { workaround: failure.workaround })] : [];
  const title = input.title.length > 40 ? `${input.title.slice(0, 40)}…` : input.title;
  return { summary: done.length ? t("助手在做「{{title}}」，{{done}}后停下。", { title, done: done[0] }) : t("助手在做「{{title}}」，刚开始就停下了。", { title }),
    done, stuckAt, needs, external: failure.external, retries: input.retries };
}
