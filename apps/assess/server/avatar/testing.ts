import type { StoredResult } from "../store";

/** A stored result for the avatar tests: DLWV, an address and a nickname that must never reach the image model. */
export function storedResult(overrides: Partial<StoredResult> = {}): StoredResult {
  return {
    id: "res_0001",
    resultToken: "rt_secret_result_token_0001",
    inviteToken: "inv_public_token_0001",
    email: "someone@example.com",
    nickname: "小林同学",
    scores: { concentration: 80, orientation: 30, boundary: 20, pacing: 70 },
    code: "DLWV",
    appearance: { presentation: "female", hair: "long", glasses: true, skin: "medium", style: "artsy", note: "" },
    sendEmail: true,
    avatar: { state: "queued", file: "" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    ...overrides
  };
}
