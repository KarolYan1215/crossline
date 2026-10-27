// i18n-exempt: test support (sample data)
import type { StoredResult } from "../store";

/** A stored result for the avatar tests: ROHG, an address and a nickname that must never reach the image model. */
export function storedResult(overrides: Partial<StoredResult> = {}): StoredResult {
  return {
    id: "res_0001",
    resultToken: "rt_secret_result_token_0001",
    inviteToken: "inv_public_token_0001",
    email: "someone@example.com",
    nickname: "小林同学",
    scores: { lines: 80, purpose: 30, collab: 20, build: 70 },
    code: "ROHG",
    aiDoes: [],
    appearance: { presentation: "female", hair: "long", glasses: true, skin: "medium", style: "artsy", note: "" },
    sendEmail: true,
    avatar: { state: "queued", file: "" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    ...overrides
  };
}
