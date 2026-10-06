"use client";
import { useEffect, useState, type ReactNode } from "react";
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
  /** The person-specific plan behind it: the stage in its line, the date it lands by, start, finish, and what it builds on. */
  anchor?: {
    stage: number; deadline: string; baseline: string; target: string; stakeholders: string[];
    dependsOnTitles: string[]; facts: string[];
  };
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
  /** Which template the criteria were built from, and the confidence computed from that — see
   * `computeMilestoneConfidence` (`packages/core/src/milestone-templates.ts`). Both absent for a
   * milestone written before templates existed or deliberately free-formed. */
  templateId?: string;
  confidence?: "low" | "medium" | "high";
};

export type MilestoneTemplateOption = {
  id: string;
  identityId: string;
  kind: "deliverable" | "threshold" | "validation" | "recurring_cadence" | "decision";
  titleHint: string;
  successCriteriaDefaults: SuccessCriterion[];
  source: "builtin" | "user" | "assistant";
};

type Draft = {
  id?: string;
  identityId: string;
  projectId: string;
  title: string;
  status: AdminMilestone["status"];
  successCriteria: SuccessCriterion[];
  templateId?: string;
};

const MEASURE_KINDS = ["count", "threshold", "artifact", "judgement"] as const;
const kindLabel: Record<string, string> = {
  count: "计数", threshold: "阈值", artifact: "产物", judgement: "判断"
};
const statusLabel: Record<string, string> = { draft: "草稿", approved: "已批准", archived: "已归档" };
const progressLabel: Record<string, string> = { met: "已达成", partial: "部分达成", unmet: "未达成", unverifiable: "无法核实" };
const TEMPLATE_KINDS = ["deliverable", "threshold", "validation", "recurring_cadence", "decision"] as const;
const templateKindLabel: Record<string, string> = {
  deliverable: "产出物", threshold: "数值门槛", validation: "外部验证", recurring_cadence: "持续节奏", decision: "关键决策"
};
const confidenceLabel: Record<string, string> = { low: "低", medium: "中", high: "高" };

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
  MILESTONE_NOT_FOUND: "这条里程碑已经不存在了。",
  MILESTONE_TEMPLATE_UNKNOWN: "选中的模板不存在，请重新选择。",
  TEMPLATE_TITLE_REQUIRED: "模板名称不能为空。",
  TEMPLATE_IDENTITY_UNKNOWN: "身份不在已安装的身份包里。",
  INVALID_TEMPLATE: "模板格式不对。"
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
export function MilestoneAdmin({ milestones, identities, templates, previews, initialEditId }: {
  milestones: AdminMilestone[];
  identities: Array<{ id: string; label: string }>;
  /** The template library (built-in + user + assistant-added) a new or edited milestone may be built
   * from — see 工作块 D in the plan this shipped under. Empty is a legitimate state (no templates seeded
   * yet), not an error. */
  templates: MilestoneTemplateOption[];
  /** Server-rendered preview drawers, keyed by milestone id — `loadMilestoneDetail` only runs server-side,
   * so the page renders each one and hands the finished JSX down rather than this client component
   * fetching it itself. */
  previews?: Record<string, ReactNode>;
  /** From `/milestones?edit=<id>` — a warning shown on another page (Review) links straight into the
   * edit form for that milestone instead of leaving the person to find it themselves. */
  initialEditId?: string;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState("");
  const [newTemplate, setNewTemplate] = useState<{
    identityId: string; kind: typeof TEMPLATE_KINDS[number]; titleHint: string; successCriteriaDefaults: SuccessCriterion[];
  } | null>(null);
  const [templateStatus, setTemplateStatus] = useState("");
  // The conversational follow-up path: once the first call returns a threadId, every later message
  // continues the same thread instead of starting a fresh one-shot proposal.
  const [threadId, setThreadId] = useState("");
  const [messages, setMessages] = useState<Array<{ from: "you" | "ai"; text: string }>>([]);
  const [reply, setReply] = useState("");

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
    successCriteria: milestone.successCriteria.length ? milestone.successCriteria : [blankCriterion()],
    ...(milestone.templateId ? { templateId: milestone.templateId } : {})
  });

  // Applying a template only replaces the current criteria when asked — picking one from the dropdown
  // just remembers the choice (and therefore the confidence `saveMilestoneEdit` will compute), since a
  // person editing an existing milestone usually wants to keep their own criteria intact.
  const applyTemplateDefaults = (templateId: string) => setDraft((current) => {
    if (!current) return current;
    const { templateId: _previous, ...rest } = current;
    if (!templateId) return rest;
    const chosen = templates.find((item) => item.id === templateId);
    if (!chosen) return rest;
    return { ...rest, templateId, successCriteria: chosen.successCriteriaDefaults.map((item) => ({ ...item })) };
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
    title: milestone.title, status: next, successCriteria: milestone.successCriteria,
    ...(milestone.templateId ? { templateId: milestone.templateId } : {})
  });

  const sendTemplate = async () => {
    if (!newTemplate) return;
    setBusy(true);
    setTemplateStatus("");
    try {
      const response = await fetch("/api/milestones/templates", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(newTemplate)
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; code?: string };
      if (!response.ok || !result.ok) {
        setTemplateStatus(errorText[result.code ?? ""] ?? "没有保存，请检查后重试。");
        setBusy(false);
        return;
      }
      location.reload();
    } catch {
      setTemplateStatus("网络不可用，没有保存。");
      setBusy(false);
    }
  };

  type ProposeReply = {
    state?: string; drafts?: Array<{ id: string; identityId: string; title: string }>;
    assumptions?: string[]; threadId?: string; blocker?: { message?: string }; message?: string;
  };
  const summarize = (result: ProposeReply) => !result.drafts?.length
    // Returning nothing is a valid answer for this Skill; saying "done" would imply otherwise.
    ? "这次没有提出新的里程碑。现有的可能已经覆盖了。"
    : `提出了 ${result.drafts.length} 个草稿：${result.drafts.map((item) => item.title).join("、")}`
      + (result.assumptions?.length ? `（假设：${result.assumptions.join("；")}）` : "");

  const propose = async () => {
    setBusy(true);
    setStatus("正在让 AI 提议里程碑，这一步会联网且用掉配额，可能要几分钟…");
    const prompt = ask.trim() || "（未填写方向，看整体情况）";
    try {
      const response = await fetch("/api/milestones/propose", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: ask })
      });
      const result = await response.json().catch(() => ({})) as ProposeReply;
      setBusy(false);
      if (!response.ok || result.state === "blocked") {
        setStatus(result.blocker?.message ?? result.message ?? "提议未完成。");
        return;
      }
      setStatus("");
      setMessages([{ from: "you", text: prompt }, { from: "ai", text: summarize(result) }]);
      // Only a real thread lets the conversation continue; without one the panel still shows what
      // happened, but the next message would have to start a fresh proposal instead of a reply.
      if (result.threadId) setThreadId(result.threadId);
    } catch {
      setBusy(false);
      setStatus("提议未完成。");
    }
  };

  const continueConversation = async () => {
    const prompt = reply.trim();
    if (!prompt || !threadId) return;
    setBusy(true);
    setReply("");
    setMessages((current) => [...current, { from: "you", text: prompt }]);
    try {
      const response = await fetch("/api/milestones/propose/continue", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, message: prompt })
      });
      const result = await response.json().catch(() => ({})) as ProposeReply;
      setBusy(false);
      if (!response.ok || result.state === "blocked") {
        setMessages((current) => [...current, { from: "ai", text: result.blocker?.message ?? result.message ?? "这条消息没有处理成功。" }]);
        return;
      }
      setMessages((current) => [...current, { from: "ai", text: summarize(result) }]);
    } catch {
      setBusy(false);
      setMessages((current) => [...current, { from: "ai", text: "网络不可用，这条消息没有发送成功。" }]);
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

    <details className="milestone-template-manager">
      <summary>模板管理（{templates.length} 个，新建里程碑时可套用）</summary>
      <p className="milestone-hint">
        模板决定一条里程碑的类型标注和默认达成标准，是 AI 生成里程碑时置信度的来源——套用了模板、且标准与模板一致才算「高置信」。
        你可以在这里直接新增模板，也可以在浮窗助手里要求 AI 帮你新增。
      </p>
      {!newTemplate
        ? <button type="button" className="secondary-button" onClick={() => setNewTemplate({
            identityId: identities[0]?.id ?? "", kind: "deliverable", titleHint: "", successCriteriaDefaults: [blankCriterion()]
          })} disabled={busy}>新增模板</button>
        : <form className="milestone-form" onSubmit={(event) => { event.preventDefault(); void sendTemplate(); }}>
            <div className="milestone-form-row">
              <label><span>模板名称</span>
                <input value={newTemplate.titleHint} required maxLength={200}
                  onChange={(event) => setNewTemplate({ ...newTemplate, titleHint: event.target.value })} /></label>
              <label><span>主线</span>
                <select value={newTemplate.identityId}
                  onChange={(event) => setNewTemplate({ ...newTemplate, identityId: event.target.value })}>
                  {identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.label}</option>)}
                </select></label>
              <label><span>类型</span>
                <select value={newTemplate.kind}
                  onChange={(event) => setNewTemplate({ ...newTemplate, kind: event.target.value as typeof TEMPLATE_KINDS[number] })}>
                  {TEMPLATE_KINDS.map((kind) => <option key={kind} value={kind}>{templateKindLabel[kind]}</option>)}
                </select></label>
            </div>
            {newTemplate.successCriteriaDefaults.map((criterion, index) => <fieldset key={criterion.id} className="criterion-row">
              <label className="criterion-statement"><span className="sr-only">默认标准描述</span>
                <input value={criterion.statement} maxLength={400} placeholder="套用这个模板时的默认达成标准"
                  onChange={(event) => setNewTemplate({ ...newTemplate, successCriteriaDefaults:
                    newTemplate.successCriteriaDefaults.map((item, i) => i === index ? { ...item, statement: event.target.value } : item) })} /></label>
              <label><span className="sr-only">衡量方式</span>
                <select value={criterion.measure.kind}
                  onChange={(event) => setNewTemplate({ ...newTemplate, successCriteriaDefaults:
                    newTemplate.successCriteriaDefaults.map((item, i) => i === index
                      ? { ...item, measure: emptyMeasure(event.target.value as typeof MEASURE_KINDS[number]) } : item) })}>
                  {MEASURE_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel[kind]}</option>)}
                </select></label>
              <MeasureFields measure={criterion.measure} onChange={(measure) => setNewTemplate({ ...newTemplate, successCriteriaDefaults:
                newTemplate.successCriteriaDefaults.map((item, i) => i === index ? { ...item, measure } : item) })} />
            </fieldset>)}
            <div className="milestone-form-actions">
              <button type="submit" disabled={busy}>保存模板</button>
              <button type="button" className="secondary-button" onClick={() => setNewTemplate(null)} disabled={busy}>取消</button>
            </div>
            {templateStatus && <em role="alert">{templateStatus}</em>}
          </form>}
    </details>

    {messages.length > 0 && <div className="milestone-conversation">
      <ul>{messages.map((message, index) => <li key={index} data-from={message.from}>
        <b>{message.from === "you" ? "你" : "AI"}</b><span>{message.text}</span>
      </li>)}</ul>
      {threadId ? <div className="milestone-conversation-reply">
        <label><span className="sr-only">继续对话</span>
          <input value={reply} maxLength={2000} disabled={busy}
            placeholder="继续说明你想要什么，AI 会在同一个对话里回应"
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void continueConversation(); } }} />
        </label>
        <button type="button" onClick={() => void continueConversation()} disabled={busy || !reply.trim()}>发送</button>
      </div> : <p className="milestone-hint">这次没有返回可继续的对话线程；再问一次会开始新的一轮。</p>}
      <button type="button" className="text-button" onClick={() => location.reload()}>刷新查看完整草稿列表 →</button>
    </div>}

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
        <label><span>套用模板</span>
          <select value={draft.templateId ?? ""} onChange={(event) => applyTemplateDefaults(event.target.value)}>
            <option value="">不套用（自由填写）</option>
            {templates.filter((template) => template.identityId === draft.identityId).map((template) =>
              <option key={template.id} value={template.id}>{templateKindLabel[template.kind]} · {template.titleHint}</option>)}
          </select></label>
      </div>
      {draft.templateId && <p className="milestone-hint">已套用模板的默认达成标准——继续编辑不会清掉模板关联，除非你在上面重新选择「不套用」。</p>}

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

    {(() => {
      const labelOf = (id: string) => identities.find((identity) => identity.id === id)?.label ?? id;
      const renderMilestone = (milestone: AdminMilestone) => {
      const outcomes = milestone.successCriteria.filter((criterion) => criterion.evidenceOf === "outcome").length;
      const unlabelled = milestone.successCriteria.filter((criterion) => !criterion.evidenceOf).length;
      return <li key={milestone.id} data-status={milestone.status}>
        <a className="card-cover-link" href={`/milestones/${encodeURIComponent(milestone.id)}`} aria-label={milestone.title} />
        {previews?.[milestone.id]}
        <div className="milestone-admin-head">
          <b>{milestone.title}</b>
          <small>{labelOf(milestone.identityId)} · {statusLabel[milestone.status]} · v{milestone.version}</small>
          {milestone.templateId && (() => {
            const template = templates.find((item) => item.id === milestone.templateId);
            return template ? <span className="criterion-tag" data-evidence="output">{templateKindLabel[template.kind]}</span> : null;
          })()}
          {milestone.confidence && <span className="criterion-tag" data-evidence={milestone.confidence === "high" ? "outcome" : "unlabelled"}>
            置信度：{confidenceLabel[milestone.confidence]}
          </span>}
        </div>
        {(milestone.anchor || milestone.rationale) && <details className="milestone-why"><summary>依据与推导</summary>
        {milestone.anchor && <dl className="milestone-anchor">
          <div><dt>阶段 {milestone.anchor.stage}</dt><dd>最晚 {milestone.anchor.deadline}</dd></div>
          <div><dt>现在</dt><dd>{milestone.anchor.baseline}</dd></div>
          <div><dt>做到</dt><dd>{milestone.anchor.target}</dd></div>
          {milestone.anchor.stakeholders.length > 0 && <div><dt>涉及</dt><dd>{milestone.anchor.stakeholders.join("、")}</dd></div>}
          {milestone.anchor.dependsOnTitles.length > 0 && <div><dt>接在</dt><dd>{milestone.anchor.dependsOnTitles.join("、")} 之后</dd></div>}
          {milestone.anchor.facts.length > 0 && <div><dt>依据</dt><dd>{milestone.anchor.facts.join("；")}</dd></div>}
        </dl>}
        {milestone.rationale && <p className="milestone-rationale">提议理由：{milestone.rationale}</p>}
        </details>}
        {milestone.successCriteria.length === 0
          ? <em className="review-flag">未声明达成标准 —— 绑定它的作业仍按各自的证据要求验收，但里程碑本身的进度记不下来，直到你写下什么算达成。
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
      };
      const live = milestones.filter((milestone) => milestone.status !== "archived");
      const archived = milestones.filter((milestone) => milestone.status === "archived");
      return <>
        <ul className="milestone-admin-list">{live.map(renderMilestone)}</ul>
        {archived.length > 0 && <details className="fold"><summary>已归档（{archived.length}）</summary>
          <ul className="milestone-admin-list">{archived.map(renderMilestone)}</ul></details>}
      </>;
    })()}
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
