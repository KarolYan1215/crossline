"use client";
// A client component so the words it adds itself follow the page's language (docs/i18n.md); servers pass it plain props and children.
import type { ReactNode } from "react";
import { useT } from "../locale-context";

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
/** A task's cross-line artifact: 「产出供 自媒体 · …」 or 「使用 研究 · … 的产出」, in the other line's colour. */
export function ArtifactTag({ direction, line, lineLabel, title, artifact }: { direction: "produces" | "uses"; line: string; lineLabel: string; title: string; artifact: string }) {
  const t = useT();
  return <span className="ui-tag ui-supports" data-line={line} title={t("产物：{{artifact}}", { artifact })}>
    {direction === "produces" ? t("产出供 {{line}} · {{title}}", { line: lineLabel, title }) : t("使用 {{line}} · {{title}} 的产出", { line: lineLabel, title })}
  </span>;
}

export function SupportsTag({ line, lineLabel, target, artifact }: { line: string; lineLabel: string; target: string; artifact?: string }) {
  const t = useT();
  return <span className="ui-tag ui-supports" data-line={line} title={artifact ? t("复用产出：{{artifact}}", { artifact }) : undefined}>
    {t("→ 支持 {{line}}·{{target}}", { line: lineLabel, target })}
  </span>;
}
