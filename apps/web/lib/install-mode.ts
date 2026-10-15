/**
 * An installed copy (docs/local-installer.md): the launcher starts the app with `CROSSLINE_INSTALL_MODE=local`. Kept apart from
 * `local-install.ts`, which reaches Codex through `@crossline/auth`, so the layout and pages that only ask the question stay light.
 */
export function isLocalInstall(): boolean {
  return process.env.CROSSLINE_INSTALL_MODE === "local";
}
