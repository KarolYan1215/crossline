import "server-only";
import type { AccessContext } from "@crossline/core";
import { grownHomeLine, listAgentTasks, readGrownSkills } from "@crossline/db";
import { getStore } from "./crossline";
import { identityLines } from "./lines";
import { tOf } from "./locale";
import { OTHER_LINE, outputFolder, runLineOf } from "./outputs";
import { listReports } from "./reports";
import type { AgentOutputs, RunEntry } from "./agent-outputs-model";

/**
 * Everything 「Agent 产出」 lists (lib/agent-outputs-model.ts): each workflow's latest report with the line it works for, the assistant's
 * delivered runs (a workflow's own runs are its reports, a workflow being grown is not a result) and the output folder.
 */
export function loadAgentOutputs(ctx: AccessContext): AgentOutputs {
  const store = getStore();
  const lines = [...identityLines(ctx).map((line) => ({ id: line.id, label: line.label })), { id: OTHER_LINE, label: tOf(ctx)("其他") }];
  const known = new Set(lines.map((line) => line.id));
  const own = (id: string | undefined) => id && known.has(id) ? id : OTHER_LINE;
  const workflows = new Map(readGrownSkills(store, ctx.workspaceId).map((record) => [record.id, record]));
  const reports = listReports(ctx).map((report) => {
    const workflow = workflows.get(report.workflowId);
    return { ...report, lineId: own(workflow ? grownHomeLine(store, ctx.workspaceId, workflow) : undefined) };
  });
  const lineOf = runLineOf(ctx);
  const folder = outputFolder(ctx);
  // The files a run handed over, as the folder lists them (its helper scripts and records left out).
  const handed = new Map(folder.lines.flatMap((line) => line.tasks.map((task) => [task.taskId, task.files.length] as const)));
  const runs: RunEntry[] = listAgentTasks(store, ctx.workspaceId)
    .filter((row) => (row.status === "accepted" || row.status === "needs_review") && !row.taskId.startsWith("grow-") && !row.taskId.startsWith("flow-"))
    .map((row) => {
      const href = row.status === "needs_review" ? "/approvals#assistant" : row.workOrderId ? `/workbench/${encodeURIComponent(row.workOrderId)}` : undefined;
      return { taskId: row.taskId, title: row.title, at: row.completedAt ?? row.requestedAt, status: row.status as RunEntry["status"], partial: row.partial,
        lineId: own(lineOf(row)), files: handed.get(row.taskId) ?? 0, ...(href ? { href } : {}) };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  return { lines, reports, runs, folder };
}
