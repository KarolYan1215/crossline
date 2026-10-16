import path from "node:path";

/**
 * Where the public quick test keeps its own data — a SQLite file and the drawn figures, never the private app's ledger — and the
 * address its links point at. `ASSESS_DATA_DIR` defaults to `apps/assess/data` (ignored by git); `ASSESS_BASE_URL` is the public
 * origin (`https://…`), `http://127.0.0.1:3340` in development.
 */
export const dataDir = (): string => process.env.ASSESS_DATA_DIR ?? path.join(process.cwd(), "data");
/** The full app's sign-in address for the hosted beta (`https://app.…`), or null while it is invitation-only. */
export const appUrl = (): string | null => process.env.ASSESS_APP_URL?.trim().replace(/\/+$/, "") || null;
export const baseUrl = (): string => (process.env.ASSESS_BASE_URL ?? "http://127.0.0.1:3340").replace(/\/+$/, "");
