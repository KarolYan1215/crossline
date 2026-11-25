"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";

/**
 * The git repositories whose commits count as evidence (docs/plans/execution-gates-1124.md J1 「git 提交」): a list of full paths on this
 * computer. Only commit ids, times, subjects and changed file names are read, masked before they leave; never a diff.
 */
export function GitReposCard() {
  const t = useT();
  const [repos, setRepos] = useState<string[] | undefined>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetch("/api/sources/git-repos", { cache: "no-store" }).then((response) => response.json()).then((body: { available?: boolean; repos?: string[] }) => {
      setRepos(body.available ? body.repos ?? [] : undefined);
    }).catch(() => setRepos(undefined));
  }, []);

  const save = async (next: string[]) => {
    setBusy(true); setMessage("");
    const response = await fetch("/api/sources/git-repos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repos: next }) }).catch(() => undefined);
    const answer = await response?.json().catch(() => undefined) as { state?: string; repos?: string[]; message?: string } | undefined;
    if (answer?.state === "saved") { setRepos(answer.repos ?? next); setDraft(""); setMessage(t("已保存。")); }
    else setMessage(answer?.message ?? t("没能保存，稍后再试。"));
    setBusy(false);
  };

  if (!repos) return null;
  return <section className="st-card" aria-label={t("提交记录")}>
    <header><h3>{t("提交记录")}</h3><small>{t("授权的 git 仓库：只读提交号、时间、提交说明和改动的文件名，不读改动内容；仅本地与 PDK 命中的名称先打码")}</small></header>
    {repos.map((repo) => <div className="st-row" key={repo}>
      <span className="st-row-label mono">{repo}</span>
      <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => void save(repos.filter((item) => item !== repo))}>{t("移除")}</button>
    </div>)}
    <form className="source-folders-form" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void save([...repos, draft.trim()]); }}>
      <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("仓库完整路径，如 D:\\code\\thesis")} aria-label={t("仓库路径")}
        disabled={busy} spellCheck={false} />
      <button type="submit" className="ob-btn secondary-button" disabled={busy || !draft.trim()}>{t("添加")}</button>
    </form>
    {message && <p className="muted" role="status">{message}</p>}
  </section>;
}
