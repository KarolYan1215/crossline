import type { ReactNode } from "react";
import { AppShell } from "./app-shell";

/** A page inside the shared frame, with its own title line. `active` names the view it belongs to. */
export function SubpageShell({ title, description, active, eyebrow, children }: {
  title: string;
  description?: string;
  active?: string | undefined;
  /** Kept for callers that still pass one; the new design has no eyebrow line. */
  eyebrow?: string;
  children: ReactNode;
}) {
  void eyebrow;
  return <AppShell active={active} className="subpage"><div className="subpage-inner">
    <header className="subpage-header">
      <div><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>
    </header>
    {children}
  </div></AppShell>;
}
