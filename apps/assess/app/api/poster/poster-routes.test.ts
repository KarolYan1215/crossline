import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StoredPair, StoredResult } from "../../../server/store";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const results = new Map<string, StoredResult>();
const pairs = new Map<string, StoredPair>();

vi.mock("../../../server/store", () => ({
  getResultByInvite: (token: string) => [...results.values()].find((result) => result.inviteToken === token),
  getResultById: (id: string) => results.get(id),
  getPairByToken: (token: string) => pairs.get(token),
  recordedScores: () => ({})
}));
vi.mock("../../../server/avatar", () => ({ avatarImagePath: (result: StoredResult) => `/figures/${result.id}.png` }));
vi.mock("../../../server/poster", () => ({
  renderTypePoster: vi.fn(async () => PNG),
  renderLongImage: vi.fn(async () => PNG),
  renderPairCard: vi.fn(async () => PNG)
}));

const poster = await import("../../../server/poster");
const { GET: posterGET } = await import("./[token]/[kind]/route");
const { GET: pairGET } = await import("./pair/[pairToken]/route");

const result = (id: string, scores: StoredResult["scores"], nickname: string, expiresAt = "2099-01-01T00:00:00Z"): StoredResult => ({
  id, resultToken: `result-${id}`, inviteToken: `invite-${id}`, email: `${id}@example.com`, nickname, scores, code: "", sendEmail: true,
  appearance: { presentation: "neutral", hair: "short", glasses: false, skin: "medium", style: "casual", note: "" },
  avatar: { state: "template", file: "" }, createdAt: "2026-10-14T00:00:00Z", expiresAt
});
const call = <P>(params: P) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.clearAllMocks();
  results.clear();
  pairs.clear();
  results.set("a", result("a", { scope: 20, basis: 20, output: 20, rhythm: 20 }, "小林"));
  results.set("b", result("b", { scope: 80, basis: 80, output: 80, rhythm: 80 }, "阿乔"));
  results.set("old", result("old", { scope: 80, basis: 80, output: 80, rhythm: 80 }, "过期", "2020-01-01T00:00:00Z"));
  pairs.set("pair-ab", { id: "p1", pairToken: "pair-ab", inviterId: "a", inviteeId: "b", createdAt: "2026-10-14T00:00:00Z" });
});

describe("GET /api/poster/[token]/[kind]", () => {
  test("an invitation token gives its poster and its long image as private, short-cached PNGs", async () => {
    for (const kind of ["type.png", "long.png"]) {
      const response = await posterGET(new Request("http://x/api"), call({ token: "invite-a", kind }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, max-age=300");
      expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    }
    const input = vi.mocked(poster.renderTypePoster).mock.calls[0]![0];
    expect(input.type.code).toBe("SEMP");
    expect(input.nickname).toBe("小林");
    expect(input.avatarPath).toBe("/figures/a.png");
    expect(input.inviteUrl).toMatch(/\/t\/invite-a$/);
  });

  test("an unknown token, a result token, an expired result or an unknown kind is 404", async () => {
    for (const [token, kind] of [["nope", "type.png"], ["result-a", "type.png"], ["invite-old", "type.png"], ["invite-a", "other.png"], ["invite-a", "constructor"]]) {
      const response = await posterGET(new Request("http://x/api"), call({ token: token!, kind: kind! }));
      expect(response.status, `${token} ${kind}`).toBe(404);
    }
    expect(poster.renderTypePoster).not.toHaveBeenCalled();
  });
});

describe("GET /api/poster/pair/[pairToken]", () => {
  test("a pair token gives the card, with the inviter's invitation as its QR code", async () => {
    const response = await pairGET(new Request("http://x/api"), call({ pairToken: "pair-ab" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const input = vi.mocked(poster.renderPairCard).mock.calls[0]![0];
    expect([input.a.type.code, input.b.type.code]).toEqual(["SEMP", "GIRA"]);
    expect(input.primary.name).toBe("镜像对手");
    expect(input.inviteUrl).toMatch(/\/t\/invite-a$/);
  });

  test("an unknown pair, or a pair whose other side is gone, is 404", async () => {
    pairs.set("pair-gone", { id: "p2", pairToken: "pair-gone", inviterId: "a", inviteeId: "deleted", createdAt: "2026-10-14T00:00:00Z" });
    for (const pairToken of ["nope", "pair-gone"]) {
      expect((await pairGET(new Request("http://x/api"), call({ pairToken }))).status).toBe(404);
    }
    expect(poster.renderPairCard).not.toHaveBeenCalled();
  });
});
