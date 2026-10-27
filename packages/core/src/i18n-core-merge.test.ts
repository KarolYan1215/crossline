import "@crossline/i18n/catalog/worker";
import { describe, expect, test } from "vitest";
import { planAssistantTask } from "./agent-dispatch";
import { autoApprovalEligible } from "./auto-approval";
import { triggerLabel } from "./automations";
import { interviewQuotaOutlook } from "./interview-quota";
import { draftBodyOf, draftFileText, MAIL_DRAFT_NOTE } from "./mail";
import { readableMineSourceLabel } from "./mine-skill";
import { capacityConflict } from "./onboarding-pace";
import { answerLine, answeredGapFacts, profileGaps } from "./profile-gaps";
import { recordProblem } from "./records";
import { normalizeStepPlan, type StepPlan } from "./steps";
import { scopeRenames } from "./task-merge";
import { taskPreparation } from "./tutorial-worth";
import { workOwner } from "./work-owner";
import { noteMarkdown } from "./xhs-notes";

/**
 * The English side of the text main added to packages/core after the bilingual branch forked (docs/i18n.md): each builder says the same
 * thing in English when asked, and exactly what it said before without a locale.
 */
describe("text main added, in English and unchanged in Chinese", () => {
  test("who does a piece of work, and what the assistant is handed", () => {
    expect(workOwner({ title: "提交作业 3" }).reason).toBe("要对外发出、提交、联系、出席或付款，只能本人做");
    expect(workOwner({ title: "提交作业 3" }, "en").reason).toBe("Sending, submitting, contacting, attending or paying is yours alone");
    expect(workOwner({ title: "确认交付格式", owner: "assistant" }, "en")).toMatchObject({ owner: "ask", question: "\"确认交付格式\": what is your 格式? A sentence or two is enough." });
    const ask = { id: "o", intent: "x", state: "approved", projectId: "p", payload: { owner: "ask" } };
    expect(planAssistantTask(ask, { projectIsCourse: false })).toEqual({ fit: false, reason: "这件事先等本人回答一个问题，再交给助手。" });
    expect(planAssistantTask(ask, { projectIsCourse: false, locale: "en" })).toEqual({ fit: false, reason: "This waits for your answer to one question before it goes to the assistant." });
    const prep = { id: "o", intent: "汇集课程讲义", state: "approved", projectId: "p", payload: { owner: "assistant" } };
    expect(planAssistantTask(prep, { projectIsCourse: false, servesTitle: "期中复习", locale: "en" })).toMatchObject({
      fit: true, humanPart: "You use these outputs in \"期中复习\"" });
    const order = { state: "awaiting_plan_approval", riskTier: "routine", intent: "x", payload: { owner: "ask" } };
    expect(autoApprovalEligible(order).reason).toBe("先等本人回答问题，再由助手做");
    expect(autoApprovalEligible(order, { locale: "en" }).reason).toBe("Waits for your answer first, then the assistant does it");
  });

  test("a deadline worked out from the interview is offered, and read back in either language", () => {
    const input = { identities: [{ id: "research", label: "Research" }], projects: [{ id: "thesis", identityId: "research", name: "Thesis" }],
      facts: [{ identityId: "research", projectId: "thesis", slot: "deadline", value: "推断：12 月中", status: "inferred" }] };
    const zh = profileGaps(input).find((gap) => gap.code === "PROJECT_DEADLINE")!;
    expect(zh.question.options.map((option) => option.label)).toEqual(["就按 12 月中", "我来写日期", "没有截止"]);
    const en = profileGaps({ ...input, locale: "en" }).find((gap) => gap.code === "PROJECT_DEADLINE")!;
    expect(en.question.options.map((option) => option.label)).toEqual(["Use 12 月中", "I'll write the date", "No deadline"]);
    expect(answeredGapFacts(answerLine(zh.question.text, ["就按 12 月中"], ""), [zh])).toMatchObject([{ slot: "deadline", value: "12 月中" }]);
    expect(answeredGapFacts(answerLine(en.question.text, ["Use 12 月中"], "", "en"), [en])).toMatchObject([{ slot: "deadline", value: "12 月中" }]);
    expect(answeredGapFacts(answerLine(en.question.text, ["No deadline"], "", "en"), [en])).toMatchObject([{ slot: "no_deadline" }]);
  });

  test("material only the person has, asked for first", () => {
    const plan = { archetypeId: "exam_prep", units: [], questions: [], steps: [{ id: "a", role: "practice", title: "Practice problem 1", product: "ability", uses: ["n1"],
      deliverable: "", doneCriterion: "", share: 1, estimate: { p25Minutes: 30, p50Minutes: 40, p85Minutes: 60 }, dependsOn: [], notBefore: "", dueBy: "",
      schedulable: true, executor: "human", tickOutcome: "", covers: [], why: "", aiAssist: { tool: "", how: "", minutesSaved: 0 }, firstAction: "" }],
      needs: [{ id: "n1", what: "lecture notes", why: "", basis: "[f1] notes on Canvas", kind: "reference" }] } as unknown as StepPlan;
    expect(normalizeStepPlan(plan).plan.steps[0]).toMatchObject({ title: "提供lecture notes", doneCriterion: "已上传，或说明没有" });
    expect(normalizeStepPlan(plan, undefined, { locale: "en" }).plan.steps[0]).toMatchObject({ title: "Provide lecture notes",
      doneCriterion: "Uploaded, or said there is none", firstAction: "Upload the file, or press \"None\"" });
  });

  test("automations, mail drafts and the Gmail page", () => {
    expect(triggerLabel({ type: "mail", from: "lin@uni.edu", keywords: ["数据"] })).toBe("收到 lin@uni.edu 的含「数据」的邮件时");
    expect(triggerLabel({ type: "mail", from: "lin@uni.edu", keywords: ["data"] }, "en")).toBe("When mail from lin@uni.edu containing \"data\" arrives");
    expect(triggerLabel({ type: "interval", hours: 6 })).toBe("每 6 小时");
    expect(triggerLabel({ type: "interval", hours: 1 }, "en")).toBe("Every hour");
    expect(triggerLabel({ type: "interval", hours: 6 }, "en")).toBe("Every 6 hours");
    const draft = { from: "Prof Lin", subject: "Data", date: "2026-10-19T08:00:00Z" };
    const en = draftFileText(draft, { subject: "", body: "Hi,\n\nThe data comes Friday." }, "en");
    expect(en.split("\n")[0]).toBe("> Drafted by the assistant; you check it and send it yourself. Crossline never sends this email.");
    expect(en).toContain("Subject: Re: Data");
    expect(draftBodyOf(en)).toBe("Hi,\n\nThe data comes Friday.");
    expect(draftFileText(draft, { subject: "", body: "x" }).split("\n")[0]).toBe(`> ${MAIL_DRAFT_NOTE}`);
  });

  test("a Xiaohongshu note as a file", () => {
    const note = { id: "n1", title: "", desc: "", type: "video", author: { name: "", id: "" }, time: "", lastUpdate: "", ipLocation: "", tags: [],
      counts: { liked: "3", collected: "", comment: "", share: "" }, source: "api", images: [] } as never;
    const en = noteMarkdown(note, { images: [] }, "en");
    expect(en).toContain("# (no title)");
    expect(en).toContain("- Type: Video");
    expect(en).toContain("- Engagement: Likes 3");
    expect(noteMarkdown(note, { images: [] })).toContain("- 类型：视频");
  });

  test("a rule's source, the week's capacity, a tutorial's reason, a record and the quota", () => {
    expect(readableMineSourceLabel("访谈中确认的「constraint」")).toBe("访谈中确认的「约束」");
    expect(readableMineSourceLabel("访谈中确认的「constraint」", "en")).toBe("\"Constraint\" confirmed in the interview");
    expect(readableMineSourceLabel("访谈中确认的「先做原型」", "en")).toBe("\"先做原型\" confirmed in the interview");
    const week = { windows: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }] as never[], busy: [], today: "2026-10-19",
      deadlines: [{ date: "2026-10-20", title: "A" }, { date: "2026-10-21", title: "B" }], lines: [{ id: "r", label: "Research", weight: 1 }] };
    expect(capacityConflict(week).notes[0]).toBe("每周可用约 40 小时，固定安排占其中 0 小时，剩约 40 小时给 1 条主线。");
    expect(capacityConflict({ ...week, locale: "en" }).notes).toEqual(["About 40 h a week available; fixed commitments take 0 h of it, leaving about 40 h for 1 track.",
      "2 deadlines in the next four weeks.", "2 deadlines crowd together from Oct 20 to Oct 21: A and B."]);
    const task = { title: "Write the report", intent: "", p50Minutes: 90 };
    expect(taskPreparation(task, [], {}, "en").reason).toBe("Whether to prepare a guide is decided once the steps are planned.");
    expect(taskPreparation(task, []).reason).toBe("步骤规划好后再决定是否准备教程。");
    expect(recordProblem({ domain: "wealth", kind: "expense", at: "x", value: 1, currency: "" }, new Date(), "en")).toBe("The date cannot be read");
    const quota = { signal: { available: true, limitReached: true } as never, trace: [], roundsDone: 3, complete: false };
    expect(interviewQuotaOutlook({ ...quota, locale: "en" }).message)
      .toBe("This ChatGPT account's quota is used up, so the interview stops here. You can upgrade to ChatGPT Plus, or apply to continue the interview on the developer's model (approved by email).");
    expect(interviewQuotaOutlook(quota).message).toBe("这个 ChatGPT 账号的额度已用完，访谈停在这里。可以升级到 ChatGPT Plus，或申请用开发者提供的模型继续访谈（邮件审批）。");
  });

  test("tasks that read alike are named for their milestone, in the workspace's language", () => {
    const base = { identityId: "r", projectId: "p", title: "Collect notes", intent: "", state: "approved", progress: 0, hasStepPlan: false, started: false, dependsOn: [] };
    const tasks = [{ ...base, id: "a", milestoneId: "m1", milestoneDeadline: "2026-10-27" }, { ...base, id: "b", milestoneId: "m2", milestoneDeadline: "2026-12-15" }];
    const titles = new Map([["m1", "A very long milestone title that is not short at all"], ["m2", "Final"]]);
    expect(scopeRenames(tasks as never, titles, "en").map((item) => item.title)).toEqual(["Collect notes (due 10/27)", "Collect notes (Final)"]);
    expect(scopeRenames(tasks as never, titles).map((item) => item.title)).toEqual(["Collect notes（10/27 截止）", "Collect notes（Final）"]);
  });
});
