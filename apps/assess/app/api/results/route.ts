import { typeFromScores } from "@crossline/core/assess";
import type { SubmitResponse } from "../../../lib/contract";
import { publicType } from "../../../lib/public-type";
import { enqueueAvatar } from "../../../server/avatar";
import { sendPairNotice, sendResultMail } from "../../../server/mail";
import { clientIp, crossSiteWrite, fail, json, parseSubmission, submitsPerEmail, submitsPerIp } from "../../../server/security";
import { createPair, createResult, getResultByInvite } from "../../../server/store";

/**
 * POST /api/results: one finished test. Scores are recomputed here from the answers; the answers themselves are not stored.
 *
 * Coming through an invitation makes the pair card at once. One pair per invitation and address: answering the same invitation again
 * with the same address still stores the new result (with its own tokens) but returns the pair made the first time, which keeps the
 * first answers — the inviter's card does not change under them. Answering one's own invitation is refused with `ALREADY_PAIRED`.
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

  let pairToken: string | undefined;
  if (inviter) {
    const { pair, created } = createPair(inviter.id, result.id);
    pairToken = pair.pairToken;
    if (created && inviter.sendEmail) sendPairNotice(inviter, result.nickname, pair.pairToken);
  }
  if (result.sendEmail) {
    const type = publicType(result.scores);
    sendResultMail(result, { code: type.code, name: type.name, subtitle: type.subtitle });
  }
  const response: SubmitResponse = { resultToken: result.resultToken, inviteToken: result.inviteToken, ...(pairToken ? { pairToken } : {}) };
  return json(response);
}
