import type { ReactNode } from "react";

export function SubpageShell({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <><header className="running-head">
    <a className="wordmark" href="/">CROSSLINE<sup>01</sup></a>
    <nav aria-label="主导航"><a href="/">Today</a><a href="/plan">Plan</a><a href="/milestones">Milestones</a><a href="/workbench">Workbench</a><a href="/approvals">Approvals</a><a href="/review">Review</a><a href="/connectors">Connections</a></nav>
    <div className="system-state"><span>LOCAL · LIVE</span></div>
  </header><main className="subpage"><div className="subpage-inner">
    <header className="subpage-header">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p className="muted">{description}</p></div>
      <a href="/">← 返回下一行动</a>
    </header>
    {children}
  </div></main></>;
}
