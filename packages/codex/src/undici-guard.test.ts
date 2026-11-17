import { AssertionError } from "node:assert";
import { spawnSync } from "node:child_process";
import { expect, test, vi } from "vitest";
import { isUndiciParserAssertion, undiciAssertionGuard } from "./undici-guard";

// The stack the hosted beta printed on 2026-11-15 (Node 22.23.4), first lines.
const undiciAssertion = (): Error => {
  const error = new AssertionError({ message: "false == true", actual: false, expected: true, operator: "==" });
  error.stack = [
    "AssertionError [ERR_ASSERTION]: false == true",
    "    at Parser.finish (node:internal/deps/undici/undici:6229:9)",
    "    at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:6510:16)",
    "    at TLSSocket.emit (node:events:531:35)"
  ].join("\n");
  return error;
};

test("only an assertion thrown by undici's own code is recognised", () => {
  expect(isUndiciParserAssertion(undiciAssertion())).toBe(true);
  const installed = undiciAssertion();
  installed.stack = installed.stack!.replace("node:internal/deps/undici/undici", "/repo/node_modules/undici/lib/dispatcher/client-h1.js");
  expect(isUndiciParserAssertion(installed)).toBe(true);
  // Our own assertion that merely passes through undici further down the stack is not undici's.
  const ours = undiciAssertion();
  ours.stack = ours.stack!.replace("    at Parser.finish", "    at check (/repo/apps/worker/src/index.ts:10:3)\n    at Parser.finish");
  expect(isUndiciParserAssertion(ours)).toBe(false);
  // Anything that is not an assertion, even from undici.
  const other = new TypeError("fetch failed");
  other.stack = "TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13";
  expect(isUndiciParserAssertion(other)).toBe(false);
  expect(isUndiciParserAssertion("ERR_ASSERTION")).toBe(false);
});

test("the guard logs undici's assertion and keeps the process; anything else is printed and exits 1", () => {
  const log = vi.fn(), exit = vi.fn(), print = vi.fn();
  const guard = undiciAssertionGuard({ log, exit, print });
  guard(undiciAssertion());
  expect(exit).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: "undici.assertion_survived", message: "false == true",
    stack: expect.stringContaining("Parser.finish") }));
  const real = new Error("a real bug");
  guard(real);
  expect(print).toHaveBeenCalledWith(real);
  expect(exit).toHaveBeenCalledWith(1);
});

test("in a real process the assertion from a socket event does not end it, and another error still does", () => {
  const script = (thrown: string) => `
    const { installUndiciAssertionGuard } = await import(${JSON.stringify(new URL("./undici-guard.ts", import.meta.url).href)});
    const { AssertionError } = await import("node:assert");
    installUndiciAssertionGuard((event) => console.log(JSON.stringify(event)));
    setTimeout(() => { ${thrown} }, 0);
    setTimeout(() => { console.log("still up"); }, 50);
  `;
  const run = (thrown: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script(thrown)], { encoding: "utf8", timeout: 30_000 });
  const survived = run(`const e = new AssertionError({ message: "false == true" });
    e.stack = "AssertionError [ERR_ASSERTION]: false == true\\n    at Parser.finish (node:internal/deps/undici/undici:6229:9)"; throw e;`);
  expect(survived.status).toBe(0);
  expect(survived.stdout).toContain("undici.assertion_survived");
  expect(survived.stdout).toContain("still up");
  const died = run(`throw new Error("a real bug");`);
  expect(died.status).toBe(1);
  expect(died.stdout).not.toContain("still up");
  expect(died.stderr).toContain("a real bug");
}, 60_000);
