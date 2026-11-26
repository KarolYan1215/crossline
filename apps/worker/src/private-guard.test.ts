import { afterEach, beforeEach, expect, test } from "vitest";
import { privateLeak } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { nameRomanizations, privateGuardFor } from "./private-guard";

/** The person's name in pinyin is an identifier too (harness-1125.md §17); one syllable or the given name alone is not. Names are fictional. */
let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  store.upsertProfileFact({ workspaceId, identityId: "person", projectId: "", slot: "full_name", value: "曾晓舟", status: "confirmed",
    sourceRef: "interview", sourceQuote: "", updatedAt: "2026-11-01T00:00:00Z" });
});
afterEach(() => store.close());

test("a Chinese name is romanized surname first and last, the surname read as a surname, ü in its three spellings", () => {
  expect(nameRomanizations("曾晓舟")).toEqual(expect.arrayContaining(["zeng xiao zhou", "xiao zhou zeng"]));
  expect(nameRomanizations("单田芳")).toContain("shan tian fang");
  expect(nameRomanizations("欧阳修")).toEqual(expect.arrayContaining(["ou yang xiu", "xiu ou yang"]));
  expect(nameRomanizations("吕思")).toEqual(expect.arrayContaining(["lv si", "lu si", "lyu si", "si lv"]));
  expect(nameRomanizations("Ann Lee")).toEqual([]);
  expect(nameRomanizations("林")).toEqual([]);
});

test("a query with the name in pinyin is refused however it is spaced; a syllable or the given name alone is not", async () => {
  const guard = await privateGuardFor(store, undefined, workspaceId);
  for (const query of ["Zeng Xiaozhou PhD", "xiaozhou zeng publications", "zengxiaozhou github", "Xiao-Zhou Zeng"]) expect(privateLeak(query, guard)).toBe("identifier");
  for (const query of ["Zeng et al. 2024 in-memory computing", "Xiaozhou city guide", "zhou xiao zeng"]) expect(privateLeak(query, guard)).toBeUndefined();
});
