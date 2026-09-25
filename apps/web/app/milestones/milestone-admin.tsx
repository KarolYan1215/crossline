"use client";
import { useEffect, useState } from "react";
import type { SuccessCriterion } from "@crossline/core";
import type { GoalSettings } from "../../lib/crossline";
import { GoalControls } from "./goal-controls";

export type AdminMilestone = {
  id: string;
  identityId: string;
  projectId: string;
  title: string;
  version: number;
  status: "draft" | "approved" | "archived";
  verifiability: "measurable" | "judgement_only" | "unstated";
  successCriteria: SuccessCriterion[];
  /** Why the Skill suggested it, when it was a Skill. Approving a goal with no stated reason is guessing. */
  rationale?: string;
  /**
   * How far each criterion has moved, taken from every gate judgement so far.
   *
   * The gate's verdict answers whether one work order delivered; it cannot answer "am I closer to the
   * goal", which is the question this page exists for. Keyed by criterion id, best result wins.
   */
  progress?: Record<string, "met" | "partial" | "unmet" | "unverifiable">;
  goalSettings?: GoalSettings | null;
  fallbackImportance?: "important" | "ordinary";
  dateCandidates?: Array<{ date: string; quote: string }>;
};

type Draft = {
  id?: string;
  identityId: string;
  projectId: string;
  title: string;
  status: AdminMilestone["status"];
  successCriteria: SuccessCriterion[];
};

const MEASURE_KINDS = ["count", "threshold", "artifact", "judgement"] as const;
const kindLabel: Record<string, string> = {
  count: "计数", threshold: "阈值", artifact: "产物", judgement: "判断"
};
const statusLabel: Record<string, string> = { draft: "草稿", approved: "已批准", archived: "已归档" };
const progressLabel: Record<string, string> = { met: "已达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };

const emptyMeasure = (kind: typeof MEASURE_KINDS[number]): SuccessCriterion["measure"] =>
  kind === "count" ? { kind, unit: "", atLeast: 1 }
    : kind === "threshold" ? { kind, unit: "", comparator: "gte", value: 0 }
      : kind === "artifact" ? { kind, mustExist: "" }
        : { kind, rubric: "", failsWhen: "" };

const blankCriterion = (): SuccessCriterion => ({
  id: `c-${Math.random().toString(36).slice(2, 9)}`,
  statement: "", required: true, evidenceOf: "outcome", measure: emptyMeasure("artifact")
});

const errorText: Record<string, string> = {
  MILESTONE_TITLE_REQUIRED: "标题不能为空。",
  MILESTONE_IDENTITY_UNKNOWN: "身份不在已安装的身份包里。",
  MILESTONE_NEEDS_CRITERIA: "至少写一条达成标准。",
  CRITERION_EMPTY: "有一条标准的描述是空的。",
  CRITERION_NOT_FALSIFIABLE: "判断型标准必须写明什么情况下判不过。",
  INVALID_CRITERIA: "标准的格式不对。",
  MILESTONE_NOT_FOUND: "这条里程碑已经不存在了。"
};

/**
 * Create, revise, approve and archive milestones — the goals everything else in Crossline hangs off.
 *
 * Two things are deliberately visible rather than tucked away. Each criterion says whether it measures
 * an output or an outcome, and a milestone with no outcome criterion is flagged: the easy criterion to
 * write is always "a document now exists", and a gate reading only those passes a milestone that never
 * moved. And an edit writes a new version rather than overwriting, so the criteria a past acceptance
 * was judged against stay readable.
 */
export function MilestoneAdmin({ milestones, identities, initialEditId }: {
  milestones: AdminMilestone[];
  identities: Array<{ id: string; label: string }>;
  /** From `/milestones?edit=<id>` — a warning shown on another page (Review) links straight into the
   * edit form for that milestone instead of leaving the person to find it themselves. */
  initialEditId?: string;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState("");

  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, off the id the page loaded with
  useEffect(() => {
    if (!initialEditId) return;
    const target = milestones.find((item) => item.id === initialEditId);
    if (target) startEdit(target);
  }, []);

  const startNew = () => setDraft({
    identityId: identities[0]?.id ?? "", projectId: "", title: "", status: "draft",
    successCriteria: [blankCriterion()]
  });
  const startEdit = (milestone: AdminMilestone) => setDraft({
    id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId,
    title: milestone.title, status: milestone.status,
    successCriteria: milestone.successCriteria.length ? milestone.successCriteria : [blankCriterion()]
  });

  const patchCriterion = (index: number, patch: Partial<SuccessCriterion>) => setDraft((current) => current && {
    ...current,
    successCriteria: current.successCriteria.map((item, i) => i === index ? { ...item, ...patch } : item)
  });

  // "Unlabelled" has to remove the key, not set it to undefined: the workspace runs
  // `exactOptionalPropertyTypes`, so an explicit undefined is a different thing from an absent field.
  const setEvidenceOf = (index: number, value: string) => setDraft((current) => current && {
    ...current,
    successCriteria: current.successCriteria.map((item, i) => {
      if (i !== index) return item;
      const { evidenceOf: _unlabelled, ...rest } = item;
      return value ? { ...rest, evidenceOf: value as "output" | "outcome" } : rest;
    })
  });

  const send = async (payload: Draft) => {
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/milestones", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; code?: string };
      if (!response.ok || !result.ok) {
        setStatus(errorText[result.code ?? ""] ?? "没有保存，请刷新查看真实状态。");
        setBusy(false);
        return;
      }
      location.reload();
    } catch {
      setStatus("网络不可用，没有保存。");
      setBusy(false);
    }
  };

  const setMilestoneStatus = (milestone: AdminMilestone, next: AdminMilestone["status"]) => void send({
    id: milestone.id, identityId: milestone.identityId, projectId: milestone.projectId,
    title: milestone.title, status: next, successCriteria: milestone.successCriteria
  });

  const propose = async () => {
    setBusy(true);
    setStatus("正在让 AI 提议里程碑，这一步会联网且用掉配额，可能要几分钟…");
    try {
      const response = await fetch("/api/milestones/propose", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: ask })
      });
      const result = await response.json().catch(() => ({})) as {
        state?: string; drafts?: unknown[]; blocker?: { message?: string }; message?: string;
      };
      if (!response.ok || result.state === "blocked") {
        setStatus(result.blocker?.message ?? result.message ?? "提议未完成。");
        setBusy(false);
        return;
      }
      if (!result.drafts?.length) {
        // Returning nothing is a valid answer for this Skill; saying "done" would imply otherwise.
        setStatus("这次没有提出新的里程碑。现有的可能已经覆盖了。");
        setBusy(false);
        return;
      }
      location.reload();
    } catch {
      setStatus("提议未完成。");
      setBusy(false);
    }
  };

  return <div className="milestone-admin">
    <div className="milestone-admin-actions">
      <button type="button" onClick={startNew} disabled={busy}>新建里程碑</button>
      <label className="milestone-ask">
        <span className="sr-only">告诉 AI 你想往哪个方向走</span>
        <input value={ask} maxLength={2000} disabled={busy}
          placeholder="可选：告诉 AI 你想往哪个方向走"
          onChange={(event) => setAsk(event.target.value)} />
      </label>
      <button type="button" className="secondary-button" onClick={() => void propose()} disabled={busy}>让 AI 提议 ↗</button>
      {status && <em role="alert">{status}</em>}
    </div>

    {draft && <form className="milestone-form" onSubmit={(event) => { event.preventDefault(); void send(draft); }}>
      <h3>{draft.id ? "修改里程碑（会写入新版本，旧版本保留）" : "新建里程碑"}</h3>
      <div className="milestone-form-row">
        <label><span>标题</span>
          <input value={draft.title} required maxLength={200}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label><span>主线</span>
          <select value={draft.identityId} onChange={(event) => setDraft({ ...draft, identityId: event.target.value })}>
            {identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.label}</option>)}
          </select></label>
        <label><span>状态</span>
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as Draft["status"] })}>
            {(["draft", "approved", "archived"] as const).map((value) =>
              <option key={value} value={value}>{statusLabel[value]}</option>)}
          </select></label>
      </div>

      <h4>达成标准</h4>
      <p className="milestone-hint">
        至少一条应当是「结果」而不是「产出物」。只有产出物的里程碑，可以靠写完几份文档就判过 —— 而目标一步没动。
      </p>
      {draft.successCriteria.map((criterion, index) => <fieldset key={criterion.id} className="criterion-row">
        <label className="criterion-statement"><span className="sr-only">标准描述</span>
          <input value={criterion.statement} maxLength={400} placeholder="什么情况算达成"
            onChange={(event) => patchCriterion(index, { statement: event.target.value })} /></label>
        <label><span className="sr-only">产出还是结果</span>
          <select value={criterion.evidenceOf ?? ""}
            onChange={(event) => setEvidenceOf(index, event.target.value)}>
            <option value="">未标注</option>
            <option value="outcome">结果</option>
            <option value="output">产出物</option>
          </select></label>
        <label><span className="sr-only">衡量方式</span>
          <select value={criterion.measure.kind}
            onChange={(event) => patchCriterion(index, { measure: emptyMeasure(event.target.value as typeof MEASURE_KINDS[number]) })}>
            {MEASURE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel[kind]}</option>)}
          </select></label>
        <MeasureFields measure={criterion.measure} onChange={(measure) => patchCriterion(index, { measure })} />
        <label className="criterion-required">
          <input type="checkbox" checked={criterion.required}
            onChange={(event) => patchCriterion(index, { required: event.target.checked })} />
          <span>必需</span>
        </label>
        <button type="button" className="criterion-remove" aria-label="删除这条标准"
          onClick={() => setDraft({ ...draft, successCriteria: draft.successCriteria.filter((_, i) => i !== index) })}>×</button>
      </fieldset>)}
      <div className="milestone-form-actions">
        <button type="button" className="secondary-button" disabled={draft.successCriteria.length >= 10}
          onClick={() => setDraft({ ...draft, successCriteria: [...draft.successCriteria, blankCriterion()] })}>加一条标准</button>
        <button type="submit" disabled={busy}>保存</button>
        <button type="button" className="secondary-button" onClick={() => setDraft(null)} disabled={busy}>取消</button>
      </div>
    </form>}

    <ul className="milestone-admin-list">{milestones.map((milestone) => {
      const outcomes = milestone.successCriteria.filter((criterion) => criterion.evidenceOf === "outcome").length;
      const unlabelled = milestone.successCriteria.filter((criterion) => !criterion.evidenceOf).length;
      return <li key={milestone.id} data-status={milestone.status}>
        <div className="milestone-admin-head">
          <b>{milestone.title}</b>
          <small>{milestone.identityId} · {statusLabel[milestone.status]} · v{milestone.version}</small>
        </div>
        {milestone.rationale && <p className="milestone-rationale">提议理由：{milestone.rationale}</p>}
        {milestone.successCriteria.length === 0
          ? <em className="review-flag">未声明达成标准 —— 闸门会拒绝它，直到你写下什么算达成。
              <button type="button" onClick={() => startEdit(milestone)} disabled={busy}>立即补充 →</button>
            </em>
          : <ul className="criterion-view">{milestone.successCriteria.map((criterion) => <li key={criterion.id}>
            <span className="criterion-tag" data-evidence={criterion.evidenceOf ?? "unlabelled"}>
              {criterion.evidenceOf === "outcome" ? "结果" : criterion.evidenceOf === "output" ? "产出物" : "未标注"}
            </span>
            <span>[{kindLabel[criterion.measure.kind]}] {criterion.statement}</span>
            {milestone.progress?.[criterion.id]
              && <span className="criterion-progress">闸门已判：{progressLabel[milestone.progress[criterion.id]!]}</span>}
            {criterion.measure.kind === "judgement" && <small>判不过的条件：{criterion.measure.failsWhen}</small>}
          </li>)}</ul>}
        {/* "Unlabelled" is not "an output". Saying so would be the system asserting something it does
            not know, which is the thing every other honest-state rule here exists to prevent. */}
        {milestone.successCriteria.length > 0 && outcomes === 0 && unlabelled > 0
          && <em className="review-flag">有 {unlabelled} 条标准没有标注是产出还是结果 —— 无法判断它们能否证明目标真的推进了。</em>}
        {milestone.successCriteria.length > 0 && outcomes === 0 && unlabelled === 0
          && <em className="review-flag">全部是产出物，没有一条衡量真实结果 —— 写完文档就能判过。</em>}
        {milestone.verifiability === "judgement_only"
          && <em className="review-flag">全部为判断型标准 —— 无法客观判负，值得额外复核。</em>}
        {milestone.status === "approved" && <GoalControls id={milestone.id}
          settings={milestone.goalSettings ?? null} fallbackImportance={milestone.fallbackImportance ?? "ordinary"}
          dateCandidates={milestone.dateCandidates ?? []} />}
        <div className="milestone-admin-buttons">
          <button type="button" onClick={() => startEdit(milestone)} disabled={busy}>修改</button>
          {milestone.status === "draft"
            && <button type="button" onClick={() => setMilestoneStatus(milestone, "approved")} disabled={busy}>批准</button>}
          {milestone.status !== "archived"
            && <button type="button" className="secondary-button" onClick={() => setMilestoneStatus(milestone, "archived")} disabled={busy}>归档</button>}
        </div>
      </li>;
    })}</ul>
  </div>;
}

function MeasureFields({ measure, onChange }: {
  measure: SuccessCriterion["measure"];
  onChange: (measure: SuccessCriterion["measure"]) => void;
}) {
  if (measure.kind === "count") {
    return <span className="measure-fields">
      <label><span className="sr-only">单位</span>
        <input value={measure.unit} maxLength={60} placeholder="单位"
          onChange={(event) => onChange({ ...measure, unit: event.target.value })} /></label>
      <label><span className="sr-only">至少</span>
        <input type="number" min={0} value={measure.atLeast}
          onChange={(event) => onChange({ ...measure, atLeast: Number(event.target.value) })} /></label>
    </span>;
  }
  if (measure.kind === "threshold") {
    return <span className="measure-fields">
      <label><span className="sr-only">单位</span>
        <input value={measure.unit} maxLength={60} placeholder="单位"
          onChange={(event) => onChange({ ...measure, unit: event.target.value })} /></label>
      <label><span className="sr-only">方向</span>
        <select value={measure.comparator}
          onChange={(event) => onChange({ ...measure, comparator: event.target.value as "gte" | "lte" })}>
          <option value="gte">≥</option><option value="lte">≤</option>
        </select></label>
      <label><span className="sr-only">数值</span>
        <input type="number" value={measure.value}
          onChange={(event) => onChange({ ...measure, value: Number(event.target.value) })} /></label>
    </span>;
  }
  if (measure.kind === "artifact") {
    return <span className="measure-fields">
      <label><span className="sr-only">必须存在的产物</span>
        <input value={measure.mustExist} maxLength={200} placeholder="必须存在的产物"
          onChange={(event) => onChange({ ...measure, mustExist: event.target.value })} /></label>
    </span>;
  }
  return <span className="measure-fields">
    <label><span className="sr-only">判断依据</span>
      <input value={measure.rubric} maxLength={400} placeholder="判断依据"
        onChange={(event) => onChange({ ...measure, rubric: event.target.value })} /></label>
    <label><span className="sr-only">什么情况判不过</span>
      <input value={measure.failsWhen} maxLength={400} placeholder="什么情况判不过（必填）"
        onChange={(event) => onChange({ ...measure, failsWhen: event.target.value })} /></label>
  </span>;
}
