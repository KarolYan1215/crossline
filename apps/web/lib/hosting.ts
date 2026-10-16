/**
 * The hosted beta (docs/beta-launch.md §10.6, `CROSSLINE_PUBLIC_BETA=1`): one server that many people sign in to over the web. What
 * reads "this computer" (folders, screen, idle stretches, coding-agent logs, the shell assistant) is off for every account there, and
 * cards about a private network or a phone reaching the owner's machine do not apply.
 */
export function isHostedBeta(): boolean {
  return process.env.CROSSLINE_PUBLIC_BETA === "1";
}

/** Microsoft Graph read and write are set up on this install (the worker reads the same variable). */
export function graphConfigured(): boolean {
  return Boolean(process.env.CROSSLINE_MS_CLIENT_ID?.trim());
}
