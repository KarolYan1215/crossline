/**
 * Keeps a long-running process up through one known undici defect, and nothing else (2026-11-15).
 *
 * A persona replay on the hosted beta (Node 22.23.4) died at round 10 when the sponsor provider closed a TLS stream mid-response:
 * undici threw `AssertionError [ERR_ASSERTION]: false == true at Parser.finish (node:internal/deps/undici/undici:6229:9)` from the
 * socket's `end` event. That is outside every request's promise, so no `try` around a fetch can catch it: it is an uncaughtException
 * and Node exits. The worker reaches the same providers through the same `fetch` (the model gateway), so one provider hanging up at
 * the wrong moment took down every account's model runs at once (the Codex runtimes are the worker's children).
 *
 * Only an assertion thrown by undici's own code is survived: `code === "ERR_ASSERTION"` and the first stack frame inside undici
 * (bundled `node:internal/deps/undici` or an installed `undici` package). The request it belonged to is left to its own abort: the
 * gateway aborts the upstream fetch when Codex hangs up, and Codex hangs up on an idle stream. Anything else is printed as Node
 * prints it and still ends the process with code 1, so a real bug is never swallowed. The web needs none of this: Next's router
 * server already registers an `uncaughtException` listener that only logs.
 */
export type UncaughtError = Error & { code?: string };

/** True only for an assertion thrown from inside undici itself. */
export function isUndiciParserAssertion(error: unknown): boolean {
  if (!(error instanceof Error) || (error as UncaughtError).code !== "ERR_ASSERTION") return false;
  const frame = (error.stack ?? "").split("\n").find((line) => /^\s+at /u.test(line));
  return Boolean(frame && /deps[\\/]undici|[\\/]undici[\\/]/u.test(frame));
}

/**
 * The `uncaughtException` listener. `exit` and `print` are injectable so the decision can be tested without ending the test run.
 */
export function undiciAssertionGuard(options: {
  log: (event: Record<string, unknown>) => void;
  exit?: (code: number) => void;
  print?: (error: unknown) => void;
}): (error: unknown) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const print = options.print ?? ((error: unknown) => console.error(error));
  return (error) => {
    if (isUndiciParserAssertion(error)) {
      const stack = (error as Error).stack ?? "";
      options.log({ type: "undici.assertion_survived", message: (error as Error).message,
        stack: stack.split("\n").slice(0, 4).map((line) => line.trim()).join(" | "), at: new Date().toISOString() });
      return;
    }
    // A listener replaces Node's own handling, so do what Node would have done: print the error and exit 1.
    print(error);
    exit(1);
  };
}

/** Installs the guard on this process. Call once, early, in a process meant to stay up. */
export function installUndiciAssertionGuard(log: (event: Record<string, unknown>) => void = (event) => console.error(JSON.stringify(event))): void {
  process.on("uncaughtException", undiciAssertionGuard({ log }));
}
