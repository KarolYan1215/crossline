import { describe, expect, test } from "vitest";
import { validateMilestonePlans, type MilestonePlan, type ProfileForMilestones } from "./milestone-plan";

const profile: ProfileForMilestones = {
  today: "2026-10-02", requiredIdentities: ["research"],
  projects: [{ id: "westlake", identityId: "research", name: "西湖" }],
  facts: [
    { id: "research/westlake/deadline", identityId: "research", projectId: "westlake", slot: "deadline", value: "10/31 前投出", status: "confirmed" },
    { id: "research/-/stage", identityId: "research", projectId: "", slot: "stage", value: "博一", status: "confirmed" }
  ]
};
const plan = (over: Partial<MilestonePlan> = {}): MilestonePlan => ({
  key: "a", stage: 1, deadline: "2026-10-15", outcome: "拿到好成绩", derivation: "总评 A 要 90 分，其余部分预计 92，所以这一项至少 85，再留 3 分余量", baseline: "数据尚未到", target: "把 NeuroSim 仿真图表交给师兄",
  stakeholders: ["师兄"], sourceFactIds: ["research/westlake/deadline"], dependsOn: [], ...over
});
const outcome = [{ evidenceOf: "outcome", measure: { kind: "artifact" } }];
const item = (title: string, p: MilestonePlan, over: object = {}) => ({ identityId: "research", title, successCriteria: outcome, plan: p, ...over });
const chain = () => [
  item("西湖图表交付师兄确认", plan({ key: "a", stage: 1, deadline: "2026-10-15" })),
  item("西湖论文投出", plan({ key: "b", stage: 2, deadline: "2026-10-31", dependsOn: ["a"] })),
  item("拿到审稿反馈并规划修改", plan({ key: "c", stage: 3, deadline: "2026-12-20", dependsOn: ["b"] }))
];
const refused = (milestones: unknown[], code: string, p = profile) => {
  try { validateMilestonePlans(milestones as never, p, new Set()); } catch (error) { expect((error as Error).message).toBe(code); return; }
  throw new Error(`expected ${code}`);
};

test("a dated, sourced, chained set of milestones is accepted", () => {
  expect(() => validateMilestonePlans(chain(), profile, new Set())).not.toThrow();
});

test("a milestone with no plan, no date, or a date in the past is refused", () => {
  refused([{ identityId: "research", title: "没有计划的里程碑", successCriteria: outcome }], "MILESTONE_PLAN_MISSING");
  refused([item("没有日期的里程碑", plan({ deadline: "" }))], "MILESTONE_DEADLINE_REQUIRED");
  refused([item("过去的里程碑", plan({ deadline: "2026-09-01" }))], "MILESTONE_DEADLINE_OUT_OF_RANGE");
});

test("generic titles, empty targets and unsourced milestones are refused", () => {
  refused([item("为「科研」确定第一个可验收的里程碑", plan())], "MILESTONE_TITLE_GENERIC");
  refused([item("西湖图表交付师兄确认", plan({ target: "做好" }))], "MILESTONE_TARGET_REQUIRED");
  refused([item("西湖图表交付师兄确认", plan({ sourceFactIds: [] }))], "MILESTONE_SOURCE_REQUIRED");
  refused([item("西湖图表交付师兄确认", plan({ sourceFactIds: ["research/westlake/invented"] }))], "MILESTONE_SOURCE_UNKNOWN");
});

test("a milestone whose criteria are all outputs is refused", () => {
  refused([item("西湖图表交付师兄确认", plan(), { successCriteria: [{ evidenceOf: "output", measure: { kind: "artifact" } }] })], "MILESTONE_OUTCOME_REQUIRED");
});

// docs/work-split.md §3: a milestone that is only material being ready gives the person nothing of their own to do; readiness is the
// assistant's preparation, folded into a milestone with a result of the person's.
test("a milestone whose every criterion is material being ready is refused, whatever the line", () => {
  refused([item("西湖实验资料汇集", plan(), { successCriteria: [
    { statement: "三篇对照论文的实验参数已汇集", evidenceOf: "outcome", measure: { kind: "artifact" } },
    { statement: "仿真输入清单建立", evidenceOf: "output", measure: { kind: "artifact" } }] })], "MILESTONE_PREP_ONLY");
  const withResult = chain();
  withResult[0] = item("西湖图表交付师兄确认", plan({ key: "a", stage: 1, deadline: "2026-10-15" }), { successCriteria: [
    { statement: "三篇对照论文的实验参数已汇集", evidenceOf: "output", measure: { kind: "artifact" } },
    { statement: "师兄确认第 3、4 张图可用", evidenceOf: "outcome", measure: { kind: "artifact" } }] });
  expect(() => validateMilestonePlans(withResult, profile, new Set())).not.toThrow();
});

test("a covered line needs three to five milestones, and later stages cannot be due earlier", () => {
  refused(chain().slice(0, 2), "MILESTONE_CHAIN_TOO_SHORT");
  const backwards = chain();
  backwards[2] = item("拿到审稿反馈并规划修改", plan({ key: "c", stage: 3, deadline: "2026-10-20", dependsOn: ["b"] }));
  refused(backwards, "MILESTONE_ORDER_INCONSISTENT");
  const six = [...chain(), ...[4, 5, 6].map((n) => item(`第 ${n} 个具体里程碑`, plan({ key: `k${n}`, stage: Math.min(n, 5), deadline: "2027-02-01", dependsOn: ["c"] })))];
  refused(six, "MILESTONE_CHAIN_TOO_LONG");
});

test("every stage after the first has to name what it builds on, and only something earlier", () => {
  const unchained = chain();
  unchained[1] = item("西湖论文投出", plan({ key: "b", stage: 2, deadline: "2026-10-31", dependsOn: [] }));
  refused(unchained, "MILESTONE_NOT_CHAINED");
  const lateral = chain();
  lateral[1] = item("西湖论文投出", plan({ key: "b", stage: 2, deadline: "2026-10-31", dependsOn: ["c"] }));
  refused(lateral, "MILESTONE_DEPENDENCY_ORDER");
  const unknown = chain();
  unknown[1] = item("西湖论文投出", plan({ key: "b", stage: 2, deadline: "2026-10-31", dependsOn: ["zzz"] }));
  refused(unknown, "MILESTONE_DEPENDENCY_UNKNOWN");
});

test("a refusal names the milestone at fault so the model has something to repair", () => {
  try { validateMilestonePlans([item("西湖图表交付师兄确认", plan({ target: "做好" }))] as never, profile, new Set()); }
  catch (error) { expect((error as Error & { detail?: string }).detail).toContain("西湖图表交付师兄确认"); return; }
  throw new Error("expected a refusal");
});

import { validateMilestonePlans as validatePlans, type ProfileForMilestones as Profile } from "./milestone-plan";

describe("measurable, not just done", () => {
  const profile: Profile = { today: "2026-10-03", requiredIdentities: [], projects: [], facts: [{ id: "f", identityId: "research", projectId: "", slot: "goal", value: "课", status: "confirmed" }] };
  const make = (title: string, criteria: Array<{ evidenceOf: string; measure: { kind: string; unit?: string; comparator?: string; value?: number; bareLine?: number } }>) => [{
    identityId: "research", title, successCriteria: criteria,
    plan: { key: "k", stage: 1, deadline: "2026-12-07", outcome: "拿到好成绩", derivation: "总评 A 要 90 分，其余部分预计 92，所以这一项至少 85，再留 3 分余量", baseline: "尚未开始", target: "演示完成并拿到导师明确的下一步指示", stakeholders: [], sourceFactIds: ["f"], dependsOn: [] }
  }];

  test("finishing an exam is not a target: a graded milestone needs a score line, and the refusal says how to give one", () => {
    expect(() => validatePlans(make("ECE 555 期末考试完成并被课程方记录", [{ evidenceOf: "outcome", measure: { kind: "artifact" } }]), profile, new Set())).toThrow("MILESTONE_NOT_MEASURABLE");
    try { validatePlans(make("ECE 555 期末考试取得成绩", [{ evidenceOf: "outcome", measure: { kind: "artifact" } }]), profile, new Set()); } catch (error) {
      expect((error as Error & { detail?: string }).detail).toContain("分数线");
      expect((error as Error & { detail?: string }).detail).toContain("assumptions");
    }
    expect(() => validatePlans(make("ECE 555 期末考试取得 85 分以上", [{ evidenceOf: "outcome", measure: { kind: "threshold", unit: "分", comparator: "gte", value: 88, bareLine: 85 } }]), profile, new Set())).not.toThrow();
  });

  test("a milestone whose criteria are all judgement calls is refused even when nothing in it is graded", () => {
    expect(() => validatePlans(make("向导师演示 SRAM 仿真结果并得到下一步指示", [{ evidenceOf: "outcome", measure: { kind: "judgement" } }]), profile, new Set())).toThrow("MILESTONE_NOT_MEASURABLE");
    expect(() => validatePlans(make("向导师演示 SRAM 仿真结果并得到下一步指示", [{ evidenceOf: "outcome", measure: { kind: "judgement" } }, { evidenceOf: "output", measure: { kind: "artifact" } }]), profile, new Set())).not.toThrow();
  });
});

describe("several projects in one line", () => {
  const profile: Profile = {
    today: "2026-10-03", requiredIdentities: ["research"], requiredProjects: ["paper", "course"],
    projects: [{ id: "paper", identityId: "research", name: "论文" }, { id: "course", identityId: "research", name: "ECE 555" }],
    facts: [{ id: "research/paper/goal", identityId: "research", projectId: "paper", slot: "goal", value: "投稿", status: "confirmed" },
      { id: "research/course/goal", identityId: "research", projectId: "course", slot: "goal", value: "期末", status: "confirmed" }]
  };
  const item = (key: string, projectId: string, stage: number, deadline: string, dependsOn: string[] = []) => ({
    identityId: "research", projectId, title: `${projectId} 第 ${stage} 步完成并留下证据`, successCriteria: [{ evidenceOf: "outcome", measure: { kind: "artifact" } }],
    plan: { key, stage, deadline, outcome: "拿到好成绩", derivation: "总评 A 要 90 分，其余部分预计 92，所以这一项至少 85，再留 3 分余量", baseline: "尚未开始", target: "做完并有可核对的结果", stakeholders: [], sourceFactIds: [`research/${projectId}/goal`], dependsOn }
  });
  const answer = [item("p1", "paper", 1, "2026-10-10"), item("p2", "paper", 2, "2026-10-21", ["p1"]), item("p3", "paper", 3, "2026-10-31", ["p2"]),
    item("c1", "course", 1, "2026-10-27")];

  test("a project the person was specific about cannot be left out, even when the line already has a full chain", () => {
    expect(() => validatePlans(answer.slice(0, 3), profile, new Set())).toThrow("MILESTONE_PROJECT_MISSING");
    expect(() => validatePlans(answer, profile, new Set())).not.toThrow();
  });

  test("two projects' deadlines are not compared with each other, and each chain is chained on its own", () => {
    // The course milestone is due 10-27, between the paper's stage 2 and 3; judged as one line that would read as out of order.
    expect(() => validatePlans(answer, profile, new Set())).not.toThrow();
    const unchained = [...answer.slice(0, 3), item("c1", "course", 1, "2026-10-27"), item("c2", "course", 2, "2026-12-07")];
    expect(() => validatePlans(unchained, profile, new Set())).toThrow("MILESTONE_NOT_CHAINED");
  });

  test("a project id that is not one of the line's projects is sent back with the valid ones", () => {
    expect(() => validatePlans([...answer.slice(0, 3), item("c1", "nonsense", 1, "2026-10-27")], profile, new Set())).toThrow("MILESTONE_PROJECT_UNKNOWN");
  });
});

describe("concrete, not a state", () => {
  const base: Profile = { today: "2026-10-03", requiredIdentities: [], projects: [], facts: [{ id: "f", identityId: "research", projectId: "", slot: "goal", value: "课", status: "confirmed" }] };
  const one = (title: string, target = "拿到不低于 80 分并把成绩单存档") => [{
    identityId: "research", title, successCriteria: [{ evidenceOf: "outcome", measure: { kind: "artifact" } }, { evidenceOf: "outcome", measure: { kind: "threshold", unit: "分", comparator: "gte", value: 88, bareLine: 85 } }],
    plan: { key: "k", stage: 1, deadline: "2026-10-27", outcome: "拿到好成绩", derivation: "总评 A 要 90 分，其余部分预计 92，所以这一项至少 85，再留 3 分余量", baseline: "尚未开始", target, stakeholders: [], sourceFactIds: ["f"], dependsOn: [] }
  }];

  test("a mood or a maintenance state is sent back, and the refusal says what an event looks like", () => {
    for (const title of ["ECE 555 课程学习保持可完成状态", "稳定推进当前实验", "继续推进课程", "做好期中准备"]) {
      expect(() => validatePlans(one(title), base, new Set()), title).toThrow("MILESTONE_NOT_CONCRETE");
    }
    try { validatePlans(one("ECE 555 课程学习保持可完成状态"), base, new Set()); } catch (error) {
      expect((error as Error & { detail?: string }).detail).toContain("期中");
    }
  });

  test("an event passes, and a cadence with a number is allowed to say 保持", () => {
    expect(() => validatePlans(one("ECE 555 期中考试（10/27）取得 80 分以上"), base, new Set())).not.toThrow();
    expect(() => validatePlans(one("小红书连续四周按节奏发布", "保持每周发布 2–3 条，连续 4 周"), base, new Set())).not.toThrow();
    expect(() => validatePlans(one("提交 CAD 项目", "保持良好的状态，不掉队"), base, new Set())).toThrow("MILESTONE_NOT_CONCRETE");
    // Someone else continuing is an event, not the person keeping something going (a real answer refused three times for this).
    expect(() => validatePlans(one("首批试用者提交使用答复", "获得外部试用者继续使用、推荐或付费意向的证据"), base, new Set())).not.toThrow();
  });
});

describe("a course is its graded parts", () => {
  const profile: Profile = {
    today: "2026-10-03", requiredIdentities: [], requiredProjects: ["ece555"],
    projects: [{ id: "ece555", identityId: "research", name: "ECE 555" }],
    facts: [{ id: "research/ece555/goal", identityId: "research", projectId: "ece555", slot: "goal", value: "拿高分", status: "confirmed" },
      { id: "research/ece555/target_grade", identityId: "research", projectId: "ece555", slot: "target_grade", value: "总评 A−", status: "confirmed" }],
    dates: [
      { project: "ece555", kind: "quiz", date: "2026-10-09", title: "Quiz 2" }, { project: "ece555", kind: "quiz", date: "2026-11-23", title: "Quiz 5" },
      { project: "ece555", kind: "homework_due", date: "2026-10-12", title: "HW2 due" }, { project: "ece555", kind: "exam", date: "2026-12-07", title: "期末" },
      // Already past: not part of what is left to do.
      { project: "ece555", kind: "project_due", date: "2026-09-01", title: "old" }
    ]
  };
  const part = (key: string, stage: number, title: string, deadline: string, dependsOn: string[] = []) => ({
    identityId: "research", projectId: "ece555", title,
    successCriteria: [{ evidenceOf: "outcome", measure: { kind: "threshold", unit: "分", comparator: "gte", value: 88, bareLine: 85 } }],
    plan: { key, stage, deadline, outcome: "拿到好成绩", derivation: "总评 A 要 90 分，其余部分预计 92，所以这一项至少 85，再留 3 分余量", baseline: "尚未开始", target: "平均正确率不低于 80%", stakeholders: [], sourceFactIds: ["research/ece555/goal", "research/ece555/target_grade"], dependsOn }
  });

  test("a course with quizzes, homework and an exam cannot come back with only the exam", () => {
    expect(() => validatePlans([part("f", 1, "ECE 555 期末考试取得 85 分以上", "2026-12-07")], profile, new Set())).toThrow("MILESTONE_COURSE_PARTS_MISSING");
    try { validatePlans([part("f", 1, "ECE 555 期末考试取得 85 分以上", "2026-12-07")], profile, new Set()); } catch (error) {
      expect((error as Error & { detail?: string }).detail).toMatch(/小测 2 个.*作业 1 个.*考试 1 个/);
    }
  });

  test("one milestone per graded part, in date order, is accepted", () => {
    expect(() => validatePlans([
      part("q", 1, "ECE 555 小测平均正确率不低于 80%", "2026-11-23"),
      part("h", 2, "ECE 555 作业平均得分不低于 85%", "2026-11-30", ["q"]),
      part("f", 3, "ECE 555 期末考试取得 85 分以上", "2026-12-07", ["h"])
    ], profile, new Set())).not.toThrow();
  });
});

describe("worked backwards from the outcome, with room left", () => {
  const profile: Profile = { today: "2026-10-03", requiredIdentities: [], projects: [], facts: [{ id: "f", identityId: "research", projectId: "", slot: "goal", value: "课", status: "confirmed" }] };
  const exam = (measure: object, over: Record<string, unknown> = {}) => [{
    identityId: "research", title: "ECE 555 期末考试取得 88 分以上",
    successCriteria: [{ evidenceOf: "outcome", measure }],
    plan: { key: "k", stage: 1, deadline: "2026-12-07", baseline: "尚未开始", target: "期末拿到不低于 88 分", stakeholders: [], sourceFactIds: ["f"], dependsOn: [],
      outcome: "ECE 555 总评 A（≥90）", derivation: "总评 A 要 90 分；期末占 40%，平时部分预计 94，所以期末至少 85（bareLine），再留 3 分余量设为 88", ...over }
  }];
  const score = { kind: "threshold", unit: "分", comparator: "gte", value: 88, bareLine: 85 };
  const refusal = (answer: ReturnType<typeof exam>) => { try { validatePlans(answer, profile, new Set()); } catch (error) { return error as Error & { detail?: string }; } return undefined; };

  test("a line that sits clear of the bare line, with its derivation, passes", () => {
    expect(() => validatePlans(exam(score), profile, new Set())).not.toThrow();
  });

  test("a line set exactly on the bare line, or without one, has no room and is sent back", () => {
    expect(refusal(exam({ ...score, value: 85 }))?.message).toBe("MILESTONE_NO_MARGIN");
    expect(refusal(exam({ ...score, value: 85.5 }))?.message).toBe("MILESTONE_NO_MARGIN");
    const { bareLine: _omit, ...unbacked } = score;
    expect(refusal(exam(unbacked))?.detail).toContain("bareLine");
  });

  test("an upper limit leaves its margin below the bare line, and a score may sit at the ceiling", () => {
    const answer = exam({ kind: "threshold", unit: "%", comparator: "lte", value: 12, bareLine: 15 }, { target: "最大回撤不超过 12%" });
    expect(() => validatePlans(answer, profile, new Set())).not.toThrow();
    expect(refusal(exam({ kind: "threshold", unit: "%", comparator: "lte", value: 16, bareLine: 15 }))?.message).toBe("MILESTONE_NO_MARGIN");
    expect(() => validatePlans(exam({ kind: "threshold", unit: "%", comparator: "gte", value: 100, bareLine: 99 }), profile, new Set())).not.toThrow();
  });

  test("a number with no derivation, or no stated outcome behind it, is a guess", () => {
    expect(refusal(exam(score, { derivation: "合理" }))?.message).toBe("MILESTONE_DERIVATION_MISSING");
    expect(refusal(exam(score, { derivation: "按照一般经验大概需要认真准备并且保持稳定的复习节奏" }))?.message).toBe("MILESTONE_DERIVATION_MISSING");
    expect(refusal(exam(score, { outcome: "" }))?.message).toBe("MILESTONE_OUTCOME_UNSTATED");
  });
});

describe("numbers come from a target on the record, proposed from the person's goals if they have none", () => {
  const grading = { id: "research/ece555/grading", identityId: "research", projectId: "ece555", slot: "grading", value: "作业 20%、小测 30%、项目 25%、期末 25%", status: "confirmed" as const };
  const target = (status: "confirmed" | "inferred") => ({ id: "research/ece555/target_grade", identityId: "research", projectId: "ece555", slot: "target_grade", value: "总评 A−（≥ 90）", status });
  const profileWith = (facts: Profile["facts"]): Profile => ({ today: "2026-10-03", requiredIdentities: [], projects: [{ id: "ece555", identityId: "research", name: "ECE 555" }], facts });
  const profile = profileWith([grading, target("confirmed")]);
  const exam = (sourceFactIds: string[]) => [{
    identityId: "research", projectId: "ece555", title: "ECE 555 课堂期末考试取得 88 分以上",
    successCriteria: [{ evidenceOf: "outcome", measure: { kind: "threshold", unit: "分", comparator: "gte", value: 88, bareLine: 85 } }],
    plan: { key: "k", stage: 1, deadline: "2026-12-07", baseline: "尚未开始", target: "期末拿到不低于 88 分", stakeholders: [], sourceFactIds, dependsOn: [],
      outcome: "ECE 555 总评 A−（≥ 90）", derivation: "总评 90；期末占 25%，其余预计 94 → 期末至少 85（bareLine），留 3 分余量设 88" }
  }];
  const proposal = [{ projectId: "ece555", value: "总评 A−（≥ 90）", why: "他要继续读博，这门课只需稳妥不必满分，时间留给论文" }];
  const code = (answer: ReturnType<typeof exam>, on: Profile, proposals: typeof proposal | [] = []) => {
    try { validatePlans(answer, on, new Set(), proposals); } catch (error) { return (error as Error).message; } return "ok";
  };

  test("a course with no target on record and none proposed in the answer is sent back with what to propose", () => {
    expect(code(exam(["research/ece555/grading"]), profileWith([grading]))).toBe("MILESTONE_TARGET_UNPROPOSED");
  });

  test("a target proposed in the same answer is enough, once the milestone cites it", () => {
    const bare = profileWith([grading]);
    expect(code(exam(["research/ece555/grading"]), bare, proposal)).toBe("MILESTONE_TARGET_NOT_CITED");
    expect(code(exam(["research/ece555/grading", "research/ece555/target_grade"]), bare, proposal)).toBe("ok");
  });

  test("a target already on record, the model's earlier proposal or the person's own, is used as it is and has to be cited", () => {
    for (const status of ["inferred", "confirmed"] as const) {
      const on = profileWith([grading, target(status)]);
      expect(code(exam(["research/ece555/grading"]), on)).toBe("MILESTONE_TARGET_NOT_CITED");
      expect(code(exam(["research/ece555/grading", "research/ece555/target_grade"]), on)).toBe("ok");
    }
  });

  test("a graded part the file marks TBD still needs its milestone", () => {
    const parts = { ...profile, dates: [{ project: "ece555", kind: "quiz", date: "2026-10-09", title: "Quiz 2" }], undated: [{ project: "ece555", kind: "project_due", title: "Final Project Report" }] };
    expect(code(exam(["research/ece555/grading", "research/ece555/target_grade"]), parts)).toBe("MILESTONE_COURSE_PARTS_MISSING");
  });
});
