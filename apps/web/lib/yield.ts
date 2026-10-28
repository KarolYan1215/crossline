/**
 * Lets the requests that arrived meanwhile be answered before the next piece of background work (2026-10-28). The web's own background
 * passes (the ten-minute attention snapshot, the two-minute nudges, the calendar publish) walk every workspace, and every step of them is
 * synchronous SQLite and derivation: `await` on a promise that is already settled continues as a microtask, which never lets the event
 * loop take a request. So a pass over all accounts ran as one block — 1.5 s for one account on a fast machine, and on the hosted beta the
 * whole site (even `/api/health`, which never waits in the page line) stopped answering for 9–14 s three times in ten minutes. A
 * `setImmediate` between steps turns that one block into one per account and step.
 */
export const yieldToRequests = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
