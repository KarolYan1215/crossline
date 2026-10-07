/**
 * Words that mean the work reaches outside this machine or commits the person to someone: sending,
 * publishing, submitting, paying, signing, trading, deleting. One list, read by everything that decides
 * whether something may go ahead without the person — the goal backplanner (a step that matches is
 * `high_risk`) and the auto-approval rule (a proposal that matches always waits for a click).
 *
 * It is matched against what the work *is* (its intent and the person's own part), never against a
 * serialized payload: that used to catch the word "file" in a contract's `kind` and "order" in the
 * phrase "work order", so nothing at all qualified.
 */
export const EXTERNAL_ACTION_PATTERN =
  /\b(email|message|publish|post|submit|purchase|sell|buy|sign|legal|transfer|delete|trade)\b|邮件|发送|发布|投稿|提交|购买|出售|签署|法律|转账|删除|交易|订单|券商|产权|财产/i;

export function mentionsExternalAction(...texts: Array<string | undefined>): boolean {
  return EXTERNAL_ACTION_PATTERN.test(texts.filter(Boolean).join(" "));
}
