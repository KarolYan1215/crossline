import { timingSafeEqual } from "node:crypto";
import { applyAsVisitor, invitesAvailable } from "../../../../lib/invites";
import { DEFAULT_LOCALE, localeFromCookieHeader, tFor } from "../../../../lib/i18n";
import { isCrossSiteWrite } from "../../../../lib/same-origin";

export const runtime = "nodejs";

/**
 * POST /api/invites/request `{email, reason?, website?}`: a visitor with no account applies for the developer's model (the sign-in
 * page's 「申请内测」). The owner is mailed the link that decides it, as for an account's application. No session needed, so: a hidden
 * `website` field that only scripts fill, ten applications an hour per address and five a day per email, and the same answer whether or
 * not the address had applied. The public test passes its own 「申请内测」 on with `Authorization: Bearer <ASSESS_LINK_SECRET>`: one
 * server for many people, so it is not held to the per-address limit, and it may name `source: "assess"` and a `detail` (the type).
 */
const HOUR = 3_600_000;
const PER_IP_HOUR = 10;
const PER_EMAIL_DAY = 5;
const hits = new Map<string, number[]>();

function limited(key: string, max: number, windowMs: number, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function fromAssess(request: Request): boolean {
  const secret = process.env.ASSESS_LINK_SECRET?.trim();
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!secret || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const MESSAGES: Record<string, string> = {
  INVITES_UNAVAILABLE: "这里暂时不能申请。",
  EMAIL_INVALID: "邮箱格式不对。",
  RATE_LIMITED: "申请太频繁，请稍后再试。",
  INVITE_MAIL_FAILED: "申请没有送达开发者，请稍后再试。"
};
export async function POST(request: Request) {
  // No account here: the language is the visitor's cookie (docs/i18n.md).
  const t = tFor(localeFromCookieHeader(request.headers.get("cookie")) ?? DEFAULT_LOCALE);
  const fail = (code: string, status: number) => Response.json({ ok: false, code, message: t(MESSAGES[code] ?? "申请没有成功。") }, { status });
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  if (!invitesAvailable()) return fail("INVITES_UNAVAILABLE", 404);
  const body = await request.json().catch(() => ({})) as { email?: unknown; reason?: unknown; website?: unknown; source?: unknown; detail?: unknown };
  const assess = fromAssess(request);
  // A filled honeypot is answered as a success, so a script learns nothing from it.
  if (typeof body.website === "string" && body.website.trim()) return Response.json({ ok: true });
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) return fail("EMAIL_INVALID", 400);
  const now = Date.now();
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if ((!assess && limited(`ip:${ip}`, PER_IP_HOUR, HOUR, now)) || limited(`email:${email}`, PER_EMAIL_DAY, 24 * HOUR, now)) {
    return Response.json({ ok: false, code: "RATE_LIMITED", message: t(MESSAGES.RATE_LIMITED!) }, { status: 429, headers: { "retry-after": "3600" } });
  }
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : "";
  const detail = assess && typeof body.detail === "string" ? body.detail.slice(0, 60) : undefined;
  const result = await applyAsVisitor(email, reason, assess && body.source === "assess" ? "assess" : "login", detail);
  if (!result.ok) return fail(result.code, result.code === "INVITE_MAIL_FAILED" ? 502 : 409);
  return Response.json({ ok: true });
}
