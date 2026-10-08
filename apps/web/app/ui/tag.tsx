import type { ReactNode } from "react";

/**
 * A label that is visibly a label: kinds, risk, state, the line something belongs to. It replaces the 「（影响里程碑）」-style
 * parentheses that sat inside running text and read as part of the sentence.
 */
export type TagTone = "neutral" | "info" | "warn" | "risk" | "ok";

export function Tag({ tone = "neutral", title, children }: { tone?: TagTone; title?: string; children: ReactNode }) {
  return <span className="ui-tag" data-tone={tone} title={title}>{children}</span>;
}

/** The line's own colour. `line` is an identity id (research, startup, …). */
export function LineTag({ line, title, children }: { line: string | undefined; title?: string; children: ReactNode }) {
  return <span className="ui-tag ui-line-tag" data-line={line ?? "none"} title={title}>{children}</span>;
}

/** 「→ 支持 自媒体·首轮发布」: work here that another line reuses, in that other line's colour. */
export function SupportsTag({ line, lineLabel, target, artifact }: { line: string; lineLabel: string; target: string; artifact?: string }) {
  return <span className="ui-tag ui-supports" data-line={line} title={artifact ? `复用产出：${artifact}` : undefined}>
    → 支持 {lineLabel}·{target}
  </span>;
}
