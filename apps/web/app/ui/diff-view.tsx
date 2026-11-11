"use client";

import type { DiffLine } from "@crossline/core";
import { useT } from "../locale-context";

/** A line diff as the card and 小帮手's `instructions.set` card draw it: removed lines struck, added lines marked. */
export function DiffView({ diff }: { diff: DiffLine[] }) {
  const t = useT();
  return <ol className="conversation-diff" aria-label={t("改动前后对比")}>
    {diff.map((line, at) => <li key={at} data-kind={line.kind} data-sign={line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}>
      <span className="sr-only">{line.kind === "added" ? t("新增：") : line.kind === "removed" ? t("删除：") : ""}</span>{line.text || " "}</li>)}
  </ol>;
}
