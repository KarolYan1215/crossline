import type { ApiErrorCode, InviteView, PairView, ResultView, SubmitRequest, SubmitResponse } from "./contract";
import { fixtureApi } from "./fixtures";

/**
 * The pages' only way to the server. Every call answers `{ ok: true, data }` or `{ ok: false, code }`; a network failure is `NETWORK`
 * and an answer that is not the API's own shape is `UNKNOWN`, so a page never has to catch. With `NEXT_PUBLIC_ASSESS_FIXTURES=1` the
 * calls answer from lib/fixtures.ts, so the pages can be built and previewed without the server.
 */
export type ClientErrorCode = ApiErrorCode | "NETWORK" | "UNKNOWN";
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: ClientErrorCode };

export type AssessApi = {
  submitResult(request: SubmitRequest): Promise<ApiResult<SubmitResponse>>;
  getResult(resultToken: string): Promise<ApiResult<ResultView>>;
  deleteResult(resultToken: string): Promise<ApiResult<null>>;
  requestBeta(resultToken: string): Promise<ApiResult<null>>;
  getInvite(inviteToken: string): Promise<ApiResult<InviteView>>;
  getPair(pairToken: string): Promise<ApiResult<PairView>>;
};

const KNOWN: ApiErrorCode[] = ["QUIZ_INCOMPLETE", "APPEARANCE_INVALID", "EMAIL_INVALID", "NICKNAME_INVALID", "TOO_FAST", "REJECTED",
  "RATE_LIMITED", "INVITE_NOT_FOUND", "ALREADY_PAIRED", "NOT_FOUND", "UNAUTHORIZED", "EMAIL_LIMIT_REACHED"];

/** A response read into the result shape: a refusal's code when the body names one, `NOT_FOUND` for a bare 404. */
export async function readResponse<T>(response: Response): Promise<ApiResult<T>> {
  let body: unknown = null;
  if (response.status !== 204) {
    try { body = await response.json(); } catch { body = null; }
  }
  const refusal = body && typeof body === "object" && (body as { ok?: unknown }).ok === false ? (body as { code?: unknown }).code : undefined;
  if (refusal !== undefined || !response.ok) {
    if (typeof refusal === "string" && (KNOWN as string[]).includes(refusal)) return { ok: false, code: refusal as ApiErrorCode };
    return { ok: false, code: response.status === 404 ? "NOT_FOUND" : "UNKNOWN" };
  }
  return { ok: true, data: body as T };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init, headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) } });
  } catch {
    return { ok: false, code: "NETWORK" };
  }
  return readResponse<T>(response);
}

const token = (value: string) => encodeURIComponent(value);

export const httpApi: AssessApi = {
  submitResult: (request) => call<SubmitResponse>("/api/results", { method: "POST", body: JSON.stringify(request) }),
  getResult: (resultToken) => call<ResultView>(`/api/results/${token(resultToken)}`),
  deleteResult: async (resultToken) => {
    const result = await call<unknown>(`/api/results/${token(resultToken)}`, { method: "DELETE" });
    return result.ok ? { ok: true, data: null } : result;
  },
  requestBeta: async (resultToken) => {
    const result = await call<unknown>(`/api/results/${token(resultToken)}/beta`, { method: "POST" });
    return result.ok ? { ok: true, data: null } : result;
  },
  getInvite: (inviteToken) => call<InviteView>(`/api/invites/${token(inviteToken)}`),
  getPair: (pairToken) => call<PairView>(`/api/pairs/${token(pairToken)}`)
};

export const usingFixtures = (): boolean => process.env.NEXT_PUBLIC_ASSESS_FIXTURES === "1";

export const api: AssessApi = usingFixtures() ? fixtureApi : httpApi;
