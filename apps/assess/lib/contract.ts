/**
 * The public quick test's contract (docs/beta-launch.md §1, §3; P-L1, 2026-10-14): what the browser sends, what the server answers,
 * and the views every part builds on. Written before the work was split so the server, the poster, the avatar pipeline and the pages
 * could be built side by side; change it only together with every caller.
 */

/** How the person says they look, used only to draw their figure from the type's template. */
export type Appearance = {
  presentation: "female" | "male" | "neutral";
  hair: "short" | "medium" | "long" | "curly" | "tied" | "bald";
  glasses: boolean;
  skin: "light" | "medium" | "deep";
  style: "casual" | "smart" | "sporty" | "artsy";
  /** Optional free words (≤40 characters): a hair colour, a hat. Never shown to anyone else. */
  note: string;
};

export const APPEARANCE_LABELS = {
  presentation: { female: "女生", male: "男生", neutral: "中性" },
  hair: { short: "短发", medium: "中长发", long: "长发", curly: "卷发", tied: "扎起来", bald: "光头" },
  skin: { light: "偏白", medium: "自然", deep: "偏深" },
  style: { casual: "休闲", smart: "干练", sporty: "运动", artsy: "文艺" }
} as const;

export const NOTE_MAX = 40;
export const NICKNAME_MAX = 12;

/** POST /api/results */
export type SubmitRequest = {
  /** Every one of the 32 statements answered 1–5. */
  answers: Record<string, number>;
  appearance: Appearance;
  email: string;
  /** 「把海报和结果发到我的邮箱」, ticked by default. */
  sendEmail: boolean;
  /** Signs the invitation (「XX 邀请你测测…」); "" shows 「你的朋友」. */
  nickname: string;
  /** Present when the person came through someone's invitation: the pair card is made at once. */
  inviteToken?: string;
  /** When the first statement was shown (ms since epoch): under 40 s for 32 statements is not a person. */
  startedAt: number;
  /** Honeypot: a field no person sees. Anything in it refuses the submission. */
  website: string;
};

export type SubmitResponse = { resultToken: string; inviteToken: string; pairToken?: string };

/** Every refusal the API gives, as `{ ok: false, code }` with an HTTP status. */
export type ApiErrorCode =
  | "QUIZ_INCOMPLETE" | "APPEARANCE_INVALID" | "EMAIL_INVALID" | "NICKNAME_INVALID" | "TOO_FAST" | "REJECTED"
  | "RATE_LIMITED" | "INVITE_NOT_FOUND" | "ALREADY_PAIRED" | "NOT_FOUND";

/** One axis as shown: both poles, the score 0–100 towards the right pole, light when ambiguous, and the rank. */
export type PublicAxis = {
  id: string; leftLetter: string; rightLetter: string; leftLabel: string; rightLabel: string; leftEn: string; rightEn: string;
  score: number; letter: string; ambiguous: boolean;
  rank: { pole: string; percent: number; estimated: boolean };
};

export type PartnerView = { code: string; name: string; relation: string; tip: string };

/** The part of a result anyone holding a link may see: never the email, the answers or the appearance. */
export type PublicType = {
  code: string; name: string; subtitle: string;
  group: { key: string; name: string; colour: string; tint: string };
  axes: PublicAxis[];
  lines: [string, string, string];
  loop: [string, string, string, string];
  best: PartnerView;
  hardest: PartnerView;
};

/** The figure: drawing, done, or the type's template when drawing is over budget or failed. */
export type AvatarStatus = { state: "queued" | "drawing" | "ready" | "template"; url: string };

/** GET /api/results/[resultToken] — the person's own result page. */
export type ResultView = {
  nickname: string;
  type: PublicType;
  avatar: AvatarStatus;
  /** Server-rendered PNGs (shown as <img> so a long press saves them in WeChat). */
  posterUrl: string;
  longUrl: string;
  /** The invitation link printed as the poster's QR code. */
  inviteUrl: string;
  sendEmail: boolean;
  pairs: Array<{ pairToken: string; nickname: string; code: string; name: string; relation: string }>;
  expiresAt: string;
};

/** GET /api/invites/[inviteToken] — what an invited person sees before taking the test. */
export type InviteView = { nickname: string; type: PublicType; avatar: AvatarStatus };

export type RelationView = { name: string; when: string; tips: [string, string] };

/** GET /api/pairs/[pairToken] — the two people's card. */
export type PairView = {
  a: { nickname: string; type: PublicType; avatar: AvatarStatus };
  b: { nickname: string; type: PublicType; avatar: AvatarStatus };
  primary: RelationView;
  secondary?: RelationView;
  /** Lines both types suit, possibly none. */
  sharedLines: string[];
  cardUrl: string;
};

/** Days a result (and every link to it) is kept unless deleted sooner. */
export const RESULT_RETENTION_DAYS = 90;
/** Pair cards listed on one person's result. */
export const PAIRS_SHOWN_MAX = 20;
/** Figures drawn per email address, ever. */
export const AVATARS_PER_EMAIL = 3;
