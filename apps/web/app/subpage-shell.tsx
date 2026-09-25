import type { ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";
import { NAV_ITEMS } from "./nav-items";
import { BottomNav } from "./bottom-nav";

export function SubpageShell({ eyebrow, title, description, children }: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <><header className="running-head">
    <a className="wordmark" href="/">CROSSLINE<sup>01</sup></a>
    <nav aria-label="主导航">{NAV_ITEMS.map((item) => <a href={item.href} key={item.label}>{item.label}</a>)}</nav>
    <div className="system-state"><span>LOCAL · LIVE</span><SignOutButton /></div>
  </header>
  <BottomNav />
  <main className="subpage"><div className="subpage-inner">
    <header className="subpage-header">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p className="muted">{description}</p></div>
      <a href="/">← 返回下一行动</a>
    </header>
    {children}
  </div></main></>;
}
