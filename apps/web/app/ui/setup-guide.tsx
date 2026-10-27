"use client";

import { useEffect, useState } from "react";
import type { SetupGuideSpec } from "../../lib/setup-guides";
import { useT } from "../locale-context";

/**
 * The tutorial beside a connect button (2026-10-21): folded under one line, opened in place; a tab per provider when there are several,
 * numbered steps, the values to copy shown whole (never squeezed into a placeholder), the official pages in a new tab, and the usual
 * mistakes with what to do about each. Every string of a guide is a catalogue key (lib/setup-guides.ts), translated here. `selected` moves the open tab when the person's input names a provider (a typed mail address).
 */
export function SetupGuide({ guide, selected, open }: { guide: SetupGuideSpec; selected?: string | undefined; open?: boolean }) {
  const t = useT();
  const [chosen, setChosen] = useState(selected ?? guide.providers[0]?.id);
  useEffect(() => { if (selected) setChosen(selected); }, [selected]);
  const provider = guide.providers.find((item) => item.id === chosen) ?? guide.providers[0];
  return <details className="advanced setup-guide" open={open}>
    <summary>{t(guide.title)}</summary>
    {guide.intro && <p className="setup-guide-intro">{t(guide.intro)}</p>}
    {guide.providers.length > 1 && <div className="setup-guide-tabs" role="group" aria-label={t("{{title}}：选择", { title: t(guide.title) })}>
      {guide.providers.map((item) => <button key={item.id} type="button" aria-pressed={item.id === provider?.id} onClick={() => setChosen(item.id)}>
        {item.unsupported ? t("{{label}}（不支持）", { label: t(item.label) }) : t(item.label)}</button>)}
    </div>}
    {provider && <div className="setup-guide-body" role="group" aria-label={t("{{label}}的步骤", { label: t(provider.label) })}>
      <ol className="setup-guide-steps">{provider.steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>
      {provider.facts && provider.facts.length > 0 && <dl className="setup-guide-facts">{provider.facts.map((fact) => <div key={fact.label}>
        <dt>{t(fact.label)}</dt><dd>{t(fact.value)}</dd></div>)}</dl>}
      {provider.links && provider.links.length > 0 && <p className="setup-guide-links">{provider.links.map((link) =>
        <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{t(link.label)} ↗</a>)}</p>}
      {provider.note && <p className="setup-guide-note">{t(provider.note)}</p>}
    </div>}
    {guide.problems && guide.problems.length > 0 && <div className="setup-guide-problems">
      <b>{t("常见出错")}</b>
      <dl>{guide.problems.map((problem) => <div key={problem.symptom}><dt>{t(problem.symptom)}</dt><dd>{t(problem.fix)}</dd></div>)}</dl>
    </div>}
  </details>;
}
