import { describe, expect, test } from "vitest";
import { requireRole, type AccessContext } from "./access-context";

function ctx(role: AccessContext["role"]): AccessContext {
  return {
    principalId: "principal-1", workspaceId: "workspace-1", role,
    identity: { provider: "credential", issuer: "crossline", subject: "principal-1" },
    authMethod: "session", requestId: "req-1"
  };
}

describe("requireRole", () => {
  test("owner satisfies every minimum", () => {
    expect(requireRole(ctx("owner"), "viewer")).toBe(true);
    expect(requireRole(ctx("owner"), "member")).toBe(true);
    expect(requireRole(ctx("owner"), "owner")).toBe(true);
  });

  test("viewer does not satisfy member or owner", () => {
    expect(requireRole(ctx("viewer"), "viewer")).toBe(true);
    expect(requireRole(ctx("viewer"), "member")).toBe(false);
    expect(requireRole(ctx("viewer"), "owner")).toBe(false);
  });

  test("member satisfies viewer and member but not owner", () => {
    expect(requireRole(ctx("member"), "viewer")).toBe(true);
    expect(requireRole(ctx("member"), "member")).toBe(true);
    expect(requireRole(ctx("member"), "owner")).toBe(false);
  });

  test("an unrecognised role fails closed rather than passing", () => {
    const broken = ctx("owner");
    // @ts-expect-error deliberately forging a role outside the known union
    broken.role = "root";
    expect(requireRole(broken, "viewer")).toBe(false);
  });
});
