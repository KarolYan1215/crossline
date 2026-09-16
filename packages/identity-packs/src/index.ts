export type IdentityPack = {
  id: string;
  label: string;
  kind: "identity" | "capacity";
  masterClock: boolean;
  workflowTemplates: string[];
  evidencePolicy: "tiered" | "telemetry";
  interviewQuestions: string[];
  durationPriors: Record<string, { p25Minutes: number; p50Minutes: number; p85Minutes: number }>;
};

const commonPriors = {
  preparation: { p25Minutes: 15, p50Minutes: 30, p85Minutes: 50 },
  review: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 },
  deep_work: { p25Minutes: 45, p50Minutes: 70, p85Minutes: 105 }
};

export function defaultIdentityPacks(): IdentityPack[] {
  return [
    {
      id: "research",
      label: "科研",
      kind: "identity",
      masterClock: true,
      workflowTemplates: ["paper-reading", "experiment-prep", "meeting-prep", "research-writing"],
      evidencePolicy: "tiered",
      interviewQuestions: ["哪些课程、会议或实验构成不可移动的现实约束？", "当前成果以什么证据验收？"],
      durationPriors: commonPriors
    },
    {
      id: "startup",
      label: "创业",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["public-prospect-research", "outreach-draft", "milestone-review"],
      evidencePolicy: "tiered",
      interviewQuestions: ["当前要验证的用户问题是什么？", "哪些外联必须逐项批准？"],
      durationPriors: commonPriors
    },
    {
      id: "media",
      label: "自媒体",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["evidence-to-topic", "script-package", "content-ops-job"],
      evidencePolicy: "tiered",
      interviewQuestions: ["已有素材位于哪些授权目录？", "公开发布前需要哪些检查？"],
      durationPriors: commonPriors
    },
    {
      id: "investment",
      label: "投资",
      kind: "identity",
      masterClock: false,
      workflowTemplates: ["pre-market-brief", "midday-check", "close-review"],
      evidencePolicy: "tiered",
      interviewQuestions: ["主动提供的美股或 ETF 关注列表是什么？", "三个研究视角的失效条件是什么？"],
      durationPriors: commonPriors
    },
    {
      id: "health",
      label: "健康容量",
      kind: "capacity",
      masterClock: false,
      workflowTemplates: ["training-window", "meal-prep", "minimum-recovery"],
      evidencePolicy: "telemetry",
      interviewQuestions: ["睡眠、进食和活动的最低红线是什么？"],
      durationPriors: {
        preparation: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 35 },
        review: { p25Minutes: 5, p50Minutes: 10, p85Minutes: 15 }
      }
    }
  ];
}
