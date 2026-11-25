import { expect, it } from "vitest";
import { SECOND_FACTOR, loginFor, loginHostOf, loginProblem, readLoginVault, redactLogin } from "./login-vault";

const aliases = (host: string) => host === "lu.ma" ? ["luma.com"] : host === "luma.com" ? ["lu.ma"] : [];
const entries = [{ host: "lu.ma", savedAt: "2026-11-25T00:00:00Z" }, { host: "example.com", savedAt: "2026-11-25T00:00:00Z" }];

it("keys a login by its bare host, from a host or a pasted address", () => {
  expect(loginHostOf("https://www.Example.com/login?x=1")).toBe("example.com");
  expect(loginHostOf("lu.ma")).toBe("lu.ma");
  for (const bad of ["", "localhost", "javascript:alert(1)", "exa mple.com", "http://", "a_b.com"]) expect(loginHostOf(bad)).toBeUndefined();
});

it("refuses a login without a valid host, a username or a password", () => {
  expect(loginProblem({ host: "example.com", username: "kai", password: "pw" })).toBeUndefined();
  expect(loginProblem({ host: "nope", username: "kai", password: "pw" })).toBe("LOGIN_HOST_INVALID");
  expect(loginProblem({ host: "example.com", username: " ", password: "pw" })).toBe("LOGIN_USERNAME_INVALID");
  expect(loginProblem({ host: "example.com", username: "kai", password: "" })).toBe("LOGIN_PASSWORD_INVALID");
});

it("reads only host and date from the ledger's record, dropping anything else", () => {
  const read = readLoginVault(JSON.stringify([{ host: "example.com", savedAt: "x", password: "leak" }, { host: "bad host", savedAt: "x" }, null]));
  expect(read).toEqual([{ host: "example.com", savedAt: "x" }]);
  expect(readLoginVault("not json")).toEqual([]);
});

it("offers a saved login only over https, on the exact host or a known alias, never a subdomain or another site", () => {
  expect(loginFor(entries, "https://example.com/login", aliases)?.host).toBe("example.com");
  expect(loginFor(entries, "https://www.example.com/login", aliases)?.host).toBe("example.com");
  expect(loginFor(entries, "https://luma.com/signin", aliases)?.host).toBe("lu.ma");
  expect(loginFor(entries, "http://example.com/login", aliases)).toBeUndefined();
  expect(loginFor(entries, "https://accounts.example.com/login", aliases)).toBeUndefined();
  expect(loginFor(entries, "https://example.com.evil.io/login", aliases)).toBeUndefined();
  expect(loginFor(entries, "https://evil.io/?next=https://example.com", aliases)).toBeUndefined();
});

it("knows a second factor or a code when a field asks for one", () => {
  for (const label of ["One-time code", "Verification code", "Enter the 6-digit code from your authenticator", "短信验证码", "两步验证"]) expect(SECOND_FACTOR.test(label)).toBe(true);
  for (const label of ["Email", "Password", "Username"]) expect(SECOND_FACTOR.test(label)).toBe(false);
});

it("replaces a saved login's username and password in text a model or the ledger sees", () => {
  const text = "- textbox \"Email\": kai@example.edu\n- textbox \"Password\": hunter22";
  const out = redactLogin(text, { username: "kai@example.edu", password: "hunter22" });
  expect(out).not.toContain("kai@example.edu");
  expect(out).not.toContain("hunter22");
  expect(out).toContain("{{login.password}}");
  expect(redactLogin(text, undefined)).toBe(text);
});
