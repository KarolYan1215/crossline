"use client";

import { useEffect, useState } from "react";

/**
 * The settings index: a sticky column on a wide screen, a scrolling strip on a phone. The section in view is marked, so the index
 * also says where on the page one is.
 */
export function SettingsNav({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const [current, setCurrent] = useState(sections[0]?.id ?? "");
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id);
    }, { rootMargin: "-20% 0px -70% 0px" });
    for (const section of sections) { const element = document.getElementById(section.id); if (element) observer.observe(element); }
    return () => observer.disconnect();
  }, [sections]);
  return <nav className="st-nav" aria-label="设置分类">
    {sections.map((section) => <a key={section.id} href={`#${section.id}`} aria-current={current === section.id ? "true" : undefined}>{section.label}</a>)}
  </nav>;
}
