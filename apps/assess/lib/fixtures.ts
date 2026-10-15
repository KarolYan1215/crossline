import type { AssessApi } from "./api-client";
import type { ApiErrorCode, AvatarStatus, InviteView, PairView, PublicType, ResultView } from "./contract";
import { RESULT_RETENTION_DAYS } from "./contract";
import { pairRelation, publicType } from "./public-type";

/**
 * Made-up answers for previewing the pages without the server (`NEXT_PUBLIC_ASSESS_FIXTURES=1`). Images are inline SVG placeholders
 * of the right proportions. Tokens steer the preview:
 * - `missing` (any page) answers NOT_FOUND;
 * - a result token starting `drawing` shows the figure being drawn for two polls, then ready;
 * - an email `error-<CODE>@…` on submit answers that refusal, to preview its wording.
 */
const INVITER = publicType({ scope: 78, basis: 44, output: 30, rhythm: 70 });
const VISITOR = publicType({ scope: 22, basis: 30, output: 76, rhythm: 35 });

const escapeXml = (text: string) => text.replace(/[<>&"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" })[char]!);
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A 3:4 poster or card placeholder: the group tint, the code and name, and what it stands in for. */
export function placeholderImage(type: PublicType, label: string, size: { width: number; height: number } = { width: 1080, height: 1440 }): string {
  const { width, height } = size;
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="100%" height="100%" fill="#F6F2EA"/><rect x="40" y="40" width="${width - 80}" height="${height * 0.55}" fill="${type.group.tint}"/>`
    + `<circle cx="${width / 2}" cy="${height * 0.3}" r="${width * 0.16}" fill="${type.group.colour}" opacity="0.85"/>`
    + `<text x="${width / 2}" y="${height * 0.72}" font-family="Arial" font-size="${width * 0.11}" font-weight="700" text-anchor="middle" fill="#1E1B16">${escapeXml(type.code)}</text>`
    + `<text x="${width / 2}" y="${height * 0.8}" font-family="Arial,Microsoft YaHei" font-size="${width * 0.06}" text-anchor="middle" fill="#1E1B16">${escapeXml(type.name)}</text>`
    + `<text x="${width / 2}" y="${height * 0.9}" font-family="Arial,Microsoft YaHei" font-size="${width * 0.035}" text-anchor="middle" fill="#4F4A42">${escapeXml(label)}</text></svg>`);
}

const avatarImage = (type: PublicType, drawn: boolean) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">`
  + `<rect width="100%" height="100%" fill="${type.group.tint}"/><circle cx="240" cy="180" r="90" fill="${type.group.colour}"/>`
  + `<rect x="130" y="290" width="220" height="190" rx="90" fill="${type.group.colour}"/>`
  + `<text x="240" y="460" font-family="Arial,Microsoft YaHei" font-size="28" text-anchor="middle" fill="#1E1B16">${drawn ? "专属形象" : "类型模板"}</text></svg>`);

const avatar = (type: PublicType, state: AvatarStatus["state"]): AvatarStatus => ({ state, url: avatarImage(type, state === "ready") });

const polls = new Map<string, number>();
const origin = () => typeof window === "undefined" ? "http://127.0.0.1:3340" : window.location.origin;
const delay = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 250));
const notFound = { ok: false as const, code: "NOT_FOUND" as const };

export function fixtureResult(token: string): ResultView {
  let state: AvatarStatus["state"] = "ready";
  if (token.startsWith("drawing")) {
    const seen = (polls.get(token) ?? 0) + 1;
    polls.set(token, seen);
    state = seen === 1 ? "queued" : seen <= 2 ? "drawing" : "ready";
  }
  const bust = state === "ready" ? "已换上专属形象" : "基础形象，专属形象绘制中";
  return {
    nickname: "小林", type: INVITER, avatar: avatar(INVITER, state),
    posterUrl: placeholderImage(INVITER, `海报占位 · ${bust}`),
    longUrl: placeholderImage(INVITER, "长图占位", { width: 1080, height: 3000 }),
    inviteUrl: `${origin()}/t/fixture-invite`, sendEmail: true, mailOn: true, betaRequested: false,
    pairs: [
      { pairToken: "fixture-pair", nickname: "阿青", code: VISITOR.code, name: VISITOR.name, relation: pairRelation(INVITER.code, VISITOR.code).primary.name },
      { pairToken: "fixture-pair-2", nickname: "你的朋友", code: INVITER.best.code, name: INVITER.best.name, relation: INVITER.best.relation }
    ],
    expiresAt: new Date(Date.now() + RESULT_RETENTION_DAYS * 86_400_000).toISOString()
  };
}

export function fixtureInvite(): InviteView {
  return { nickname: "小林", type: INVITER, avatar: avatar(INVITER, "ready") };
}

export function fixturePair(): PairView {
  return {
    a: { nickname: "小林", type: INVITER, avatar: avatar(INVITER, "ready") },
    b: { nickname: "阿青", type: VISITOR, avatar: avatar(VISITOR, "template") },
    ...pairRelation(INVITER.code, VISITOR.code),
    cardUrl: placeholderImage(VISITOR, "双人卡占位")
  };
}

export const fixtureApi: AssessApi = {
  submitResult: (request) => {
    const forced = /^error-([A-Z_]+)@/.exec(request.email)?.[1];
    if (forced) return delay({ ok: false, code: forced as ApiErrorCode });
    return delay({ ok: true, data: { resultToken: "fixture-result", inviteToken: "fixture-invite", ...(request.inviteToken ? { pairToken: "fixture-pair" } : {}) } });
  },
  getResult: (token) => delay(token === "missing" ? notFound : { ok: true, data: fixtureResult(token) }),
  requestBeta: (token) => delay(token === "missing" ? notFound : { ok: true, data: null }),
  deleteResult: (token) => delay(token === "missing" ? notFound : { ok: true, data: null }),
  getInvite: (token) => delay(token === "missing" ? notFound : { ok: true, data: fixtureInvite() }),
  getPair: (token) => delay(token === "missing" ? notFound : { ok: true, data: fixturePair() })
};
