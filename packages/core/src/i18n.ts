/**
 * The interface language lives in `@crossline/i18n` (docs/i18n.md); core re-exports it so code that only depends on core — and the
 * text core builds — reads the same `tFor` and `Locale` as the apps.
 */
export * from "@crossline/i18n";
