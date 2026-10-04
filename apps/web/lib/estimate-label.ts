import type { Estimate } from "@crossline/core";

/** Where an estimate came from, in the words a person would use — never the internal source name. */
export function estimateBasis(estimate: Pick<Estimate, "source" | "observationCount" | "calibration">): string {
  const calibration = estimate.calibration ? `，已按你过去 ${estimate.calibration.basedOn} 次完成的实际用时校正（×${estimate.calibration.factor}）` : "";
  switch (estimate.source) {
    case "personal_history": return `依据你自己完成过的 ${estimate.observationCount} 次同类任务`;
    case "manual": return "你自己填的";
    case "llm_prior": return `AI 按任务内容估的（专注工作分钟，不含休息和等待）${calibration}`;
    default: return "按这条主线的通用经验估的";
  }
}
