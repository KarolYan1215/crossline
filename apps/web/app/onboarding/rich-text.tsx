import { Fragment, type ReactNode } from "react";

/**
 * A translated sentence with one link in it (docs/i18n.md: one key per sentence). The sentence is written with the link's words between
 * `<a>` and `</a>` — 「可在 <a>计划页</a> 预览后采用。」 / "preview them on the <a>Plan page</a>." — and `render` draws the link around
 * them, so each language keeps its own word order.
 */
export function withLink(text: string, render: (inner: string) => ReactNode): ReactNode {
  const match = /^([\s\S]*?)<a>([\s\S]*?)<\/a>([\s\S]*)$/.exec(text);
  if (!match) return text;
  return <>{match[1]}<Fragment>{render(match[2]!)}</Fragment>{match[3]}</>;
}
