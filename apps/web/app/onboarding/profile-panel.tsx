"use client";

import { useState } from "react";
import { FlywheelPreview, type Link } from "./flywheel-preview";
import type { AssistantTurn, DocumentRow, Fact, Identity, OnboardingState, Project } from "./onboarding-types";

const SLOT_LABEL: Record<string, string> = {
  what: "在做什么", for_whom: "为谁", stage: "阶段", goal: "目标", deadline: "截止", blockers: "卡点",
  collaborators: "合作者", evidence: "进展证据", local_assets: "已有资料", weekly_hours: "每周时间", tools: "工具"
};
const slotLabel = (slot: string) => SLOT_LABEL[slot] ?? slot.replace(/_/g, " ");
const DOC_STATUS: Record<DocumentRow["extractionStatus"], string> = {
  pending: "读取中", done: "已读取", failed: "读取失败", unsupported: "无法读取文字"
};

async function post(body: Record<string, unknown>): Promise<boolean> {
  const response = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  return Boolean(response?.ok);
}

/**
 * The right third of the screen: what the interview has learned so far, kept live next to the
 * conversation. Everything here is editable — a guess can be confirmed or thrown out in one click, because
 * the point of a profile is that the person agrees with it.
 */
export function ProfilePanel({ state, onChanged }: { state: OnboardingState; onChanged: () => void }) {
  const { identities, projects, facts, documents } = state;
  const coverage = state.session?.coverage.coverage ?? [];
  const change = async (body: Record<string, unknown>) => { if (await post(body)) onChanged(); };
  const linkBody = (link: Link) => ({ identityId: link.from, projectId: "", slot: link.slot });

  return <aside className="ob-panel" aria-label="我对你的了解">
    <h2>我对你的了解</h2>
    {identities.map((identity) => <IdentityBlock key={identity.id} identity={identity}
      projects={projects.filter((project) => project.identityId === identity.id)}
      facts={facts.filter((fact) => fact.identityId === identity.id && !fact.slot.startsWith("flywheel_"))}
      documents={documents} coverage={coverage.find((item) => item.identityId === identity.id)} onChange={change} />)}
    <FlywheelPreview identities={identities} facts={facts}
      onConfirm={(link) => void change({ action: "confirm_fact", ...linkBody(link) })}
      onRemove={(link) => void change({ action: "remove_fact", ...linkBody(link) })} />
    <DocumentList documents={documents} />
  </aside>;
}

function IdentityBlock({ identity, projects, facts, documents, coverage, onChange }: {
  identity: Identity; projects: Project[]; facts: Fact[]; documents: DocumentRow[];
  coverage: AssistantTurn["coverage"][number] | undefined;
  onChange: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [adding, setAdding] = useState("");
  const general = facts.filter((fact) => !fact.projectId);
  const filled = coverage?.filled.length ?? 0, total = filled + (coverage?.missing.length ?? 0);
  return <section className="ob-block" data-identity={identity.id}>
    <h3>{identity.label}{total > 0 && <span className="ob-count" title="已了解的项目，占需要了解的">{filled}/{total}</span>}</h3>
    {general.length > 0 && <FactList facts={general} onChange={onChange} />}
    {projects.map((project) => <article className="ob-project" key={project.id}>
      <header>
        <b>{project.name}</b>
        <button type="button" className="ob-btn ob-quiet" aria-label={`移除项目 ${project.name}`} onClick={() => void onChange({ action: "archive_project", id: project.id })}>×</button>
      </header>
      {project.summary && <p className="ob-muted">{project.summary}</p>}
      <FactList facts={facts.filter((fact) => fact.projectId === project.id)} onChange={onChange} />
      {documents.filter((doc) => doc.projectId === project.id).map((doc) => <span className="ob-file" key={doc.id}>{doc.fileName}</span>)}
    </article>)}
    {projects.length === 0 && general.length === 0 && <p className="ob-muted">还没有内容。</p>}
    <form className="ob-add" onSubmit={(event) => {
      event.preventDefault();
      if (!adding.trim()) return;
      void onChange({ action: "save_project", identityId: identity.id, name: adding });
      setAdding("");
    }}>
      <input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder="添加一个项目…" aria-label={`为${identity.label}添加项目`} />
      <button type="submit" className="ob-btn" disabled={!adding.trim()}>添加</button>
    </form>
  </section>;
}

function FactList({ facts, onChange }: { facts: Fact[]; onChange: (body: Record<string, unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const key = (fact: Fact) => `${fact.projectId}|${fact.slot}`;
  return <dl className="ob-facts">
    {facts.map((fact) => <div key={key(fact)} data-status={fact.status}>
      <dt>{slotLabel(fact.slot)}</dt>
      <dd>
        {editing === key(fact)
          ? <form onSubmit={(event) => {
              event.preventDefault();
              void onChange({ action: "confirm_fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot, value: draft });
              setEditing(undefined);
            }}><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} /><button type="submit" className="ob-btn">保存</button></form>
          : <>
              <button type="button" className="ob-text" title="点击修改" onClick={() => { setEditing(key(fact)); setDraft(fact.value); }}>{fact.value}</button>
              {fact.status === "inferred" && <span className="ob-actions">
                <span className="ob-tag" data-kind="inferred">推断</span>
                <button type="button" className="ob-btn" aria-label={`确认${slotLabel(fact.slot)}`} onClick={() => void onChange({ action: "confirm_fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot })}>确认</button>
                <button type="button" className="ob-btn ob-quiet" aria-label={`去掉${slotLabel(fact.slot)}`} onClick={() => void onChange({ action: "remove_fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot })}>去掉</button>
              </span>}
            </>}
      </dd>
    </div>)}
  </dl>;
}

function DocumentList({ documents }: { documents: DocumentRow[] }) {
  if (!documents.length) return null;
  return <section className="ob-block">
    <h3>已导入的文件 <span className="ob-count">{documents.length}</span></h3>
    <ul className="ob-docs">{documents.map((doc) => <li key={doc.id} data-status={doc.extractionStatus}>
      <span>{doc.fileName}</span>
      <span className="ob-tag" data-kind={doc.extractionStatus}>{DOC_STATUS[doc.extractionStatus]}</span>
      {doc.extractionNote && <small>{doc.extractionNote}</small>}
    </li>)}</ul>
  </section>;
}
