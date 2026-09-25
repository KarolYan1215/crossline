"use client";
import { useState } from "react";

const errorText: Record<string, string> = {
  IDENTITY_UNKNOWN: "身份不在已安装的身份包里。",
  INTENT_INVALID: "请填写这件事要做什么。",
  MILESTONE_NOT_APPROVED: "选的里程碑不是已批准状态，请刷新重选。",
  ESTIMATE_INVALID: "估时不对：p25 ≤ p50 ≤ p85，且都要是正数。",
  EVIDENCE_CONTRACT_REQUIRED: "至少写一条完成时要交出的证据。",
  CAPTURE_NOT_FOUND: "这条收集已经不存在了，请刷新。"
};

/**
 * The manual exit `docs/crossline-plan-critical-review.md` §4 asked for: when Codex is unavailable (or
 * just not wanted for this one item), a capture becomes a WorkOrder by hand instead of staying stuck
 * behind "分析服务不可用" with nothing else to do. Skips AI classification entirely — the result carries
 * `payload.manualPromotion` so every other screen can say so rather than implying it was analysed.
 */
export function PromoteForm({ captureId, identities, milestones }: {
  captureId: string;
  identities: Array<{ id: string; label: string }>;
  milestones: Array<{ id: string; title: string; identityId: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [identityId, setIdentityId] = useState(identities[0]?.id ?? "");
  const [intent, setIntent] = useState("");
  const [milestoneId, setMilestoneId] = useState("");
  const [family, setFamily] = useState("");
  const [p25, setP25] = useState("30");
  const [p50, setP50] = useState("45");
  const [p85, setP85] = useState("60");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  if (!open) return <button type="button" onClick={() => setOpen(true)}>改为手工创建 →</button>;

  const submit = async () => {
    setBusy(true); setStatus("");
    const evidenceContract = evidence.split("\n").map((line) => line.trim()).filter(Boolean)
      .map((description) => ({ kind: "record", description }));
    const response = await fetch(`/api/captures/${encodeURIComponent(captureId)}/promote`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identityId, intent, milestoneId, ...(family ? { family } : {}),
        estimate: { p25Minutes: Number(p25), p50Minutes: Number(p50), p85Minutes: Number(p85) },
        evidenceContract
      })
    }).catch(() => undefined);
    if (response?.ok) { location.reload(); return; }
    const body = await response?.json().catch(() => ({})) as { code?: string } | undefined;
    setStatus(errorText[body?.code ?? ""] ?? "没有创建成功，请检查填写内容。");
    setBusy(false);
  };

  return <form className="promote-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <p>跳过 AI 分类，直接人工创建作业。创建后会标注「人工创建，未经 AI 分析」，不会假装经过了分析。</p>
    <label><span>这件事要做什么</span>
      <input value={intent} maxLength={400} required onChange={(event) => setIntent(event.target.value)} /></label>
    <label><span>属于哪条主线</span>
      {/* Changing the identity resets the milestone choice — a milestone belongs to exactly one
          identity, so a stale cross-identity selection would only be caught server-side otherwise. */}
      <select value={identityId} onChange={(event) => { setIdentityId(event.target.value); setMilestoneId(""); }}>
        {identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.label}</option>)}
      </select></label>
    <label><span>绑定的里程碑（可不选）</span>
      <select value={milestoneId} onChange={(event) => setMilestoneId(event.target.value)}>
        <option value="">不绑定任何里程碑</option>
        {milestones.filter((milestone) => milestone.identityId === identityId)
          .map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}
      </select></label>
    <label><span>类型（可不选，影响未来的个人历史校准）</span>
      <select value={family} onChange={(event) => setFamily(event.target.value)}>
        <option value="">未标注</option>
        <option value="preparation">准备</option>
        <option value="review">检查/评估</option>
        <option value="deep_work">深度产出</option>
      </select></label>
    <div className="promote-form-estimate">
      <label><span>p25 分钟</span><input type="number" min={1} value={p25} onChange={(event) => setP25(event.target.value)} /></label>
      <label><span>p50 分钟</span><input type="number" min={1} value={p50} onChange={(event) => setP50(event.target.value)} /></label>
      <label><span>p85 分钟</span><input type="number" min={1} value={p85} onChange={(event) => setP85(event.target.value)} /></label>
    </div>
    <label><span>完成时要交出的证据（每行一条，至少一条）</span>
      <textarea value={evidence} maxLength={2000} required rows={3}
        onChange={(event) => setEvidence(event.target.value)} /></label>
    <div className="promote-form-actions">
      <button type="submit" disabled={busy}>{busy ? "创建中…" : "创建作业"}</button>
      <button type="button" className="secondary-button" onClick={() => setOpen(false)} disabled={busy}>取消</button>
    </div>
    {status && <p role="alert">{status}</p>}
  </form>;
}
