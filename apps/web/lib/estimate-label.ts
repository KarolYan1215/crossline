import type { Estimate } from "@crossline/core";
import { tFor, type Locale } from "./i18n";

const familyWords: Record<string, string> = { preparation: "准备类", review: "检查/评估类", deep_work: "深度产出类" };

/**
 * Where an estimate came from, in the words a person would use — never the internal source name. A calibrated
 * model estimate shows both numbers and why they differ: 「AI 估 180 分 · 按你的记录约 250 分（你通常 ×1.4，基于 9 次）」.
 */
export function estimateBasis(estimate: Pick<Estimate, "source" | "observationCount" | "calibration" | "p50Minutes">, family?: string, locale?: Locale): string {
  const t = tFor(locale);
  switch (estimate.source) {
    case "personal_history": return t("依据本人完成过的 {{count}} 次同类任务", { count: estimate.observationCount });
    case "manual": return t("本人填写");
    case "llm_prior": {
      const calibration = estimate.calibration;
      if (calibration?.state === "applied" && calibration.raw) {
        return t("AI 估 {{raw}} 分 · 按本人记录约 {{minutes}} 分（{{family}}通常 ×{{factor}}，基于 {{count}} 次）", { raw: calibration.raw.p50Minutes,
          minutes: estimate.p50Minutes, family: family && familyWords[family] ? t(familyWords[family]!) + (locale === "en" ? " " : "") : "",
          factor: calibration.factor, count: calibration.basedOn });
      }
      const learning = calibration?.state === "learning"
        ? t("；按实际用时的校正仍在学习（{{why}}）", { why: calibration.needed ? t("再完成 {{count}} 项", { count: calibration.needed }) : t("还没比 AI 原值更准") }) : "";
      return t("AI 按任务内容估的（专注工作分钟，不含休息和等待）{{learning}}", { learning });
    }
    default: return t("按这条主线的通用经验估的");
  }
}
