import { typeFromScores } from "@crossline/core/assess";
import { TESTS_PER_EMAIL, type SubmitResponse } from "../../../lib/contract";
import { publicType } from "../../../lib/public-type";
import { enqueueAvatar } from "../../../server/avatar";
import { sendPairNotice, sendResultMail } from "../../../server/mail";
import { clientIp, crossSiteWrite, fail, json, parseSubmission, submitsPerEmail, submitsPerIp } from "../../../server/security";
import { createPair, createResult, findPair, getResultByInvite, keepOnlyNewest, latestResultByEmail, testsTakenBy } from "../../../server/store";

/**
 * POST /api/results: one finished test. Scores are recomputed here from the answers; the answers themselves are not stored.
 *
 * Coming through an invitation makes the pair card at once. Answering the same invitation again with the same address replaces the
 * earlier answer and its card (the rule below), and the inviter is mailed only the first time. Answering one's own invitation is
 * refused with `ALREADY_PAIRED`.
 *
 * One address, at most `TESTS_PER_EMAIL` tests, only the newest kept (decided 2026-10-15): a new test deletes the address's earlier
 * results by the same rule as 「删除我的结果」. A fourth is refused with `EMAIL_LIMIT_REACHED`, and the newest result's link is mailed
 * to the address again — never put in the answer, since whoever typed the address may not own it.
 */
export async function POST(request: Request): Promise<Response> {
  if (crossSiteWrite(request)) return fail("REJECTED");
  const byIp = submitsPerIp.hit(clientIp(request));
  if (!byIp.ok) return fail("RATE_LIMITED", byIp.retryAfter);
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = parseSubmission(body);
  if (!parsed.ok) return fail(parsed.code);
  const submission = parsed.value;

  const inviter = submission.inviteToken ? getResultByInvite(submission.inviteToken) : undefined;
  if (submission.inviteToken && !inviter) return fail("INVITE_NOT_FOUND");
  if (inviter && inviter.email === submission.email) return fail("ALREADY_PAIRED");
  const byEmail = submitsPerEmail.hit(submission.email);
  if (!byEmail.ok) return fail("RATE_LIMITED", byEmail.retryAfter);
  if (testsTakenBy(submission.email) >= TESTS_PER_EMAIL) {
    const latest = latestResultByEmail(submission.email);
    if (latest) {
      const type = publicType(latest.scores, {}, latest.id);
      sendResultMail(latest, { code: type.code, name: type.name, subtitle: type.subtitle });
    }
    return fail("EMAIL_LIMIT_REACHED");
  }
  // Answering the same invitation again replaces the first answer and its card, but the inviter is told only once.
  const pairedBefore = inviter ? Boolean(findPair(inviter.id, submission.email)) : false;

  const result = createResult({
    email: submission.email, nickname: submission.nickname, scores: submission.scores, code: typeFromScores(submission.scores).code,
    appearance: submission.appearance, sendEmail: submission.sendEmail
  });
  try {
    enqueueAvatar(result);
  } catch (error) {
    // The figure is a bonus: the template stands in until it exists, so the submission never fails over it.
    console.warn(JSON.stringify({ event: "assess.avatar_enqueue_failed", resultId: result.id, error: error instanceof Error ? error.message : String(error) }));
  }
  keepOnlyNewest(result);

  let pairToken: string | undefined;
  if (inviter) {
    const { pair, created } = createPair(inviter.id, result.id);
    pairToken = pair.pairToken;
    if (created && !pairedBefore && inviter.sendEmail) sendPairNotice(inviter, result.nickname, pair.pairToken);
  }
  if (result.sendEmail) {
    const type = publicType(result.scores, {}, result.id);
    sendResultMail(result, { code: type.code, name: type.name, subtitle: type.subtitle });
  }
  const response: SubmitResponse = { resultToken: result.resultToken, inviteToken: result.inviteToken, ...(pairToken ? { pairToken } : {}) };
  return json(response);
}
