"use client";

import { useEffect, useState } from "react";
import type { TaskDetail } from "../../lib/task-detail";
import { AssistantMaterials } from "../materials/assistant-materials";
import { cleanText } from "../materials/humanize";
import { isTooling } from "../materials/kinds";
import { TutorialView } from "../materials/tutorial-view";
import { currentStep } from "./card-model";
import { FamiliarityTag } from "./familiarity-tag";
import { useT } from "../locale-context";

/**
 * The task's materials and tutorial — the one place the task detail reaches for them: the file list (each opening the material page,
 * which draws it with `MaterialViewer`) and the tutorial's table of contents (`TutorialView` with `layout="toc"`: one line per step,
 * each opening its section in place, the current step's open; linked to the step rows by `stepAnchor`). The whole tutorial is on its
 * reading page, `/materials/<id>` — embedding it here made the detail eight screens tall (2026-10-15).
 */
type TutorialMaterial = { index: number; title: string; publisher: string; kept: string; docId?: string; notes: number };
const KEPT: Record<string, string> = { full_text: "已存全文", summary_only: "链接与摘要", unverified: "未能自动核实" };

export function TaskMaterials({ detail, live, anchors }: { detail: TaskDetail; live: boolean; anchors: boolean }) {
  const t = useT();
  return <div className="task-materials">
    <MaterialsList detail={detail} />
    <div className="task-tutorial" {...(anchors ? { id: "tutorial" } : {})}>
      <p className="task-tutorial-head"><span className="task-subhead">{t("教程")}</span>
        <a href={`/materials/${encodeURIComponent(detail.id)}`}>{t("打开阅读页")}</a>
        {detail.familiarity ? <FamiliarityTag workOrderId={detail.id} level={detail.familiarity.level} by={detail.familiarity.by} /> : null}</p>
      <TutorialView workOrderId={detail.id} building={detail.state === "preparing"} auto={detail.preparation?.level === "tutorial"}
        {...(detail.preparation ? { reason: detail.preparation.reason } : {})} canBuild={live} layout="toc"
        {...(currentStep(detail) ? { currentStepId: currentStep(detail)!.id } : {})} />
    </div>
  </div>;
}

/** What one step has ready: the files the assistant prepared for it. The per-step tutorial joins here once it is keyed by step. */
export function StepMaterials({ detail, stepId }: { detail: Pick<TaskDetail, "agentOutputs">; stepId: string }) {
  const t = useT();
  const runs = detail.agentOutputs.filter((task) => task.stepId === stepId && task.files.length && (task.status === "accepted" || task.status === "needs_review"));
  if (!runs.length) return null;
  // Named without extension and without the assistant's scaffolding (scripts, README, data files): only what a person reads.
  const files = runs.flatMap((run) => run.files.filter((file) => !isTooling(file.path)).map((file) => ({ run, file })));
  if (!files.length) return null;
  return <p className="step-files"><small>{t("备好的文件")}</small>{files.map(({ run, file }) =>
    <a key={`${run.taskId}:${file.path}`} href={`/api/agent/tasks/${encodeURIComponent(run.taskId)}/file?path=${encodeURIComponent(file.path)}`} target="_blank" rel="noreferrer">{cleanText(file.name)}</a>)}</p>;
}

/**
 * Every material of the task, each opening its own page — the material on one side, the analysis of it for this task on the other —
 * the person's own files first, then what the tutorial found, the prepared files and the assistant's outputs.
 */
/** How many of the tutorial's web materials are listed before the rest fold. */
const WEB_SHOWN = 5;

function MaterialsList({ detail }: { detail: TaskDetail }) {
  const t = useT();
  const [found, setFound] = useState<TutorialMaterial[]>([]);
  useEffect(() => {
    void fetch(`/api/work-orders/${encodeURIComponent(detail.id)}/manualbook`, { cache: "no-store" }).then((response) => response.json())
      .then((body: { materials?: TutorialMaterial[] }) => setFound(body.materials ?? [])).catch(() => setFound([]));
  }, [detail.id]);
  const preview = (query: string) => `/workbench/${encodeURIComponent(detail.id)}/material?${query}`;
  const web = found.filter((item) => !item.docId);
  const noted = new Map(found.filter((item) => item.docId).map((item) => [item.docId!, item.notes]));
  // The tutorial's own files (its book, flow and index) are the tutorial below, not separate materials.
  const prepared = detail.preparedMaterials.filter((item) => !/\/(flow|manifest|materials)\.json$|\/manual\.md$|\/nodes\//.test(item.uri));
  const outputs = detail.agentOutputs.filter((task) => task.files.length);
  const webItem = (item: TutorialMaterial) => <li key={item.index}>
    <a href={preview(`m=${item.index}`)}>{item.title}</a>
    <small className="muted">{item.publisher || t("网络")} · {t(KEPT[item.kept] ?? "链接与摘要")} · {t("{{count}} 条解析", { count: item.notes })}</small>
  </li>;
  const empty = !detail.sources.length && !web.length && !prepared.length && !outputs.length;
  return <div className="materials-panel">
    {empty && <p className="muted">{t("暂无材料。本人上传的课程文件、教程找到的资料和 Agent 产出会出现在这里。")}</p>}
    {detail.sources.length > 0 && <section><h4>{t("本人上传")}</h4><ul>{detail.sources.map((doc) => <li key={doc.id}>
      <a href={preview(`doc=${encodeURIComponent(doc.id)}`)}>{cleanText(doc.fileName)}</a>
      <small className="muted">{noted.get(doc.id) ? t("{{count}} 条解析", { count: noted.get(doc.id) }) : t("原文")}</small>
    </li>)}</ul></section>}
    {web.length > 0 && <section><h4>{t("教程资料 · {{count}}", { count: web.length })}</h4><ul>{web.slice(0, WEB_SHOWN).map(webItem)}</ul>
      {/* A tutorial can cite twenty pages; the first few stay in view, the rest fold. */}
      {web.length > WEB_SHOWN && <details className="fold advanced"><summary>{t("其余 {{count}} 份", { count: web.length - WEB_SHOWN })}</summary><ul>{web.slice(WEB_SHOWN).map(webItem)}</ul></details>}</section>}
    {prepared.length > 0 && <section><h4>{t("已备文件")}</h4><ul>{prepared.map((item) => <li key={item.id}>
      <a href={`/api/work-orders/${encodeURIComponent(detail.id)}/materials?uri=${encodeURIComponent(item.uri)}`} target="_blank" rel="noreferrer">{cleanText(item.fileName)}</a></li>)}</ul></section>}
    {outputs.length > 0 && <section><h4>{t("Agent 产出")}</h4>
      <AssistantMaterials outputs={outputs} steps={(detail.stepPlan?.steps ?? []).map((step) => ({ id: step.id, title: step.title }))} />
    </section>}
    {detail.background && detail.background.length > 0 && <section><h4>{t("相关背景")}</h4><ul>{detail.background.map((fact) => <li key={fact.key}>
      <span>{fact.value}</span><small className="gen">{fact.why}</small></li>)}</ul></section>}
  </div>;
}
