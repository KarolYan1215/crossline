import type { CapacityLine } from "../../lib/measured-capacity";

type Translate = (key: string, values?: Record<string, unknown>) => string;

/**
 * The plan's basis in one line, the same on the plan page, Today and the weekly commitment (docs/plans/closed-loop-1030.md §1): what the
 * person said a week holds, what the last 28 days measured, and which one the plan follows. The stated hours no longer enter the plan
 * except, before five measured days of a kind, at half.
 */
export function capacityBasisText(t: Translate, line: CapacityLine & { statedWeekly: number }): string {
  const stated = Math.round(line.statedWeekly * 10) / 10;
  const measured = line.measuredWeekly === null ? null : Math.round(line.measuredWeekly * 10) / 10;
  if (line.basis === "off") return measured === null ? t("所述 {{stated}} h/周 · 按所述排", { stated })
    : t("所述 {{stated}} h/周 · 实测近 28 天 {{measured}} h/周 · 按所述排", { stated, measured });
  if (line.basis === "stated") return t("所述 {{stated}} h/周 · 实测不足 5 天 · 按所述的一半排", { stated });
  // The adaptive factor (the owner, 2026-10-30: 「本问题自适应」) and the week that set it.
  const factor = line.realization === undefined ? t("系数 {{factor}}", { factor: line.factor })
    : t("系数 {{factor}}（上周兑现 {{share}}%）", { factor: line.factor, share: Math.round(line.realization * 100) });
  return t("所述 {{stated}} h/周 · 实测近 28 天 {{measured}} h/周 · 按实测排", { stated, measured: measured ?? 0 }) + " · " + factor;
}
