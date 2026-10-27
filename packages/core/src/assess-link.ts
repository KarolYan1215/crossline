import type { TypeAxisId } from "./portrait-type";

/**
 * The link between the public quick test and the Crossline app (decided 2026-10-15): someone who joins the beta finds this quick test's
 * result carried into the app. The app asks the test's server, server to server, for the latest live result held under the address the
 * person signed in with:
 *
 *   POST <test origin>/api/link
 *   Authorization: Bearer <ASSESS_LINK_SECRET>     (the same secret configured on both servers)
 *   { "email": "<the person's verified address>" }
 *
 * and gets an `AssessLinkResponse`. Only the type and the four scores cross: never the appearance, the nickname, the answers or anything
 * about anyone else. The app must ask only with an address the person has proven is theirs, since the answer (and `resultUrl`, which
 * opens and can delete the result) is the person's own. A deleted or expired result is `{ found: false }` for good.
 */

export const ASSESS_LINK_PATH = "/api/link";

export type AssessLinkAxes = Record<TypeAxisId, number>;

export type AssessLinkResponse =
  | { found: false }
  | {
    found: true;
    /** Four letters, e.g. "WOHA" (a coordinate, never shown beside the name). */
    code: string;
    /** The type's name, e.g. "某神秘光头". */
    typeName: string;
    /** The type group's key ("RO" | "RU" | "WO" | "WU"); its name and colours are `TYPE_GROUPS[group]`. */
    group: string;
    /** Each dimension 0–100 towards its right pole (collab → 共生, purpose → 精进, build → 拼装, lines → 多星). */
    axes: AssessLinkAxes;
    /** When the test was finished, ISO 8601. */
    takenAt: string;
    /** The person's own result page (it can also delete the result); absent when the test's server does not know its public address. */
    resultUrl?: string;
    /** The person's figure, 360 wide (`/api/avatar/<invitation token>.png?size=small`), absolute; absent like `resultUrl`. */
    figureUrl?: string;
  };

const AXES: TypeAxisId[] = ["collab", "purpose", "build", "lines"];
const CODE = /^[RW][OU][BH][AG]$/;
const GROUPS = ["RO", "RU", "WO", "WU"];

/** The answer read back and checked field by field; anything malformed, extra or out of range is null rather than half-trusted. */
export function parseAssessLinkResponse(raw: unknown): AssessLinkResponse | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.found === false) return Object.keys(value).length === 1 ? { found: false } : null;
  if (value.found !== true) return null;
  const allowed = ["found", "code", "typeName", "group", "axes", "takenAt", "resultUrl", "figureUrl"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  const { code, typeName, group, axes, takenAt, resultUrl, figureUrl } = value;
  if (typeof code !== "string" || !CODE.test(code)) return null;
  if (typeof typeName !== "string" || !typeName.trim() || typeName.length > 20) return null;
  if (typeof group !== "string" || !GROUPS.includes(group) || group !== code.slice(0, 2)) return null;
  if (!axes || typeof axes !== "object" || Array.isArray(axes)) return null;
  const scores = axes as Record<string, unknown>;
  if (Object.keys(scores).length !== AXES.length) return null;
  if (!AXES.every((axis) => Number.isInteger(scores[axis]) && (scores[axis] as number) >= 0 && (scores[axis] as number) <= 100)) return null;
  if (typeof takenAt !== "string" || Number.isNaN(Date.parse(takenAt))) return null;
  const url = (link: unknown) => link === undefined || (typeof link === "string" && /^https?:\/\/[^\s]+$/.test(link));
  if (!url(resultUrl) || !url(figureUrl)) return null;
  return {
    found: true, code, typeName, group, axes: Object.fromEntries(AXES.map((axis) => [axis, scores[axis] as number])) as AssessLinkAxes, takenAt,
    ...(resultUrl !== undefined ? { resultUrl: resultUrl as string } : {}),
    ...(figureUrl !== undefined ? { figureUrl: figureUrl as string } : {})
  };
}
