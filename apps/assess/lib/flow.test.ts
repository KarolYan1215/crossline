import { expect, test } from "vitest";
import { QUIZ_ITEMS } from "@crossline/core/assess";
import { readResponse } from "./api-client";
import {
  QUIZ_LENGTH, afterSubmit, answerCurrent, answeredCount, appearanceProblem, back, buildRequest, destination, emailProblem, emptyFlow, errorMessage,
  flowKey, next, togglePick, wantsProblem,
  nicknameProblem, noteProblem, parseFlow, setAnswer, startQuiz, type Flow
} from "./flow";

const allAnswered = (): Record<string, number> => Object.fromEntries(QUIZ_ITEMS.map((item, index) => [item.id, (index % 5) + 1]));
const look = { presentation: "neutral", hair: "short", glasses: true, skin: "medium", style: "casual", note: "" } as const;

test("starting records the first statement's time once and lands on the first open statement", () => {
  const started = startQuiz(emptyFlow(), 1000);
  expect(started).toMatchObject({ step: "quiz", index: 0, startedAt: 1000 });
  const resumed = startQuiz({ ...started, step: "intro", answers: { q1: 3, q2: 4 } }, 9000);
  expect(resumed).toMatchObject({ index: 2, startedAt: 1000 });
});

test("answering moves on one statement at a time, and the last one leads to the appearance step", () => {
  let flow = startQuiz(emptyFlow(), 0);
  flow = answerCurrent(flow, 4);
  expect(flow).toMatchObject({ index: 1, answers: { q1: 4 } });
  expect(answerCurrent(flow, 7)).toBe(flow);
  expect(answerCurrent(flow, 0)).toBe(flow);
  for (let i = 1; i < QUIZ_LENGTH; i += 1) flow = answerCurrent(flow, 3);
  expect(answeredCount(flow)).toBe(32);
  expect(flow.step).toBe("appearance");
});

test("the last statement sends a person with a gap back to it instead of on", () => {
  const answers = allAnswered();
  delete answers.q5;
  const flow: Flow = { ...emptyFlow(), step: "quiz", startedAt: 0, index: QUIZ_LENGTH - 1, answers };
  expect(answerCurrent(flow, 2)).toMatchObject({ step: "quiz", index: 4 });
});

test("an arrow-key answer records without moving; next only moves past an answered statement", () => {
  const flow = startQuiz(emptyFlow(), 0);
  expect(next(flow)).toBe(flow);
  const chosen = setAnswer(flow, 2);
  expect(chosen).toMatchObject({ index: 0, answers: { q1: 2 } });
  expect(next(chosen).index).toBe(1);
});

test("back walks statements, then the intro; appearance goes back to the last statement and email to appearance", () => {
  const quiz: Flow = { ...emptyFlow(), step: "quiz", index: 3, startedAt: 0 };
  expect(back(quiz).index).toBe(2);
  expect(back({ ...quiz, index: 0 }).step).toBe("intro");
  expect(back({ ...quiz, step: "appearance" })).toMatchObject({ step: "quiz", index: QUIZ_LENGTH - 1 });
  expect(back({ ...quiz, step: "email" }).step).toBe("appearance");
});

test("a stored flow resumes, and anything malformed or out of reach is dropped", () => {
  const flow: Flow = { ...emptyFlow(), step: "email", startedAt: 5, answers: allAnswered(), appearance: { ...look }, email: "a@b.cn", nickname: "小林" };
  expect(parseFlow(JSON.stringify(flow))).toEqual(flow);
  expect(parseFlow(null)).toBeNull();
  expect(parseFlow("{not json")).toBeNull();
  const tampered = parseFlow(JSON.stringify({ ...flow, answers: { ...flow.answers, q3: 9, extra: 1 }, appearance: { hair: "purple", note: "x" }, index: 99 }));
  expect(tampered).toMatchObject({ step: "quiz", index: 2 });
  expect(tampered?.answers).not.toHaveProperty("extra");
  expect(tampered?.appearance).toEqual({ note: "x" });
  expect(parseFlow(JSON.stringify({ step: "quiz", index: 4 }))?.step).toBe("intro");
  expect(parseFlow(JSON.stringify({ step: "quiz", index: 40, startedAt: 1 }))?.index).toBe(QUIZ_LENGTH - 1);
});

test("the email step makes the result and leads to the last step, which keeps only what it needs and cannot go back", () => {
  const before: Flow = { ...emptyFlow(), step: "email", startedAt: 5, answers: allAnswered(), appearance: { ...look }, email: "a@b.cn",
    wants: { picks: ["media"], text: "" } };
  const after = afterSubmit(before, { resultToken: "result_token_123", pairToken: undefined });
  expect(after).toMatchObject({ step: "wants", submitted: { resultToken: "result_token_123" }, wants: { picks: ["media"] } });
  // The answers, the appearance and the address are no longer kept in the browser once the server has them.
  expect(after).toMatchObject({ answers: {}, email: "", appearance: { note: "" } });
  expect(back(after)).toBe(after);
  expect(destination(after.submitted!)).toBe("/r/result_token_123");
  expect(destination({ resultToken: "result_token_123", pairToken: "pair_token_456" })).toBe("/p/pair_token_456");
  expect(parseFlow(JSON.stringify(after))).toEqual(after);
  // A last step without a result to belong to is not reachable; a tampered token is not followed.
  expect(parseFlow(JSON.stringify({ ...after, submitted: null }))?.step).toBe("quiz");
  expect(parseFlow(JSON.stringify({ ...after, submitted: { resultToken: "../x" } }))?.submitted).toBeNull();
  expect(parseFlow(JSON.stringify({ ...after, wants: { picks: ["media", "hack", "media"], text: 3 } }))?.wants).toEqual({ picks: ["media"], text: "" });
});

test("chips toggle in the order they were picked, at most six; the last step needs a chip or a line", () => {
  let wants = { picks: [] as string[], text: "" };
  expect(wantsProblem(wants)).toMatch(/选一两项/);
  for (const id of ["media", "research", "invest", "writing", "design", "build", "music"]) wants = togglePick(wants, id);
  expect(wants.picks).toEqual(["media", "research", "invest", "writing", "design", "build"]);
  expect(togglePick(wants, "research").picks).toEqual(["media", "invest", "writing", "design", "build"]);
  expect(wantsProblem({ picks: [], text: "想做播客" })).toBeNull();
  expect(wantsProblem({ picks: ["media"], text: "长".repeat(61) })).toMatch(/最多 60/);
  expect(errorMessage("WANTS_LIMIT_REACHED")).toContain("3 次");
});

test("the email checkbox starts ticked, and each invitation keeps its own test", () => {
  expect(emptyFlow().sendEmail).toBe(true);
  expect(flowKey()).not.toBe(flowKey("abc"));
});

test("validation messages name what is missing", () => {
  expect(appearanceProblem({ note: "" })).toBe("还差：性别呈现、发型、眼镜、肤色、穿衣风格");
  expect(appearanceProblem({ ...look, glasses: false })).toBeNull();
  expect(noteProblem("字".repeat(41))).toMatch(/40/);
  expect(noteProblem("字".repeat(40))).toBeNull();
  expect(emailProblem("")).toBe("请填写邮箱");
  expect(emailProblem("a@b")).toBe("邮箱格式不对，请检查");
  expect(emailProblem(" a@b.cn ")).toBeNull();
  expect(nicknameProblem("一二三四五六七八九十一二")).toBeNull();
  expect(nicknameProblem("一二三四五六七八九十一二三")).toMatch(/12/);
});

test("the request carries every answer, the trimmed fields, the clock, the honeypot and the invitation only when there is one", () => {
  const flow: Flow = { ...emptyFlow(), step: "email", startedAt: 123, answers: allAnswered(), appearance: { ...look, note: " 红帽子 " }, email: " a@b.cn ", nickname: " 小林 " };
  const request = buildRequest(flow, { website: "" });
  expect(request).toMatchObject({ email: "a@b.cn", nickname: "小林", sendEmail: true, startedAt: 123, website: "", appearance: { note: "红帽子" } });
  expect(Object.keys(request!.answers)).toHaveLength(32);
  expect(request).not.toHaveProperty("inviteToken");
  expect(buildRequest(flow, { website: "", inviteToken: "inv" })?.inviteToken).toBe("inv");
  expect(buildRequest({ ...flow, email: "nope" }, { website: "" })).toBeNull();
  expect(buildRequest({ ...flow, answers: { q1: 3 } }, { website: "" })).toBeNull();
  expect(buildRequest({ ...flow, appearance: { note: "" } }, { website: "" })).toBeNull();
});

test("every refusal the API can give reads as plain Chinese, and an unknown one still says something", () => {
  const codes = ["QUIZ_INCOMPLETE", "APPEARANCE_INVALID", "EMAIL_INVALID", "NICKNAME_INVALID", "TOO_FAST", "REJECTED", "RATE_LIMITED",
    "INVITE_NOT_FOUND", "ALREADY_PAIRED", "NOT_FOUND", "NETWORK", "UNKNOWN"];
  for (const code of codes) {
    const text = errorMessage(code);
    expect(text).toMatch(/[一-鿿]/);
    expect(text).not.toContain(code);
  }
  expect(errorMessage("RATE_LIMITED")).toContain("几分钟");
});

test("responses read into results: the body's code, a bare 404, a 204 and an unknown refusal", async () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  expect(await readResponse(json({ resultToken: "r", inviteToken: "i" }, 200))).toEqual({ ok: true, data: { resultToken: "r", inviteToken: "i" } });
  expect(await readResponse(json({ ok: false, code: "TOO_FAST" }, 400))).toEqual({ ok: false, code: "TOO_FAST" });
  expect(await readResponse(json({ ok: false, code: "SOMETHING_NEW" }, 400))).toEqual({ ok: false, code: "UNKNOWN" });
  expect(await readResponse(new Response("nope", { status: 404 }))).toEqual({ ok: false, code: "NOT_FOUND" });
  expect(await readResponse(new Response(null, { status: 204 }))).toEqual({ ok: true, data: null });
});
