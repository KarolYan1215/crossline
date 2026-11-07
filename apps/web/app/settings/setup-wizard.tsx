"use client";

import { useEffect, useState } from "react";
import { Check, ListChecks } from "lucide-react";
import type { SetupStep, SetupWeight } from "../../lib/settings-status";
import { useT } from "../locale-context";
import { Sheet } from "../ui/overlay";
import { openSetting } from "./settings-browser";

/** Set once the guide has opened by itself in this browser: afterwards it opens only from its button. */
const SEEN_KEY = "crossline.setup-guide.seen";
const WEIGHT: Record<SetupWeight, string> = { required: "必做", recommended: "推荐", optional: "可选" };

/** Whether the guide opens by itself: something that matters is not done, and it has not opened by itself in this browser before. */
export function opensByItself(steps: SetupStep[], seen: boolean): boolean {
  return !seen && steps.some((step) => !step.done && step.weight !== "optional");
}

/**
 * 设置向导 (2026-11-06, the owner's walkthrough: the setup was spread over eleven modules with no order and no sign of what was left).
 * A button on the settings page with how far the setup is; the dialog lists every step in order, done or not, each with the one button
 * that lands on its card (the card is then lit for a moment). It opens by itself the first time something that matters is undone.
 */
export function SetupWizard({ steps }: { steps: SetupStep[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const done = steps.filter((step) => step.done).length;
  useEffect(() => {
    let seen = true;
    try { seen = localStorage.getItem(SEEN_KEY) === "1"; localStorage.setItem(SEEN_KEY, "1"); } catch { /* no storage: never by itself */ }
    // Today's reminder links here with `?guide=1`: the guide opens whatever was seen before. A link to one card (`#automation`) came for
    // that card, so the guide does not cover it.
    if ((opensByItself(steps, seen) && !location.hash) || new URLSearchParams(location.search).get("guide") === "1") setOpen(true);
  }, []);
  const go = (href: string) => {
    setOpen(false);
    // A card on this page: the settings browser follows the hash, opens the module and lights the card.
    if (href.startsWith("#")) window.setTimeout(() => openSetting(href.slice(1)), 60);
    else location.href = href;
  };
  const next = steps.find((step) => !step.done);
  return <>
    <button type="button" className="st-wizard-button" onClick={() => setOpen(true)} aria-haspopup="dialog">
      <ListChecks size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{t("设置向导")}</span>
      <Progress done={done} total={steps.length} />
    </button>
    <Sheet title={t("设置向导")} open={open} onOpenChange={setOpen}
      footer={<button type="button" className="secondary-button" onClick={() => setOpen(false)}>{next ? t("稍后再说") : t("关闭")}</button>}>
      <div className="st-wizard">
        <p className="st-wizard-lead">{next
          ? t("按顺序完成下面几步，Crossline 才能排出贴合本人的计划。「必做」两步不完成，访谈和排程都无法开始；其余随时可以回来补。")
          : t("设置已全部完成。之后要改，点每一步的「查看」。")}</p>
        <div className="st-wizard-meter" role="img" aria-label={t("已完成 {{done}} / {{total}} 步", { done, total: steps.length })}>
          {steps.map((step) => <i key={step.id} data-done={step.done || undefined} />)}
        </div>
        <ol className="st-wizard-steps">
          {steps.map((step, index) => <li key={step.id} data-done={step.done || undefined} data-next={step === next || undefined}>
            <span className="st-wizard-mark" aria-hidden="true">{step.done ? <Check size={14} strokeWidth={2.5} /> : index + 1}</span>
            <span className="st-wizard-text"><b>{step.label} <em data-weight={step.weight}>{t(WEIGHT[step.weight])}</em></b><small>{step.detail}</small></span>
            <button type="button" className={step === next ? "primary-button" : "secondary-button"} onClick={() => go(step.href)}>
              {step.done ? t("查看") : step === next ? t("现在去做") : t("去设置")}</button>
          </li>)}
        </ol>
      </div>
    </Sheet>
  </>;
}

/** A small ring of how many steps are done. */
function Progress({ done, total }: { done: number; total: number }) {
  const t = useT();
  const r = 8, c = 2 * Math.PI * r;
  return <span className="st-wizard-progress" title={t("已完成 {{done}} / {{total}} 步", { done, total })}>
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--mist)" strokeWidth="3" />
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--now-ink)" strokeWidth="3" strokeDasharray={`${(done / Math.max(1, total)) * c} ${c}`}
        transform="rotate(-90 10 10)" strokeLinecap="round" />
    </svg>
    <b>{done}/{total}</b>
  </span>;
}

/**
 * A module's own steps as a strip under its name (2026-11-06): what in this module is set up and what is not, each a link to its card.
 * Shown only in the modules the setup guide has steps in.
 */
export function ModuleSteps({ steps }: { steps: SetupStep[] }) {
  const t = useT();
  if (!steps.length) return null;
  const done = steps.filter((step) => step.done).length;
  return <div className="st-module-steps" aria-label={t("本分类的设置进度")}>
    <span className="st-module-steps-count">{t("已设置 {{done}} / {{total}}", { done, total: steps.length })}</span>
    {steps.map((step) => <a key={step.id} href={step.href} className="st-module-step" data-done={step.done || undefined}
      onClick={(event) => { if (!step.href.startsWith("#")) return; event.preventDefault(); openSetting(step.href.slice(1)); }}>
      <span aria-hidden="true">{step.done ? "✓" : "○"}</span>{step.label}</a>)}
  </div>;
}
