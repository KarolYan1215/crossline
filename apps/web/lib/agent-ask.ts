import "server-only";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { agentAskProgress, urgencyFor, type AccessContext, type AgentChain, type AgentProgressRecord, type Ask, type AskOption, type AskPreview } from "@crossline/core";
import { agentChainsFor, closeAgentTask, listAgentTasks, requestAgentRetry, takeStepBack, type AgentTaskRow } from "@crossline/db";
import { archiveWorkOrder, getStore } from "./crossline";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { localeFor, tOf } from "./locale";
import { tFor, type Translate } from "./i18n";

/**
 * The card for the assistant's work that stopped (`agent_blocked`), built from the same reading of its runs the worker retries from
 * (`agentChainsFor`): only work that will not be run again by itself is asked about — interrupted work is retried first, up to three runs —
 * and the card says how far it got, where it stopped, what only the person can supply, whether going on could act outside the machine,
 * and lets them say in their own words what to do next. The answer takes effect: a retry carries their words into the next run, 「我自己做」
 * hands the step to them, 「不做了」 drops it.
 */
const short = (text: string, length = 40) => text.length > length ? `${text.slice(0, length)}…` : text;
const outputRoot = () => process.env.CROSSLINE_AI_OUTPUT_DIR ?? path.join(homedir(), "Crossline", "ai-output");

/** The run's own record of what it did (`progress.json`), else what the ledger knows of its files. */
function progressRecord(row: AgentTaskRow | undefined, taskId: string): AgentProgressRecord {
  const directory = row?.directory || path.join(outputRoot(), taskId);
  try { return JSON.parse(readFileSync(path.join(directory, "progress.json"), "utf8")) as AgentProgressRecord; }
  catch { return { filesChanged: (row?.artifacts ?? []).map((artifact) => artifact.path) }; }
}

function previewOf(t: Translate, chain: AgentChain, row: AgentTaskRow | undefined): AskPreview {
  if (row?.partial) return { kind: "agent", href: "/approvals#assistant", label: t("查看已写出的文件") };
  if (chain.latest.workOrderId) return { kind: "agent", href: `/workbench/${encodeURIComponent(chain.latest.workOrderId)}`, label: t("查看这件事和助手的进度") };
  return { kind: "agent", href: chain.latest.taskId.startsWith("grow-") || chain.latest.taskId.startsWith("flow-") ? "/settings#skills" : "/settings#automation",
    label: t("查看助手任务") };
}

export function agentBlockedAsks(ctx: AccessContext, now: Date, today: string): Ask[] {
  const store = getStore();
  const locale = localeFor(ctx);
  const t = tFor(locale);
  const orders = new Map(store.listWorkOrders(ctx.workspaceId).map((order) => [order.id, order]));
  const rows = new Map(listAgentTasks(store, ctx.workspaceId, now).map((row) => [row.taskId, row]));
  return agentChainsFor(store, ctx.workspaceId, now, locale).filter((chain) => chain.state === "stuck" && chain.failure).map((chain): Ask => {
    const failure = chain.failure!;
    const latest = chain.latest;
    const row = rows.get(latest.taskId);
    const order = orders.get(latest.workOrderId);
    const title = latest.stepId || !order ? latest.title : order.intent;
    const exhausted = failure.kind === "interrupted";
    const progress = agentAskProgress({ title, failure, record: progressRecord(row, latest.taskId), retries: chain.retries, exhausted, locale });
    const dueDay = (order?.payload as { dueDate?: string } | undefined)?.dueDate;
    const why = failure.kind === "interrupted" ? t("{{stuck}}。先停下，等本人安排下一步。", { stuck: progress.stuckAt })
      : failure.kind === "external" ? t("{{stuck}}。不会自动重试：{{why}}。", { stuck: progress.stuckAt, why: failure.noRetryWhy })
      : failure.kind === "needs_input" ? t("{{stuck}}。需要本人：{{needs}}。", { stuck: progress.stuckAt, needs: progress.needs[0] ?? t("补充信息") })
      : failure.workaround ? t("{{stuck}}。可以换个方法：{{workaround}}。", { stuck: progress.stuckAt, workaround: failure.workaround })
      : t("{{reason}}。", { reason: progress.stuckAt });
    const options: AskOption[] = [
      ...(failure.kind === "hard" && failure.workaround ? [{ id: "alternative", label: t("换个方法重试"), detail: failure.workaround, recommended: true }] : []),
      { id: "retry", label: failure.external ? t("我已处理好，按我的补充重试") : t("按我的补充重试"), detail: t("把下面写的话交给助手，接着已写出的文件做"),
        ...(failure.kind === "interrupted" || failure.kind === "needs_input" ? { recommended: true } : {}) },
      { id: "self", label: latest.stepId ? t("我自己做这一步") : t("我自己做"), detail: latest.stepId ? t("这一步排进本人的日程，助手不再接手") : t("助手不再接手"),
        ...(failure.kind === "external" ? { recommended: true } : {}) },
      { id: "drop", label: t("不做了"), detail: latest.stepId ? t("跳过这一步") : latest.workOrderId && !latest.stepId ? t("这件事归档") : t("不再做这件事") },
      { id: "look", label: t("查看助手做到哪"), href: previewOf(t, chain, row).href }
    ];
    return {
      id: `agent:${latest.taskId}`, kind: "agent_blocked", entityId: latest.taskId, urgency: urgencyFor(dueDay, today), ...(dueDay ? { dueDay } : {}),
      ...(order?.identityId ? { line: order.identityId } : {}), raisedAt: latest.endedAt ?? latest.requestedAt,
      fingerprint: `${latest.blockerCode}:${latest.taskId}`, important: true,
      title: t("助手没做成「{{title}}」", { title: short(title) }), why, options, preview: previewOf(t, chain, row), progress,
      freeText: { placeholder: failure.kind === "external" ? t("例如：已在浏览器里完成验证；以后每期只读收藏页第一页")
        : failure.kind === "needs_input" ? t("把助手缺的信息或本人的选择写在这里")
        : failure.kind === "hard" ? t("例如：只整理已有的文件，不再联网")
        : t("可选：补充要求，例如只做第 1–3 讲，资料在哪个文件夹") }
    };
  });
}

export type AgentAskChoice = { optionIds: string[]; values?: Record<string, string>; note?: string };

/** Asks the worker to run it again now (it records the person's words and follows the pause, quota and busy rules); recorded here if the worker is away. */
async function askForRetry(ctx: AccessContext, taskId: string, note: string): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const result = await requestCodexSupervisor<{ ok: boolean; code?: string }>(ctx, `/v1/agent/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note }), signal: AbortSignal.timeout(15_000) });
    return result.ok ? { ok: true } : { ok: false, code: result.code ?? "AGENT_RETRY_FAILED" };
  } catch (error) {
    if (error instanceof CodexSupervisorRequestError && error.status < 500 && error.status !== 404) return { ok: false, code: error.blocker.code };
    // The worker is away: the request waits in the ledger and its next pass runs it.
    const recorded = requestAgentRetry(getStore(), ctx.workspaceId, taskId, { note });
    return recorded.ok ? { ok: true } : recorded;
  }
}

/** Carries out the person's answer to an `agent_blocked` card (called from `answerAsk`). */
export async function answerAgentAsk(ctx: AccessContext, ask: Ask, choice: AgentAskChoice): Promise<{ ok: true } | { ok: false; code: string }> {
  const store = getStore();
  const taskId = ask.entityId;
  const task = listAgentTasks(store, ctx.workspaceId).find((row) => row.taskId === taskId);
  if (!task) return { ok: false, code: "TASK_NOT_FOUND" };
  const note = (choice.note ?? choice.values?.note ?? "").trim();
  const optionId = choice.optionIds[0] ?? (note ? "retry" : "");
  if (optionId === "retry" || optionId === "alternative") {
    const workaround = ask.options.find((option) => option.id === "alternative")?.detail;
    // i18n-ignore: instructions for the assistant's next run (model context)
    const words = [optionId === "alternative" && workaround ? `换个方法：${workaround}` : "", note].filter(Boolean).join("\n");
    return askForRetry(ctx, taskId, words);
  }
  if (optionId === "self") {
    if (task.stepId && task.workOrderId) takeStepBack(store, ctx.workspaceId, task.workOrderId, task.stepId, ctx.principalId);
    closeAgentTask(store, ctx.workspaceId, taskId, "self");
    return { ok: true };
  }
  if (optionId === "drop") {
    if (task.stepId && task.workOrderId) {
      try { store.updateStepProgress(ctx.workspaceId, task.workOrderId, task.stepId, { status: "skipped" }, ctx.principalId, "person"); } catch { /* replanned away */ }
    } else if (task.workOrderId) {
      const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === task.workOrderId);
      if (order && order.state !== "archived" && order.state !== "accepted") archiveWorkOrder(ctx, order.id, note || tOf(ctx)("本人决定不做了（助手没做成）"));
    }
    closeAgentTask(store, ctx.workspaceId, taskId, "drop");
    return { ok: true };
  }
  return { ok: false, code: "ASK_OPTION_UNKNOWN" };
}
