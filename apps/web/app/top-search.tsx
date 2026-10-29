"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { Mention } from "./chat/composer";
import { useT } from "./locale-context";
import { ICON, IconButton } from "./ui/icon-button";

const KIND_LABEL: Record<Mention["kind"], string> = { material: "资料", task: "任务", milestone: "里程碑", goal: "长期目标" };

/** Where a result opens: a task's page, a milestone's drawer, the lines, a file as a page. Exported for its test. */
export function searchHref(item: Mention): string {
  switch (item.kind) {
    case "task": return `/workbench/${encodeURIComponent(item.id)}`;
    case "milestone": return `/milestones?open=${encodeURIComponent(item.id)}`;
    case "goal": return "/milestones";
    case "material": return `/api/source-documents/${encodeURIComponent(item.id)}/file`;
  }
}

/**
 * The search at the top right (2026-10-28 redesign). There was no search of its own; the input box's `@` already finds open tasks, live
 * milestones, long-term goals and files (`/api/mentions`), so this asks the same thing and opens the result instead of citing it. The
 * conversation's own search stays in the 小帮手.
 */
export function TopSearch() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Mention[]>([]);
  const [searching, setSearching] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = `search-${useId().replace(/:/g, "")}`;
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  useEffect(() => {
    if (!open || !query.trim()) { setResults([]); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      fetch(`/api/mentions?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() : { results: [] })
        .then((body: { results?: Mention[] }) => { setResults(body.results ?? []); setSearching(false); })
        .catch(() => { if (!controller.signal.aborted) { setResults([]); setSearching(false); } });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);
  return <div className="top-search" ref={root}>
    <IconButton label={t("搜索任务、里程碑和资料")} icon={<Search {...ICON} />} aria-expanded={open} onClick={() => setOpen((value) => !value)} />
    {open && <div className="top-search-panel" role="search">
      <input type="search" autoFocus value={query} placeholder={t("搜索任务、里程碑和资料")} aria-label={t("搜索任务、里程碑和资料")}
        aria-controls={list} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && results[0]) location.href = searchHref(results[0]); }} />
      <ul id={list}>{results.map((item) => <li key={`${item.kind}:${item.id}`}>
        <a href={searchHref(item)}><span className="top-search-kind">{t(KIND_LABEL[item.kind], { context: "kind" })}</span><span>{item.title}</span></a></li>)}</ul>
      {query.trim() && !results.length && <small className="muted">{searching ? t("正在搜索…") : t("无匹配")}</small>}
    </div>}
  </div>;
}
