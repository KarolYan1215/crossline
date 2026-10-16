import { createTransport, type Transporter } from "nodemailer";
import { RESULT_RETENTION_DAYS } from "../lib/contract";
import { baseUrl } from "./config";
import type { StoredResult } from "./store";

/**
 * The only two mails this test sends (docs/beta-launch.md §0, §6): the person's own result, and the notice to an inviter that someone
 * finished their invitation. No marketing, and every mail carries the link that deletes the result. Sent over SMTP from
 * `ASSESS_SMTP_HOST`/`_PORT`/`_USER`/`_PASSWORD` as `ASSESS_MAIL_FROM`; without that configuration a mail is logged as skipped. A send
 * never fails the request that caused it: it runs after the answer, and a failure is logged with the result's id, never the address.
 */

type SmtpConfig = { host: string; port: number; user: string; password: string; from: string };

function smtpConfig(): SmtpConfig | undefined {
  const { ASSESS_SMTP_HOST: host, ASSESS_SMTP_PORT: port, ASSESS_SMTP_USER: user, ASSESS_SMTP_PASSWORD: password, ASSESS_MAIL_FROM: from } = process.env;
  if (!host || !user || !password || !from) return undefined;
  return { host, port: Number(port) || 465, user, password, from };
}

/** Whether mail can go out at all: the result page says so instead of promising a mail that is only logged as skipped. */
export const mailConfigured = (): boolean => smtpConfig() !== undefined;

let transport: { key: string; send: Transporter } | undefined;

function transporter(config: SmtpConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.user}`;
  if (transport?.key === key) return transport.send;
  // 465 is implicit TLS; any other port (587, Aliyun's 80) upgrades with STARTTLS and must not stay in clear text.
  // Pooled: a burst of people finishing together queues behind two open connections instead of opening one each, which a mail
  // service answers by refusing the extra ones.
  const send = createTransport({
    pool: true, maxConnections: 2, maxMessages: 100,
    host: config.host, port: config.port, secure: config.port === 465, requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000
  });
  transport = { key, send };
  return send;
}

const inflight = new Set<Promise<void>>();

/** Waits for every mail started so far (tests, and a graceful shutdown). */
export async function flushMail(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

export type Mail = { to: string; subject: string; text: string; html: string };

/** Waits before another try at a mail the service turned away for now (a 4xx answer, a dropped connection, too many at once). */
export const MAIL_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
let retryDelays = MAIL_RETRY_DELAYS_MS;
/** Tests shorten the waits. */
export function setMailRetryDelays(delays: number[]): void { retryDelays = delays; }

/** A refusal a later try can get past: a temporary SMTP answer (4xx) or no answer at all. A permanent one (5xx, a bad address) is final. */
function temporary(error: unknown): boolean {
  const code = (error as { responseCode?: unknown })?.responseCode;
  return typeof code === "number" ? code >= 400 && code < 500 : true;
}

function deliver(mail: Mail, resultId: string, kind: string): void {
  const config = smtpConfig();
  if (!config) {
    console.info(JSON.stringify({ event: "assess.mail_skipped", kind, resultId, reason: "SMTP_NOT_CONFIGURED" }));
    return;
  }
  const attempt = async (tries: number): Promise<void> => {
    try {
      await transporter(config).sendMail({ from: config.from, ...mail });
      console.info(JSON.stringify({ event: "assess.mail_sent", kind, resultId, ...(tries ? { tries: tries + 1 } : {}) }));
    } catch (error) {
      const wait = retryDelays[tries];
      const message = error instanceof Error ? error.message : String(error);
      if (wait === undefined || !temporary(error)) {
        console.error(JSON.stringify({ event: "assess.mail_failed", kind, resultId, tries: tries + 1, error: message }));
        return;
      }
      console.warn(JSON.stringify({ event: "assess.mail_retry", kind, resultId, tries: tries + 1, waitMs: wait, error: message }));
      await new Promise((resolve) => setTimeout(resolve, wait));
      await attempt(tries + 1);
    }
  };
  const sending = attempt(0).finally(() => { inflight.delete(sending); });
  inflight.add(sending);
}

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const links = (result: StoredResult) => ({
  result: `${baseUrl()}/r/${result.resultToken}`,
  invite: `${baseUrl()}/t/${result.inviteToken}`,
  remove: `${baseUrl()}/r/${result.resultToken}?delete=1`
});

const FOOTER_TEXT = (remove: string) => [
  `结果保存 ${RESULT_RETENTION_DAYS} 天，到期自动删除。现在就删除：${remove}`,
  "这封邮件只因你在测评里留了邮箱。我们不发营销邮件。"
];

const page = (paragraphs: string[]): string =>
  `<!doctype html><html lang="zh-CN"><body style="font-family:Arial,'Microsoft YaHei',sans-serif;font-size:15px;line-height:1.6;color:#222">${
    paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}</body></html>`;
const anchor = (href: string, label: string) => `<a href="${escape(href)}">${escape(label)}</a>`;

/** The result mail: the type, the link back, the invitation to pass on, the deletion link and the retention note. */
export function resultMail(result: StoredResult, type: { code: string; name: string; subtitle: string }): Mail {
  const link = links(result);
  return {
    to: result.email,
    subject: `你的测评结果：${type.name} ${type.code}`,
    text: [
      `你的类型：${type.name}（${type.code}）`,
      type.subtitle,
      `查看结果和海报：${link.result}`,
      `邀请朋友测测你们是什么关系（把这个链接发给 TA）：${link.invite}`,
      ...FOOTER_TEXT(link.remove)
    ].join("\n\n"),
    html: page([
      `你的类型：<strong>${escape(type.name)}（${escape(type.code)}）</strong>`,
      escape(type.subtitle),
      `${anchor(link.result, "查看结果和海报")}`,
      `邀请朋友测测你们是什么关系，把这个链接发给 TA：<br>${anchor(link.invite, link.invite)}`,
      `结果保存 ${RESULT_RETENTION_DAYS} 天，到期自动删除。${anchor(link.remove, "删除我的结果")}`,
      "这封邮件只因你在测评里留了邮箱。我们不发营销邮件。"
    ])
  };
}

/** The notice to the inviter: someone finished their invitation, and the pair card is ready. */
export function pairNoticeMail(inviter: StoredResult, inviteeNickname: string, pairToken: string): Mail {
  const link = links(inviter);
  const who = inviteeNickname || "你邀请的朋友";
  const card = `${baseUrl()}/p/${pairToken}`;
  return {
    to: inviter.email,
    subject: `${who}完成了测评，来看你们的双人卡`,
    text: [
      `${who}通过你的邀请完成了测评。`,
      `你们的双人卡：${card}`,
      `你的结果（含所有双人卡）：${link.result}`,
      ...FOOTER_TEXT(link.remove)
    ].join("\n\n"),
    html: page([
      `${escape(who)}通过你的邀请完成了测评。`,
      anchor(card, "来看你们的双人卡"),
      `${anchor(link.result, "你的结果")}（含所有双人卡）`,
      `结果保存 ${RESULT_RETENTION_DAYS} 天，到期自动删除。${anchor(link.remove, "删除我的结果")}`,
      "这封邮件只因你在测评里留了邮箱。我们不发营销邮件。"
    ])
  };
}

export function sendResultMail(result: StoredResult, type: { code: string; name: string; subtitle: string }): void {
  deliver(resultMail(result, type), result.id, "result");
}

export function sendPairNotice(inviter: StoredResult, inviteeNickname: string, pairToken: string): void {
  deliver(pairNoticeMail(inviter, inviteeNickname, pairToken), inviter.id, "pair");
}
