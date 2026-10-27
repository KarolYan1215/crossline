"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";

export type SettingsSection = { id: string; label: string; parts?: Array<{ id: string; label: string }> };

/**
 * The settings index: a column of separate entries that stays in view on a wide screen, a scrolling strip on a phone. The section in
 * view is marked, so the index also says where on the page one is; a long section lists its parts under its entry (wide screens only).
 */
export function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const t = useT();
  const [current, setCurrent] = useState(sections[0]?.id ?? "");
  // A link to one module or card (a notification's 「查看」 → /settings#skills, #mail) lands on it: the browser jumps before the cards
  // above have their height, so the jump is made again once they have.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id || !sections.some((section) => section.id === id || section.parts?.some((part) => part.id === id))) return;
    const timer = window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: "start" }), 250);
    return () => window.clearTimeout(timer);
  }, [sections]);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id);
    }, { rootMargin: "-20% 0px -70% 0px" });
    for (const section of sections) { const element = document.getElementById(section.id); if (element) observer.observe(element); }
    return () => observer.disconnect();
  }, [sections]);
  // On the phone strip the marked entry is kept in view as the page scrolls.
  useEffect(() => {
    const link = document.querySelector<HTMLElement>(`.st-nav a[href="#${CSS.escape(current)}"]`);
    const strip = link?.closest<HTMLElement>(".st-nav");
    if (link && strip && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: link.offsetLeft - 12, behavior: "smooth" });
  }, [current]);
  return <nav className="st-nav" aria-label={t("设置分类")}>
    {sections.map((section) => <div key={section.id} className="st-nav-item">
      <a href={`#${section.id}`} aria-current={current === section.id ? "true" : undefined}>{section.label}</a>
      {section.parts && section.parts.length > 0 && <div className="st-nav-sub">
        {section.parts.map((part) => <a key={part.id} href={`#${part.id}`}>{part.label}</a>)}
      </div>}
    </div>)}
  </nav>;
}
