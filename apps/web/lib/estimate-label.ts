import type { Estimate } from "@crossline/core";

const familyWords: Record<string, string> = { preparation: "准备类", review: "检查/评估类", deep_work: "深度产出类" };

/**
 * Where an estimate came from, in the words a person would use — never the internal source name. A calibrated
 * model estimate shows both numbers and why they differ: 「AI 估 180 分 · 按你的记录约 250 分（你通常 ×1.4，基于 9 次）」.
 */
export function estimateBasis(estimate: Pick<Estimate, "source" | "observationCount" | "calibration" | "p50Minutes">, family?: string): string {
  switch (estimate.source) {
    case "personal_history": return `依据本人完成过的 ${estimate.observationCount} 次同类任务`;
    case "manual": return "本人填写";
    case "llm_prior": {
      const calibration = estimate.calibration;
      if (calibration?.state === "applied" && calibration.raw) {
        return `AI 估 ${calibration.raw.p50Minutes} 分 · 按本人记录约 ${estimate.p50Minutes} 分（${family ? `${familyWords[family] ?? ""}` : ""}通常 ×${calibration.factor}，基于 ${calibration.basedOn} 次）`;
      }
      const learning = calibration?.state === "learning"
        ? `；按实际用时的校正仍在学习（${calibration.needed ? `再完成 ${calibration.needed} 项` : "还没比 AI 原值更准"}）` : "";
      return `AI 按任务内容估的（专注工作分钟，不含休息和等待）${learning}`;
    }
    default: return "按这条主线的通用经验估的";
  }
}
