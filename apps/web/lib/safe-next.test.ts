import { expect, test } from "vitest";
import { loginFor, safeNext } from "./safe-next";

test("only a path on this site is followed after signing in", () => {
  expect(safeNext("/onboarding?x=1")).toBe("/onboarding?x=1");
  for (const bad of ["//evil.example", String.raw`/\evil.example`, "https://evil.example", "javascript:alert(1)", "/login?next=/x", "/signup", undefined, ""]) expect(safeNext(bad)).toBe("/connect");
  expect(loginFor("/workbench/abc")).toBe("/login?next=%2Fworkbench%2Fabc");
  expect(loginFor("/")).toBe("/login");
  expect(loginFor(null)).toBe("/login");
});
