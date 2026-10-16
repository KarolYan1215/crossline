import { asLocale, isLocale, LOCALE_SETTING, type Locale } from "@crossline/core";
import type { CrosslineStore } from "./index";

/** The workspace's language (docs/i18n.md): what the worker writes notifications and asks models in, and what other devices adopt. */
export function readLocale(store: CrosslineStore, workspaceId: string): Locale {
  return asLocale(store.getSetting(workspaceId, LOCALE_SETTING));
}

/** Whether the person has chosen a language at all: a device without the cookie adopts it only then. */
export function chosenLocale(store: CrosslineStore, workspaceId: string): Locale | undefined {
  const value = store.getSetting(workspaceId, LOCALE_SETTING);
  return isLocale(value) ? value : undefined;
}

export function writeLocale(store: CrosslineStore, workspaceId: string, locale: Locale): void {
  if (store.getSetting(workspaceId, LOCALE_SETTING) !== locale) store.setSetting(workspaceId, LOCALE_SETTING, locale);
}

/**
 * The interview keeps the language it started in until it ends (docs/i18n.md, decided 2026-10-16): switching the interface mid-way
 * would otherwise turn a conversation, its stored facts and the portrait into a mix of two languages. Locked per session on its first
 * turn; the main interview's (not a line's own) is also kept as `onboarding.locale`, which the portrait report follows.
 */
export const INTERVIEW_LOCALE_SETTING = "onboarding.locale";

export function lockInterviewLocale(store: CrosslineStore, workspaceId: string, sessionId: string): Locale {
  const key = `${INTERVIEW_LOCALE_SETTING}:${sessionId}`;
  const locked = store.getSetting(workspaceId, key);
  if (isLocale(locked)) return locked;
  const locale = readLocale(store, workspaceId);
  store.setSetting(workspaceId, key, locale);
  if (!sessionId.startsWith("line-") && !isLocale(store.getSetting(workspaceId, INTERVIEW_LOCALE_SETTING))) {
    store.setSetting(workspaceId, INTERVIEW_LOCALE_SETTING, locale);
  }
  return locale;
}

/** The main interview's language, once it has started; undefined before, when everything follows the workspace's language. */
export function interviewLocale(store: CrosslineStore, workspaceId: string): Locale | undefined {
  const value = store.getSetting(workspaceId, INTERVIEW_LOCALE_SETTING);
  return isLocale(value) ? value : undefined;
}

/**
 * The language a signed-up account chose, by its Better Auth user id (mail to that account is written in it). Read only: an account
 * with no principal or workspace yet has none.
 */
export function accountLocale(store: CrosslineStore, betterAuthUserId: string): Locale | undefined {
  const principal = store.getPrincipalByBetterAuthId(betterAuthUserId);
  if (!principal) return undefined;
  const workspace = store.listWorkspaces().find((item) => store.getWorkspaceOwnerId(item.id) === principal.id);
  return workspace ? chosenLocale(store, workspace.id) : undefined;
}
