/**
 * Links a mail itself carries, kept for the task it became (walkthrough W-158, 2026-10-29). A tax system's identity-verification mail
 * became the task 「完成 GLACIER 身份验证」, whose step plan then asked the person for 「GLACIER 身份验证链接」 — the link was in the
 * mail all along. Code reads the links out of the mail's text (the model never sees the body); a need for a link on that task is then
 * settled from them (`settleLinkNeeds` in `@crossline/db`) and the task shows them.
 *
 * Only https links on the sender's own domain (the last two labels of the host, `glaciertax.com` for `support.glaciertax.com`), at most
 * three, without tracking parameters: a link to another domain in a mail is how phishing works, and the account-alert mail is already
 * told 「不要点邮件里的链接」. A link with a one-time token is the person's to open; it is kept in a setting, never handed to a model.
 */
export const MAIL_LINKS_MAX = 3;
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_eid|mc_cid)$/i;

const siteOf = (host: string) => host.toLowerCase().replace(/\.$/, "").split(".").slice(-2).join(".");

export function linksFromMail(body: string, fromAddress: string): string[] {
  const sender = fromAddress.split("@")[1];
  if (!sender) return [];
  const site = siteOf(sender);
  const out: string[] = [];
  for (const match of body.matchAll(/https:\/\/[^\s<>"'）)\]】]+/g)) {
    let url: URL;
    try { url = new URL(match[0].replace(/[.,;:!?。，；：！？]+$/, "")); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.port || siteOf(url.hostname) !== site) continue;
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    const href = url.toString();
    if (!out.includes(href)) out.push(href);
    if (out.length >= MAIL_LINKS_MAX) break;
  }
  return out;
}

/** The setting holding a mail capture's links (`linksFromMail`), keyed by the capture, which is the task's id once it is analysed. */
export const mailLinksKey = (captureId: string) => `mail.links:${captureId}`;

/** A need that is a link sent to the person (「身份验证链接」「报名链接」「the invite URL」). */
export const isLinkNeed = (need: { what: string }) => /链接|网址|网页地址|\blink\b|\burl\b/i.test(need.what);
