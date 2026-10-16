import { tFor, type Locale, type Translate } from "@crossline/core";
import { readLocale, type CrosslineStore } from "@crossline/db";

/**
 * The worker's language is the workspace's (docs/i18n.md): everything it writes for the person — notifications, messages in the
 * conversation, asks and blockers the web shows, push payloads — is written in `ui.locale` at the moment it is written.
 */
export const localeOf = (store: CrosslineStore, workspaceId: string): Locale => {
  try { return readLocale(store, workspaceId); } catch { return "zh"; }
};

/** The translator for a workspace: `const t = tOfWorkspace(store, workspaceId); t("知道了")`. */
export const tOfWorkspace = (store: CrosslineStore, workspaceId: string): Translate => tFor(localeOf(store, workspaceId));
