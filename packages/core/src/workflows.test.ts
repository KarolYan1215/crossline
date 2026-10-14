import { expect, test } from "vitest";
import { categoryFromWording, grownSkillId, reassignedSteps, scheduleLabel, stepLeavesMachine, validateWorkflowManifest, workflowDue, type WorkflowManifest } from "./index";

const manifest: WorkflowManifest = {
  name: "weekly-vlog-cut", summary: "每周把素材剪成一条 3 分钟 vlog", lines: ["media"], category: "media_edit", trigger: "schedule",
  schedule: { type: "weekly", days: ["FR"], time: "18:00" }, action: "run", reminder: "",
  steps: [{ title: "按时间线挑选片段并粗剪", by: "assistant", external: false }, { title: "加字幕并导出成片", by: "assistant", external: false },
    { title: "上传到小红书并发布", by: "person", external: true }],
  inputs: ["本周素材文件夹"], outputs: ["成片 mp4", "封面图"]
};

test("every step that leaves the machine is the person's, whatever the manifest said", () => {
  expect(validateWorkflowManifest(manifest, ["media"]).steps[2]).toEqual({ title: "上传到小红书并发布", by: "person", external: true });
  // Publishing handed to the assistant goes to the person, even when the manifest forgot to call it external.
  const posting = { ...manifest, steps: [...manifest.steps.slice(0, 2), { title: "发布到小红书", by: "assistant", external: false }] };
  const fixed = validateWorkflowManifest(posting, ["media"]);
  expect(fixed.steps[2]).toEqual({ title: "发布到小红书", by: "person", external: true });
  expect(reassignedSteps(posting, fixed)).toEqual(["发布到小红书"]);
  expect(reassignedSteps(manifest, validateWorkflowManifest(manifest, ["media"]))).toEqual([]);
  for (const bad of [{ ...manifest, lines: ["x"] }, { ...manifest, category: "trading" }, { ...manifest, schedule: { type: "weekly", days: [], time: "18:00" } },
    { ...manifest, schedule: { type: "daily", time: "25:00" } }, { ...manifest, action: "remind", reminder: "" }, { ...manifest, trigger: "on_request" }]) {
    expect(() => validateWorkflowManifest(bad, ["media"])).toThrow("WORKFLOW_MANIFEST_INVALID");
  }
  expect(validateWorkflowManifest({ ...manifest, trigger: "on_request", schedule: null }, ["media"]).schedule).toBeNull();
});

test("a scheduled workflow is due on its days after its time, once a day, and not hours late", () => {
  const zone = "America/Chicago";
  const weekly = { type: "weekly" as const, days: ["FR" as const], time: "18:00" };
  // 2026-10-16 is a Friday; 18:30 in Chicago is 23:30 UTC.
  expect(workflowDue(weekly, undefined, new Date("2026-10-16T23:30:00Z"), zone)).toBe(true);
  expect(workflowDue(weekly, undefined, new Date("2026-10-16T22:30:00Z"), zone)).toBe(false);
  expect(workflowDue(weekly, "2026-10-16T23:05:00Z", new Date("2026-10-16T23:30:00Z"), zone)).toBe(false);
  expect(workflowDue(weekly, undefined, new Date("2026-10-17T02:30:00Z"), zone)).toBe(false);
  expect(workflowDue(weekly, undefined, new Date("2026-10-15T23:30:00Z"), zone)).toBe(false);
  expect(workflowDue({ type: "weekdays", time: "09:00" }, undefined, new Date("2026-10-17T14:30:00Z"), zone)).toBe(false);
  expect(workflowDue({ type: "daily", time: "09:00" }, "2026-10-16T14:05:00Z", new Date("2026-10-17T14:30:00Z"), zone)).toBe(true);
  expect(scheduleLabel(weekly)).toBe("每周五 18:00");
  expect(scheduleLabel(null)).toBe("按需");
});

test("editing words point at the new kind of work, and ids stay unique", () => {
  expect(categoryFromWording("把这周的素材剪辑成一条 vlog")).toBe("media_edit");
  expect(categoryFromWording("用 python 脚本画图")).toBe("data_code_sim");
  expect(grownSkillId("Weekly Vlog Cut", ["flow-weekly-vlog-cut"])).toBe("flow-weekly-vlog-cut-2");
});

test("a step leaves the machine by what it does, not by a noun built on the verb", () => {
  expect(stepLeavesMachine("锁定获批提纲、3 个来源和发布前核对清单")).toBe(false);
  expect(stepLeavesMachine("整理发布包，不发布")).toBe(false);
  // The second real grown workflow's own safety line (2026-10-14).
  expect(stepLeavesMachine("Crossline 助手运行本地资料包校验并抽查原始来源；在任何发送、上传或发布动作前停止")).toBe(false);
  expect(stepLeavesMachine("发布到小红书")).toBe(true);
  expect(stepLeavesMachine("上传成片并提交审核")).toBe(true);
  expect(stepLeavesMachine("Email the draft to the editor")).toBe(true);
});
