"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BarChart3, Bell, BookOpen, Bot, CalendarDays, Layers, Mic, Search, Settings2, ShieldCheck, UserRound, Zap, type LucideIcon } from "lucide-react";
import { useT } from "../locale-context";

export type SettingsSection = { id: string; label: string; alerts?: number; parts?: Array<{ id: string; label: string }> };

/** Each module's icon, by its id. */
const ICONS: Record<string, LucideIcon> = { general: Settings2, calendar: CalendarDays, notify: Bell, automation: Bot, background: Layers,
  personal: UserRound, skills: BookOpen, privacy: ShieldCheck, energy: Zap, recordings: Mic, usage: BarChart3 };
const ICON = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

/** What a search reads in each card: its names and the lines that say what each setting does, not every word inside it. */
const SEARCHED = "h2,h3,h4,header,summary,legend,label,.st-row-label,.st-search-text";
/** The cards a search shows or hides: every card of a module, the module's own loose rows when it has no card grid. */
const unitsOf = (section: Element): HTMLElement[] => {
  const grids = [...section.querySelectorAll<HTMLElement>(":scope > .st-modules, :scope > .st-section-cards, :scope > div > .st-modules")];
  const loose = [...section.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName !== "H2"
    && !grids.includes(child) && !grids.some((grid) => child.contains(grid)));
  return [...grids.flatMap((grid) => [...grid.children].filter((child): child is HTMLElement => child instanceof HTMLElement)), ...loose];
};
/**
 * The module last opened in this tab. A link to `/settings#skills` from the settings page itself is a same-page move the router answers
 * by drawing the page again with the hash removed from the address, so the module the hash named is kept here and reopened; coming back
 * to settings later in the tab also opens where the person left it.
 */
let remembered = "";
// Listening from the moment this code loads, before the page is interactive: a move to `#skills` that lands between the page being drawn
// and the router taking over (which writes the address back without the hash) is otherwise lost.
if (typeof window !== "undefined") window.addEventListener("hashchange", (event) => {
  const id = decodeURIComponent(new URL(event.newURL).hash.slice(1));
  if (id) remembered = id;
});
const searchedText = (element: Element) => [...element.querySelectorAll(SEARCHED), element].map((node) =>
  node.matches(SEARCHED) ? node.textContent ?? "" : "").join(" ").toLowerCase();

/**
 * The settings page as one module at a time (2026-10-28 redesign, docs/plans/page-drafts-1028/settings.html): the status of every
 * connection on top, the index on the left with each module's icon and how many of its connections need the person, and one module beside
 * it. A link to a module or to one of its cards (`/settings#mail`, a notification's 「查看」, a row's 「去修复」) opens that module and lands
 * on the card. The search above filters every module's cards by their names and descriptions; clearing it goes back to the module.
 * Every module is rendered on the server as before; switching only shows and hides them, so nothing is fetched again.
 */
export function SettingsBrowser({ title, sub, sections, status, children }: {
  title: string; sub: string; sections: SettingsSection[]; status: ReactNode; children: ReactNode;
}) {
  const t = useT();
  const [active, setActive] = useState(sections[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Record<string, number>>({});
  // Until the page is interactive only the first module is drawn (CSS), so the modules do not flash one under another.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  /** The module a module id or a card id belongs to. */
  const moduleOf = useCallback((id: string) => {
    if (sections.some((section) => section.id === id)) return id;
    const owner = sections.find((section) => section.parts?.some((part) => part.id === id));
    if (owner) return owner.id;
    return document.getElementById(id)?.closest(".st-section")?.id;
  }, [sections]);

  /** Opens the module holding `id` and lands on it (the module's top for a module, the card for a card). */
  const open = useCallback((id: string, scroll = true) => {
    const module = moduleOf(id);
    if (!module) return;
    remembered = module;
    setQuery("");
    setActive(module);
    if (!scroll) return;
    // After the module is shown: a hidden element has no position to scroll to.
    window.setTimeout(() => {
      const target = id === module ? body.current : document.getElementById(id);
      target?.scrollIntoView({ block: "start" });
    }, 30);
  }, [moduleOf]);

  // The hash the page was opened with, read while it is first drawn: the router rewrites the address once it starts, and a hash that
  // arrived just before (a link to `/settings#skills` from `/settings`) was gone by the time an effect read it.
  const arrival = useRef(typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.slice(1)));
  // The address's hash on arrival and whenever it changes (a 「去修复」 row, the browser's back button).
  useEffect(() => {
    // From the event's own address: the router writes its address back (without the hash) before the event is delivered.
    const follow = (event: HashChangeEvent) => { const id = decodeURIComponent(new URL(event.newURL).hash.slice(1)); if (id) open(id, true); };
    // The address the document was loaded with, for a reload the router answers by rewriting the address before this runs.
    const loaded = (() => { try { return decodeURIComponent(new URL((performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.name ?? "").hash.slice(1)); } catch { return ""; } })();
    const first = decodeURIComponent(window.location.hash.slice(1)) || arrival.current || remembered || loaded;
    if (first) open(first, true);
    // The cards above a landing card get their height late: the jump is made again once they have.
    const late = window.setTimeout(() => { if (first && first !== moduleOf(first)) document.getElementById(first)?.scrollIntoView({ block: "start" }); }, 400);
    // The popstate of the same move comes first, while the address still holds the hash; whichever arrives, the module is remembered for
    // the page the router draws next.
    const popped = () => { const id = decodeURIComponent(window.location.hash.slice(1)); if (id) open(id, true); };
    // Where the browser has the Navigation API, a move within this page is seen before anything else answers it.
    const nav = (window as Window & { navigation?: EventTarget }).navigation;
    const navigating = (event: Event) => {
      const url = new URL((event as Event & { destination: { url: string } }).destination.url);
      if (url.pathname === window.location.pathname && url.hash) open(decodeURIComponent(url.hash.slice(1)), true);
    };
    window.addEventListener("hashchange", follow);
    window.addEventListener("popstate", popped);
    nav?.addEventListener("navigate", navigating);
    return () => { window.clearTimeout(late); window.removeEventListener("hashchange", follow); window.removeEventListener("popstate", popped); nav?.removeEventListener("navigate", navigating); };
  }, [open, moduleOf]);

  // 「/」 puts the cursor in the search, unless the person is already typing somewhere (a shortcut is only ever a second way in).
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input,textarea,select,[contenteditable='true']")) return;
      event.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // Shows the active module only, or, while searching, every card whose name or description holds every word typed.
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const counts: Record<string, number> = {};
    for (const section of root.querySelectorAll<HTMLElement>(":scope > .st-section")) {
      const units = unitsOf(section);
      if (!words.length) {
        section.hidden = section.id !== active;
        for (const unit of units) unit.hidden = false;
        continue;
      }
      const heading = (section.querySelector(":scope > h2")?.textContent ?? "").toLowerCase();
      const whole = words.every((word) => heading.includes(word));
      let shown = 0;
      for (const unit of units) {
        const text = `${heading} ${searchedText(unit)}`;
        const hit = whole || words.every((word) => text.includes(word));
        unit.hidden = !hit;
        if (hit) shown += 1;
      }
      section.hidden = shown === 0;
      counts[section.id] = shown;
    }
    setFound(counts);
  }, [active, query]);

  const searching = query.trim().length > 0;
  const total = Object.values(found).reduce((sum, count) => sum + count, 0);
  return <div className="st-browse" data-ready={ready || undefined}>
    <header className="subpage-header st-head">
      <div><h1 className="ds-serif">{title}</h1><p className="muted">{sub}</p></div>
      <label className="st-search">
        <Search {...ICON} />
        <input ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("搜索设置：邮箱、推送、额度……")} aria-label={t("搜索设置")} />
        <kbd aria-hidden="true">/</kbd>
      </label>
    </header>
    {status}
    <div className="st-layout">
      <nav className="st-nav" aria-label={t("设置分类")}>
        {sections.map((section) => {
          const Icon = ICONS[section.id] ?? Settings2;
          const current = !searching && active === section.id;
          const hits = searching ? found[section.id] ?? 0 : 0;
          return <div key={section.id} className="st-nav-item" data-current={current || undefined} data-dim={searching && !hits ? "" : undefined}>
            <a href={`#${section.id}`} aria-current={current ? "true" : undefined}
              onClick={(event) => { event.preventDefault(); history.replaceState(null, "", `#${section.id}`); open(section.id); }}>
              <Icon {...ICON} /><span>{section.label}</span>
              {searching ? hits > 0 && <small className="st-nav-count">{hits}</small>
                : section.alerts ? <small className="st-nav-alert" title={t("{{count}} 项需要处理", { count: section.alerts })}>{section.alerts}</small> : null}
            </a>
            {/* Every module's cards are in the index (a link to any of them works before the page is interactive); only the open one's show. */}
            {section.parts && section.parts.length > 0 && <div className="st-nav-sub">
              {section.parts.map((part) => <a key={part.id} href={`#${part.id}`}
                onClick={(event) => { event.preventDefault(); history.replaceState(null, "", `#${part.id}`); open(part.id); }}>{part.label}</a>)}
            </div>}
          </div>;
        })}
      </nav>
      <div className="st-sections" ref={body}>
        {searching && <p className="st-search-note" role="status">{total ? t("找到 {{count}} 项；清空搜索回到当前分类", { count: total }) : t("没有找到相关设置")}
          {" "}<button type="button" className="text-button" onClick={() => setQuery("")}>{t("清空搜索")}</button></p>}
        {children}
      </div>
    </div>
  </div>;
}
