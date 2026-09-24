/**
 * Reads `auth.db`'s row counts back through a fresh connection — the restore drill's actual assertion.
 * A separate small script rather than an inline `node -e` from PowerShell: quoting a `require(...)` call
 * through PowerShell's own string escaping into a native command's argument list is exactly the kind of
 * thing that silently mangles (a literal case of it lost the quotes around the module specifier and
 * printed `ReferenceError: better is not defined`), and a file on disk has no such translation to survive.
 *
 *   pnpm exec tsx scripts/read-auth-db-counts.ts <auth.db path>
 */
import Database from "better-sqlite3";

const path = process.argv[2];
if (!path) {
  console.error(JSON.stringify({ status: "blocked", code: "PATH_REQUIRED",
    message: "用法: tsx scripts/read-auth-db-counts.ts <auth.db path>" }));
  process.exit(1);
}
const db = new Database(path, { readonly: true });
const counts = Object.fromEntries(["user", "session", "account", "verification"].map((table) =>
  [table, (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
db.close();
console.log(JSON.stringify(counts));
