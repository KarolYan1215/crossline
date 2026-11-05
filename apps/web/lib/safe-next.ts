/** Where to go after signing in or verifying: only a path on this site, never another origin (`//evil`, `/\evil`, `https:`). */
export function safeNext(next: string | null | undefined, fallback = "/connect"): string {
  return next && /^\/(?!\/)[\w\-/?=&.%~#]*$/.test(next) && !next.startsWith("/login") && !next.startsWith("/signup") ? next : fallback;
}

/** The sign-in page for someone who was on `path`, so signing in (or up) brings them back there. */
export const loginFor = (path: string | null | undefined): string => {
  const next = safeNext(path, "");
  return next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
};
