"use client";

import { useEffect, useState } from "react";
import { BUILT_IN_LINES, LINE_PALETTE } from "@crossline/identity-packs";

/**
 * Colours for the lines the person added (the stylesheet knows only the built-in four), in both themes. Read from `/api/lines` on the
 * client so the shared frame stays a plain component; until it arrives a new line is drawn in the neutral colour.
 */
export function LineColors() {
  const [rules, setRules] = useState("");
  useEffect(() => {
    void fetch("/api/lines").then((response) => response.json()).then((body: { lines?: Array<{ id: string; color: string }> }) => {
      const own = (body.lines ?? []).filter((line) => !(BUILT_IN_LINES.has(line.id) && line.color === line.id) && LINE_PALETTE[line.color]);
      setRules(own.length ? lineColourRules(own.map((line) => ({ id: line.id, ...LINE_PALETTE[line.color]! }))) : "");
    }).catch(() => {});
  }, []);
  return rules ? <style>{rules}</style> : null;
}

/**
 * The stylesheet for the person's own lines: light, dark (system and explicit), then light again inside the portrait's poster, which is
 * paper in either scheme (last, so it wins at equal weight).
 */
export function lineColourRules(lines: Array<{ id: string; light: string; dark: string }>): string {
  const scoped = (theme: "light" | "dark", scope: string) => lines.map((line) => `${scope}[data-line="${line.id}"]{--lc:${line[theme]}}`).join("");
  return `${scoped("light", "")}@media (prefers-color-scheme:dark){${scoped("dark", ':root:not([data-theme="light"]) ')}}${scoped("dark", ':root[data-theme="dark"] ')}${scoped("light", ":root .pt-doc ")}`;
}
