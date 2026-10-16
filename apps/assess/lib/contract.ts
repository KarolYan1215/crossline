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
  /** Clothing style (eleven since 2026-10-16); the first four keys are the original ones, kept so stored results still read. */
  style: "casual" | "smart" | "sporty" | "artsy" | "minimal" | "preppy" | "street" | "techwear" | "chinese" | "sweet" | "cool";
  /** Optional free words (≤40 characters): a hair colour, a hat. Never shown to anyone else. */
  note: string;
};

export const APPEARANCE_LABELS = {
  presentation: { female: "女生", male: "男生", neutral: "中性" },
  hair: { short: "短发", medium: "中长发", long: "长发", curly: "卷发", tied: "扎起来", bald: "光头" },
  skin: { light: "偏白", medium: "自然", deep: "偏深" },
  style: {
    casual: "休闲日常", minimal: "极简通勤", smart: "商务正装", preppy: "学院风", street: "街头潮流", sporty: "运动户外",
    techwear: "机能风", artsy: "文艺复古", chinese: "新中式", sweet: "甜美", cool: "酷飒"
  }
} as const;

export const NOTE_MAX = 40;
export const NICKNAME_MAX = 12;

/** POST /api/results */
export type SubmitRequest = {
  /** Every one of the 32 statements answered 1–5. */
  answers: Record<string, number>;
  appearance: Appearance;
  email: string;
  /** 「把结果链接发到我的邮箱」, ticked by default. */
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

/**
 * POST /api/results/[resultToken]/wants — what the person wants to do, asked right after the email (so their figure is drawn while
 * they answer): chips from `WANT_OPTIONS` and an optional free line of at most `WANTS_TEXT_MAX` characters.
 */
export type WantsRequest = { picks: string[]; text: string };

export type SubmitResponse ={ resultToken: string; inviteToken: string; pairToken?: string };

/** Every refusal the API gives, as `{ ok: false, code }` with an HTTP status. */
export type ApiErrorCode =
  | "QUIZ_INCOMPLETE" | "APPEARANCE_INVALID" | "EMAIL_INVALID" | "NICKNAME_INVALID" | "TOO_FAST" | "REJECTED"
  | "RATE_LIMITED" | "INVITE_NOT_FOUND" | "ALREADY_PAIRED" | "NOT_FOUND" | "UNAUTHORIZED" | "EMAIL_LIMIT_REACHED"
  | "WANTS_INVALID" | "WANTS_LIMIT_REACHED";

/** One axis as shown: both poles, the score 0–100 towards the right pole, light when ambiguous, and the rank. */
export type PublicAxis = {
  id: string; leftLetter: string; rightLetter: string; leftLabel: string; rightLabel: string; leftEn: string; rightEn: string;
  score: number; letter: string; ambiguous: boolean;
  rank: { pole: string; percent: number; estimated: boolean };
};

/** A recommended line, 「<domain>的<identity>」: the identity large on the poster, the field small; a licensed profession has no field. */
export type LineView = { domain: string; identity: string };

export type PartnerView = { code: string; name: string; relation: string; tip: string };

/** The part of a result anyone holding a link may see: never the email, the answers or the appearance. */
export type PublicType = {
  code: string; name: string; subtitle: string;
  group: { key: string; name: string; colour: string; tint: string };
  axes: PublicAxis[];
  /** The first combination, offered as 「你也许想做」, with `loop`. */
  lines: [LineView, LineView, LineView];
  /** Three more combinations, shown smaller and without a loop; none once the lines come from what the person said they want. */
  more: Array<[LineView, LineView, LineView]>;
  loop: [string, string, string, string];
  /**
   * Where the lines came from: the type's own suggestion (`type`, before the person said what they want), or — from what they said —
   * the owner's written combination that fits (`preset`), a text model's answer (`model`) or the rules (`rules`).
   */
  linesFrom: "type" | "preset" | "model" | "rules";
  /** How each line feeds the next (0→1, 1→2, 2→0) with the relation kind (促成/复用/提供输入/约束/反馈回路); empty for `type`. */
  links: Array<{ from: number; to: number; kind: string; how: string }>;
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
  /** Whether this server can send mail at all (SMTP configured); without it the page tells the person to keep the link themselves. */
  mailOn: boolean;
  /** Whether the person has asked to be invited to the full Crossline app (「申请内测」). */
  betaRequested: boolean;
  /** The full app's public address when it is open to sign up (`ASSESS_APP_URL`), else null and the page offers 「申请内测」. */
  appUrl: string | null;
  pairs: Array<{ pairToken: string; nickname: string; code: string; name: string; relation: string }>;
  /** What the person said they want to do (their own view only), or null before they answer; and how many more times they may change it. */
  wants: WantsRequest | null;
  wantsLeft: number;
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
  /** Identities both types' lines share (「创业者」), possibly none. */
  sharedLines: string[];
  cardUrl: string;
};

/** Days a result (and every link to it) is kept unless deleted sooner. */
export const RESULT_RETENTION_DAYS = 90;
/** Pair cards listed on one person's result. */
export const PAIRS_SHOWN_MAX = 20;
/** Tests one address may take within the retention period; each new one replaces the last (decided 2026-10-15). */
export const TESTS_PER_EMAIL = 3;
/** Figures drawn per email address, ever. */
export const AVATARS_PER_EMAIL = 3;
