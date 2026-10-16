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
