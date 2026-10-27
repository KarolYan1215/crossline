import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { InviteView, PairView, ResultView, SubmitResponse } from "../../lib/contract";
import { flushMail, MAIL_RETRY_DELAYS_MS, setMailRetryDelays } from "../../server/mail";
import { resetRateLimits, submitsPerIp } from "../../server/security";
import { createResult, getResultByToken, listPairs } from "../../server/store";
import { answersFor, appearance, get, params, post, submission, useTempDataDir } from "../../server/testing";
import { GET as getInvite } from "./invites/[token]/route";
import { GET as getPair } from "./pairs/[token]/route";
import { DELETE as deleteResultRoute, GET as getResult } from "./results/[token]/route";
import { POST as submit } from "./results/route";
import { POST as requestBetaRoute } from "./results/[token]/beta/route";

const mocks = vi.hoisted(() => ({
  sendMail: vi.fn(async () => ({ messageId: "x" })),
  enqueueAvatar: vi.fn((): void => { throw new Error("NOT_IMPLEMENTED: server/avatar belongs to workstream W5"); }),
  avatarStatus: vi.fn((): never => { throw new Error("NOT_IMPLEMENTED: server/avatar belongs to workstream W5"); })
}));
vi.mock("nodemailer", () => ({ createTransport: vi.fn(() => ({ sendMail: mocks.sendMail })) }));
vi.mock("../../server/avatar", () => ({
  enqueueAvatar: mocks.enqueueAvatar, avatarStatus: mocks.avatarStatus, retryAvatarIfDue: () => false,
  avatarImagePath: () => "", templateImagePath: () => ""
}));
vi.mock("../../server/poster", () => ({ renderTypePoster: vi.fn(), renderLongImage: vi.fn(), renderPairCard: vi.fn() }));

const temp = useTempDataDir();
const SMTP = { ASSESS_SMTP_HOST: "smtp.example.com", ASSESS_SMTP_PORT: "465", ASSESS_SMTP_USER: "u", ASSESS_SMTP_PASSWORD: "p", ASSESS_MAIL_FROM: "测评 <hi@example.com>" };

beforeEach(() => {
  temp.dir();
  resetRateLimits();
  mocks.sendMail.mockClear();
  mocks.enqueueAvatar.mockClear();
  Object.assign(process.env, SMTP, { ASSESS_BASE_URL: "https://assess.example" });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await flushMail();
  temp.cleanup();
  for (const key of [...Object.keys(SMTP), "ASSESS_BASE_URL"]) delete process.env[key];
  vi.restoreAllMocks();
});

async function submitOk(overrides: Parameters<typeof submission>[0] = {}, headers: Record<string, string> = {}): Promise<SubmitResponse> {
  const response = await submit(post(submission(overrides), headers));
  expect(response.status).toBe(200);
  return await response.json() as SubmitResponse;
}
const codeOf = async (response: Response) => ({ status: response.status, body: await response.json() as { ok: boolean; code: string } });

test("a submission stores the result, starts the figure, mails the person and answers both tokens", async () => {
  const answer = await submitOk();
  expect(Object.keys(answer).sort()).toEqual(["inviteToken", "resultToken"]);
  const stored = getResultByToken(answer.resultToken)!;
  expect(stored.email).toBe("alice@example.com");
  expect(stored.code).toBe("ROHG");
  expect(mocks.enqueueAvatar).toHaveBeenCalledOnce();
  await flushMail();
  expect(mocks.sendMail).toHaveBeenCalledOnce();
  const mail = (mocks.sendMail.mock.calls[0] as unknown as [Record<string, string>])[0];
  expect(mail.to).toBe("alice@example.com");
  expect(mail.from).toBe(SMTP.ASSESS_MAIL_FROM);
  expect(mail.subject).toContain("ROHG");
  for (const part of [mail.text, mail.html]) {
    expect(part).toContain(`https://assess.example/r/${answer.resultToken}`);
    expect(part).toContain(`https://assess.example/t/${answer.inviteToken}`);
    expect(part).toContain(`https://assess.example/r/${answer.resultToken}?delete=1`);
    expect(part).toContain("90 天");
  }
});

test("no mail when the box is unticked, and none (logged as skipped) without SMTP configuration", async () => {
  await submitOk({ sendEmail: false });
  await flushMail();
  expect(mocks.sendMail).not.toHaveBeenCalled();
  delete process.env.ASSESS_SMTP_HOST;
  const info = vi.mocked(console.info);
  await submitOk({ email: "other@example.com" });
  await flushMail();
  expect(mocks.sendMail).not.toHaveBeenCalled();
  expect(info.mock.calls.some(([line]) => String(line).includes("SMTP_NOT_CONFIGURED"))).toBe(true);
  expect(info.mock.calls.some(([line]) => String(line).includes("other@example.com"))).toBe(false);
});

test("a failing mail never fails the submission", async () => {
  mocks.sendMail.mockRejectedValueOnce(Object.assign(new Error("550 rejected"), { responseCode: 550 }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await submitOk();
  await flushMail();
  expect(error.mock.calls.some(([line]) => String(line).includes("assess.mail_failed"))).toBe(true);
  expect(mocks.sendMail).toHaveBeenCalledTimes(1);
});

test("a mail the service turns away for now (too many at once) is sent again later instead of being dropped", async () => {
  setMailRetryDelays([5, 5]);
  mocks.sendMail.mockRejectedValueOnce(Object.assign(new Error("421 too many connections"), { responseCode: 421 }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  await submitOk();
  await flushMail();
  setMailRetryDelays(MAIL_RETRY_DELAYS_MS);
  expect(mocks.sendMail).toHaveBeenCalledTimes(2);
  expect(info.mock.calls.some(([line]) => String(line).includes("assess.mail_sent"))).toBe(true);
});

test("every refusal answers its code and stores nothing", async () => {
  const cases: Array<[unknown, string, number]> = [
    [submission({ website: "http://spam" }), "REJECTED", 400],
    [submission({ startedAt: Date.now() - 39_000 }), "TOO_FAST", 400],
    [submission({ startedAt: Date.now() + 60_000 }), "TOO_FAST", 400],
    [{ ...submission(), startedAt: "yesterday" }, "REJECTED", 400],
    [submission({ answers: { ...answersFor(), q7: 6 } }), "QUIZ_INCOMPLETE", 400],
    [submission({ answers: Object.fromEntries(Object.entries(answersFor()).slice(1)) }), "QUIZ_INCOMPLETE", 400],
    [submission({ appearance: { ...appearance, hair: "mohawk" as never } }), "APPEARANCE_INVALID", 400],
    [submission({ appearance: { ...appearance, note: "红".repeat(41) } }), "APPEARANCE_INVALID", 400],
    [submission({ appearance: { ...appearance, extra: 1 } as never }), "APPEARANCE_INVALID", 400],
    [submission({ email: "not-an-email" }), "EMAIL_INVALID", 400],
    [submission({ email: `${"a".repeat(250)}@x.cn` }), "EMAIL_INVALID", 400],
    [submission({ nickname: "名".repeat(13) }), "NICKNAME_INVALID", 400],
    [submission({ inviteToken: "nope" }), "INVITE_NOT_FOUND", 404],
    ["{not json", "REJECTED", 400]
  ];
  for (const [body, code, status] of cases) expect(await codeOf(await submit(post(body)))).toEqual({ status, body: { ok: false, code } });
  expect(await codeOf(await submit(post(submission(), { origin: "https://evil.example" })))).toEqual({ status: 400, body: { ok: false, code: "REJECTED" } });
  expect(await codeOf(await submit(post(submission(), { origin: "http://assess.test" })))).toMatchObject({ status: 200 });
});

test("the free note is kept without invisible characters; a name made only of them is empty", async () => {
  const answer = await submitOk({ appearance: { ...appearance, note: "红​色‮帽子\n" }, nickname: "‍‍" });
  const stored = getResultByToken(answer.resultToken)!;
  expect(stored.appearance.note).toBe("红色帽子");
  expect(stored.nickname).toBe("");
});

test("submissions are limited per address and per email", async () => {
  for (let index = 0; index < 3; index++) await submitOk({ email: "same@example.com" });
  for (let index = 0; index < 2; index++) expect((await submit(post(submission({ email: "same@example.com" })))).status).toBe(409);
  const perEmail = await submit(post(submission({ email: "same@example.com" })));
  expect(perEmail.status).toBe(429);
  expect(perEmail.headers.get("retry-after")).toMatch(/^\d+$/);
  expect((await perEmail.json() as { code: string }).code).toBe("RATE_LIMITED");
  for (let index = 0; index < submitsPerIp.limit - 6; index++) await submitOk({ email: `n${index}@example.com` });
  expect((await submit(post(submission({ email: "fresh@example.com" })))).status).toBe(429);
  // Another client behind the same proxy is counted on its own.
  expect((await submit(post(submission({ email: "fresh@example.com" }), { "x-forwarded-for": "198.51.100.9" }))).status).toBe(200);
});

test("an invitation makes the pair at once, mails the inviter, and a repeat by the same address returns the same pair", async () => {
  const inviter = await submitOk({ email: "a@example.com", nickname: "阿甲" });
  await flushMail();
  mocks.sendMail.mockClear();
  const invited = await submitOk({ email: "b@example.com", nickname: "阿乙", inviteToken: inviter.inviteToken, sendEmail: false,
    answers: answersFor({ lines: false, purpose: true, collab: true, build: false }) });
  expect(invited.pairToken).toBeDefined();
  await flushMail();
  expect(mocks.sendMail).toHaveBeenCalledOnce();
  const notice = (mocks.sendMail.mock.calls[0] as unknown as [Record<string, string>])[0];
  expect(notice.to).toBe("a@example.com");
  expect(notice.subject).toContain("阿乙");
  expect(notice.text).toContain(`https://assess.example/p/${invited.pairToken}`);
  expect(notice.text).toContain(`https://assess.example/r/${inviter.resultToken}?delete=1`);
  expect(notice.text).not.toContain("b@example.com");

  // Answering again replaces the first answer and its card; the inviter is not mailed a second time.
  mocks.sendMail.mockClear();
  const again = await submitOk({ email: "B@Example.com", inviteToken: inviter.inviteToken, sendEmail: false });
  expect(again.pairToken).toBeDefined();
  expect(again.pairToken).not.toBe(invited.pairToken);
  expect(getResultByToken(invited.resultToken)).toBeUndefined();
  await flushMail();
  expect(mocks.sendMail).not.toHaveBeenCalled();
  expect(listPairs(getResultByToken(inviter.resultToken)!.id).map((pair) => pair.pairToken)).toEqual([again.pairToken]);
});

test("the inviter cannot answer their own invitation, and an inviter with mail off is not mailed", async () => {
  const inviter = await submitOk({ email: "a@example.com", sendEmail: false });
  expect(await codeOf(await submit(post(submission({ email: "A@example.com", inviteToken: inviter.inviteToken })))))
    .toEqual({ status: 409, body: { ok: false, code: "ALREADY_PAIRED" } });
  await submitOk({ email: "c@example.com", inviteToken: inviter.inviteToken, sendEmail: false });
  await flushMail();
  expect(mocks.sendMail).not.toHaveBeenCalled();
});

test("the result view: the public type, the template figure when the pipeline cannot answer, the links and the pairs", async () => {
  const inviter = await submitOk({ email: "a@example.com", nickname: "阿甲" });
  const invited = await submitOk({ email: "b@example.com", nickname: "阿乙", inviteToken: inviter.inviteToken,
    answers: answersFor({ lines: false, purpose: true, collab: true, build: false }) });
  const response = await getResult(get(`/api/results/${inviter.resultToken}`), params(inviter.resultToken));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const view = await response.json() as ResultView;
  expect(view).toMatchObject({
    nickname: "阿甲", sendEmail: true,
    avatar: { state: "template", url: `/api/avatar/${inviter.inviteToken}.png` },
    posterUrl: `/api/poster/${inviter.inviteToken}/type.png?f=t`, longUrl: `/api/poster/${inviter.inviteToken}/long.png?f=t`,
    inviteUrl: `https://assess.example/t/${inviter.inviteToken}`
  });
  expect(view.type.code).toBe("ROHG");
  expect(view.pairs).toEqual([expect.objectContaining({ pairToken: invited.pairToken, nickname: "阿乙", code: "WUBA" })]);
  expect(view.pairs[0]!.relation.length).toBeGreaterThan(0);

  mocks.avatarStatus.mockReturnValueOnce({ state: "ready", url: "/api/avatar/x.png" } as never);
  const ready = await (await getResult(get(`/api/results/${inviter.resultToken}`), params(inviter.resultToken))).json() as ResultView;
  expect(ready.avatar).toEqual({ state: "ready", url: "/api/avatar/x.png" });
});

test("the invitation and the pair card show only public parts, addressed by their own tokens", async () => {
  const inviter = await submitOk({ email: "a@example.com", nickname: "阿甲", appearance: { ...appearance, note: "红帽子" } });
  const invited = await submitOk({ email: "b@example.com", nickname: "阿乙", inviteToken: inviter.inviteToken });
  const inviteResponse = await getInvite(get(`/api/invites/${inviter.inviteToken}`), params(inviter.inviteToken));
  const invite = await inviteResponse.json() as InviteView;
  expect(invite.nickname).toBe("阿甲");
  expect(Object.keys(invite).sort()).toEqual(["avatar", "nickname", "type"]);
  const pair = await (await getPair(get(`/api/pairs/${invited.pairToken}`), params(invited.pairToken!))).json() as PairView;
  expect(pair.a.nickname).toBe("阿甲");
  expect(pair.b.nickname).toBe("阿乙");
  expect(pair.cardUrl).toBe(`/api/poster/pair/${invited.pairToken}.png?f=t.t`);
  expect(pair.primary.tips).toHaveLength(2);

  const resultBody = JSON.stringify(await (await getResult(get(`/api/results/${inviter.resultToken}`), params(inviter.resultToken))).json());
  for (const body of [JSON.stringify(invite), JSON.stringify(pair), resultBody]) {
    expect(body).not.toMatch(/@example\.com|answers|appearance|红帽子|"q\d+"/);
  }
  for (const body of [JSON.stringify(invite), JSON.stringify(pair)]) {
    expect(body).not.toContain(inviter.resultToken);
    expect(body).not.toContain(invited.resultToken);
  }
  // An invitation token never opens the private result, and a result token never opens an invitation.
  expect((await getResult(get(`/api/results/${inviter.inviteToken}`), params(inviter.inviteToken))).status).toBe(404);
  expect((await getInvite(get(`/api/invites/${inviter.resultToken}`), params(inviter.resultToken))).status).toBe(404);
});

test("deleting removes the result, its pairs and every link to them; a cross-site delete is refused", async () => {
  const inviter = await submitOk({ email: "a@example.com" });
  const invited = await submitOk({ email: "b@example.com", inviteToken: inviter.inviteToken });
  const forged = await deleteResultRoute(get(`/api/results/${inviter.resultToken}`, { origin: "https://evil.example" }, "DELETE"), params(inviter.resultToken));
  expect(forged.status).toBe(400);
  const removed = await deleteResultRoute(get(`/api/results/${inviter.resultToken}`, {}, "DELETE"), params(inviter.resultToken));
  expect(await removed.json()).toEqual({ ok: true });
  expect((await getResult(get(`/api/results/${inviter.resultToken}`), params(inviter.resultToken))).status).toBe(404);
  expect((await getInvite(get(`/api/invites/${inviter.inviteToken}`), params(inviter.inviteToken))).status).toBe(404);
  expect((await getPair(get(`/api/pairs/${invited.pairToken}`), params(invited.pairToken!))).status).toBe(404);
  const invitee = await (await getResult(get(`/api/results/${invited.resultToken}`), params(invited.resultToken))).json() as ResultView;
  expect(invitee.pairs).toEqual([]);
  expect((await deleteResultRoute(get(`/api/results/${inviter.resultToken}`, {}, "DELETE"), params(inviter.resultToken))).status).toBe(404);
});

test("an address that keeps missing tokens is slowed down", async () => {
  for (let index = 0; index < 30; index++) {
    expect((await getInvite(get(`/api/invites/guess${index}`), params(`guess${index}`))).status).toBe(404);
  }
  const limited = await getInvite(get("/api/invites/guess-more"), params("guess-more"));
  expect(limited.status).toBe(429);
  const stored = createResult({ email: "z@example.com", nickname: "", scores: { lines: 50, purpose: 50, collab: 50, build: 50 }, aiDoes: [], code: "WUHG", appearance, sendEmail: false });
  expect((await getInvite(get(`/api/invites/${stored.inviteToken}`, { "x-forwarded-for": "198.51.100.1" }), params(stored.inviteToken))).status).toBe(200);
});

test("「申请内测」 is recorded on the person's own result only, refuses a forged origin, and shows on the result", async () => {
  const answer = await submitOk({ email: "beta@example.com" });
  const before = await (await getResult(get(`/api/results/${answer.resultToken}`), params(answer.resultToken))).json() as ResultView;
  expect(before.betaRequested).toBe(false);
  const forged = await requestBetaRoute(get(`/api/results/${answer.resultToken}/beta`, { origin: "https://evil.example" }, "POST"), params(answer.resultToken));
  expect(forged.status).toBe(400);
  // The invitation token is public (it is on the poster): it must not ask on the person's behalf.
  expect((await requestBetaRoute(get(`/api/results/${answer.inviteToken}/beta`, {}, "POST"), params(answer.inviteToken))).status).toBe(404);
  expect((await requestBetaRoute(get(`/api/results/${answer.resultToken}/beta`, {}, "POST"), params(answer.resultToken))).status).toBe(200);
  const after = await (await getResult(get(`/api/results/${answer.resultToken}`), params(answer.resultToken))).json() as ResultView;
  expect(after.betaRequested).toBe(true);
});

test("three tests per address, only the newest kept; a fourth is refused and the newest link is mailed, not returned", async () => {
  const first = await submitOk({ email: "three@example.com" });
  const friend = await submitOk({ email: "friend@example.com", inviteToken: first.inviteToken, sendEmail: false });
  await submitOk({ email: "three@example.com" });
  const third = await submitOk({ email: "THREE@example.com" });
  // The earlier results, their invitations and their pair cards are gone, as if deleted by hand.
  expect(getResultByToken(first.resultToken)).toBeUndefined();
  expect((await getInvite(get(`/api/invites/${first.inviteToken}`), params(first.inviteToken))).status).toBe(404);
  expect((await getPair(get(`/api/pairs/${friend.pairToken}`), params(friend.pairToken!))).status).toBe(404);
  expect(getResultByToken(third.resultToken)).toBeDefined();
  await flushMail();
  mocks.sendMail.mockClear();
  const fourth = await submit(post(submission({ email: "three@example.com" })));
  expect(fourth.status).toBe(409);
  const body = await fourth.json() as Record<string, unknown>;
  expect(body).toEqual({ ok: false, code: "EMAIL_LIMIT_REACHED" });
  await flushMail();
  const resent = (mocks.sendMail.mock.calls[0] as unknown as [Record<string, string>])[0];
  expect(resent.to).toBe("three@example.com");
  expect(resent.text).toContain(`/r/${third.resultToken}`);
  // Deleting the newest does not give a test back.
  await deleteResultRoute(get(`/api/results/${third.resultToken}`, {}, "DELETE"), params(third.resultToken));
  expect((await submit(post(submission({ email: "three@example.com" })))).status).toBe(409);
});
