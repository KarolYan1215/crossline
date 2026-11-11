/**
 * The stylesheet checker (2026-11-10): every colour the web app shows has a value in both schemes and reads at WCAG AA.
 *
 *   (a) `var(--x)` with no fallback and no definition the page can see: defined in the same file, in a stylesheet `app/layout.tsx`
 *       loads for every page, under `:root` anywhere, or set from a component (`"--x": …` in a .ts/.tsx file).
 *   (b) a colour literal (hex, rgb(), hsl(), a colour name) in `apps/web/app/**\/*.css` outside a token definition (`--x: #…`).
 *       A black shadow and a mask are not colours on the page; anything else justified goes in `css-colour-allowlist.json` with a
 *       reason, and an entry that no longer matches anything fails too, so the list cannot rot.
 *   (c) contrast in light and dark, in the root and in every frame that remaps the paper (`.ob-page`, `.portrait-page`, `.pt-doc`, …):
 *       every text token on every ground at 4.5:1, graphics at 3:1, and every rule that sets both `color` and `background` at 4.5:1.
 *
 * Run from a vitest test (`apps/web/app/css-contrast.test.ts`) so `pnpm test` and the pre-commit hook enforce it; by hand:
 * `pnpm exec tsx scripts/check-css-contrast.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Scheme = "light" | "dark";
export type Decl = { prop: string; value: string; line: number };
export type Rule = { file: string; selector: string; media: string[]; decls: Decl[]; line: number };
export type Finding = { kind: "undefined-var" | "colour-literal" | "contrast" | "stale-allowlist"; file: string; line: number; message: string };
export type AllowEntry = { file: string; match: string; selector?: string; reason: string };

// ── parsing ────────────────────────────────────────────────────────────────

/** Comments become spaces (newlines kept), so line numbers stay true and a colour named in a comment is not a finding. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** A small CSS reader: rules with their selector, the @media they sit in, and their declarations. Enough for this app's sheets. */
export function parseCss(source: string, file = "inline.css"): Rule[] {
  const text = stripComments(source);
  const rules: Rule[] = [];
  const stack: Array<{ prelude: string; rule?: Rule }> = [];
  let buffer = "";
  let bufferLine = 1;
  let line = 1;
  let depth = 0; // parentheses
  let quote: string | null = null;
  const flushDecl = () => {
    const top = stack.at(-1);
    const raw = buffer.trim();
    buffer = "";
    if (!top?.rule || !raw) return;
    const colon = raw.indexOf(":");
    if (colon < 0) return;
    top.rule.decls.push({ prop: raw.slice(0, colon).trim().toLowerCase(), value: raw.slice(colon + 1).trim(), line: bufferLine });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") line++;
    if (quote) { buffer += ch; if (ch === quote && text[i - 1] !== "\\") quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth > 0) { if (!buffer.trim()) bufferLine = line; buffer += ch; continue; }
    if (ch === "{") {
      const prelude = buffer.trim().replace(/\s+/g, " ");
      buffer = "";
      const media = stack.filter((frame) => !frame.rule).map((frame) => frame.prelude);
      if (prelude.startsWith("@")) { stack.push({ prelude }); continue; }
      const rule: Rule = { file, selector: prelude, media, decls: [], line };
      rules.push(rule);
      stack.push({ prelude, rule });
      continue;
    }
    if (ch === "}") { flushDecl(); stack.pop(); continue; }
    if (ch === ";") { flushDecl(); continue; }
    if (!buffer.trim() && !/\s/.test(ch)) bufferLine = line;
    buffer += ch;
  }
  return rules;
}

// ── colours ────────────────────────────────────────────────────────────────

export type Rgba = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 }, black: { r: 0, g: 0, b: 0, a: 1 }, transparent: { r: 0, g: 0, b: 0, a: 0 }
};
const COLOUR_NAMES = ["white", "black", "red", "green", "blue", "gray", "grey", "yellow", "orange", "purple", "pink", "silver", "navy",
  "maroon", "olive", "teal", "aqua", "fuchsia", "lime", "brown", "gold", "crimson", "tomato", "coral", "salmon", "beige", "ivory"];

export function parseColour(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase().replace(/\s*!important$/, "");
  if (NAMED[value]) return NAMED[value]!;
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (fn) {
    const parts = fn.split(/[\s,/]+/).filter(Boolean);
    const num = (s: string | undefined, scale: number) => (s === undefined ? 1 : s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));
    return { r: num(parts[0], 255), g: num(parts[1], 255), b: num(parts[2], 255), a: parts[3] === undefined ? 1 : num(parts[3], 1) };
  }
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** Paint `top` (maybe translucent) over an opaque `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const back = bg.a < 1 ? over(bg, NAMED.white!) : bg;
  const front = fg.a < 1 ? over(fg, back) : fg;
  const [hi, lo] = [luminance(front), luminance(back)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// ── token resolution ───────────────────────────────────────────────────────

const DARK_MEDIA = /prefers-color-scheme\s*:\s*dark/;
const LIGHT_MEDIA = /prefers-color-scheme\s*:\s*light/;
const ROOT_DARK_PREFIXES = [':root:not([data-theme="light"])', ':root[data-theme="dark"]'];

/** Which scheme a rule applies in: both, or only one. The explicit `data-theme` override mirrors the media block, so only the media one counts. */
function ruleScheme(rule: Rule): Scheme | "both" | "skip" {
  if (rule.selector.startsWith(':root[data-theme="dark"]') || rule.selector.startsWith(':root[data-theme="light"]')) return "skip";
  if (rule.media.some((m) => DARK_MEDIA.test(m))) return "dark";
  if (rule.media.some((m) => LIGHT_MEDIA.test(m))) return "light";
  return "both";
}
/** The selector with the dark-scheme prefix taken off (`:root:not([data-theme="light"]) .x` → `.x`). */
function baseSelector(selector: string): string {
  for (const prefix of ROOT_DARK_PREFIXES) {
    if (selector === prefix) return ":root";
    if (selector.startsWith(prefix + " ")) return selector.slice(prefix.length + 1).trim();
  }
  return selector;
}

export type TokenMap = Map<string, string>;

/** Resolve `var()` inside one value against a map of computed tokens; unresolvable → null. */
export function resolveValue(value: string, tokens: TokenMap, seen = new Set<string>()): string | null {
  let out = value;
  for (let guard = 0; guard < 20 && out.includes("var("); guard++) {
    const start = out.indexOf("var(");
    let depth = 0, end = start + 3;
    for (; end < out.length; end++) {
      if (out[end] === "(") depth++;
      else if (out[end] === ")") { depth--; if (depth === 0) break; }
    }
    const inner = out.slice(start + 4, end);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    let replacement: string | null = null;
    if (!seen.has(name) && tokens.has(name)) replacement = resolveValue(tokens.get(name)!, tokens, new Set([...seen, name]));
    if (replacement === null && fallback !== null) replacement = resolveValue(fallback, tokens, seen);
    if (replacement === null) return null;
    out = out.slice(0, start) + replacement + out.slice(end + 1);
  }
  return out.trim();
}
function topLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) return i;
  }
  return -1;
}

/** Custom-property declarations of one selector in one scheme, in source order. */
function declsFor(rules: Rule[], selector: string, scheme: Scheme): Decl[] {
  const out: Decl[] = [];
  for (const rule of rules) {
    const applies = ruleScheme(rule);
    if (applies === "skip" || (applies !== "both" && applies !== scheme)) continue;
    const selectors = splitSelectors(baseSelector(rule.selector));
    if (!selectors.includes(selector) && baseSelector(rule.selector) !== selector) continue;
    out.push(...rule.decls.filter((d) => d.prop.startsWith("--")));
  }
  return out;
}
function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === "(" || selector[i] === "[") depth++;
    else if (selector[i] === ")" || selector[i] === "]") depth--;
    else if (selector[i] === "," && depth === 0) { out.push(selector.slice(last, i).trim()); last = i + 1; }
  }
  out.push(selector.slice(last).trim());
  return out;
}

/**
 * Computed tokens of a frame. As in the browser, a custom property is resolved where it is declared: a token the frame does not
 * redeclare keeps the value it computed to at its parent (which is how `--line:var(--mist)` stayed the root grey inside `.ob-page`).
 */
export function computeScope(decls: Decl[], parent: TokenMap): TokenMap {
  const local: TokenMap = new Map(parent);
  for (const d of decls) local.set(d.prop, d.value);
  const out: TokenMap = new Map(parent);
  for (const d of decls) {
    const resolved = resolveValue(d.value, local, new Set([d.prop]));
    if (resolved !== null) out.set(d.prop, resolved); else out.delete(d.prop);
  }
  return out;
}

/** Frames nested in another frame: the inner one inherits what the outer one computed. */
const SCOPE_PARENT: Record<string, string> = { ".pt-doc": ".portrait-page", ".pt-confirm": ".portrait-page", ".pt-card": ".pt-doc" };

export type Scopes = Map<string, Record<Scheme, TokenMap>>;

/** The root and every frame: a selector that declares `--paper` (the mark of a frame that remaps the ground), plus the poster. */
export function buildScopes(rules: Rule[]): Scopes {
  const scopes: Scopes = new Map();
  const root = { light: computeScope(declsFor(rules, ":root", "light"), new Map()), dark: computeScope(declsFor(rules, ":root", "dark"), new Map()) };
  // The dark root inherits every light token it does not redefine (the dark blocks list only what changes).
  for (const [k, v] of root.light) if (!root.dark.has(k)) root.dark.set(k, v);
  root.dark = computeScope(declsFor(rules, ":root", "dark"), new Map(root.light));
  scopes.set(":root", root);
  const frames = new Set<string>();
  for (const rule of rules) {
    if (ruleScheme(rule) !== "both" || rule.media.length) continue;
    if (!rule.decls.some((d) => d.prop === "--paper" || d.prop === "--pt-paper")) continue;
    for (const s of splitSelectors(rule.selector)) if (s !== ":root") frames.add(s);
  }
  const ordered = [...frames].sort((a, b) => (SCOPE_PARENT[a] ? 1 : 0) - (SCOPE_PARENT[b] ? 1 : 0));
  for (const frame of ordered) {
    const parent = scopes.get(SCOPE_PARENT[frame] ?? ":root") ?? root;
    scopes.set(frame, { light: computeScope(declsFor(rules, frame, "light"), parent.light), dark: computeScope(declsFor(rules, frame, "dark"), parent.dark) });
  }
  return scopes;
}

// ── the checks ─────────────────────────────────────────────────────────────

/** Text tokens, each must read at 4.5:1 on every ground token in every frame and scheme. */
export const TEXT_TOKENS = ["--ink", "--graphite", "--shade", "--muted", "--link", "--now-ink", "--c-research", "--c-startup", "--c-media",
  "--c-investment", "--c-health", "--ds-ink", "--ds-muted", "--ds-accent-ink", "--ds-alarm-ink", "--risk-ink", "--warn-ink"];
export const GROUND_TOKENS = ["--paper", "--chalk", "--ds-bg", "--ds-card", "--ds-side", "--ds-chalk"];
/** Text on a filled ground: [text, ground]. */
export const FILLED_PAIRS: Array<[string, string]> = [["--paper", "--ink"], ["--paper", "--block"], ["--ds-on-accent", "--ds-accent"],
  ["--ds-on-accent", "--ds-accent-ink"], ["--ink", "--ds-accent-soft"], ["--ink", "--ds-alarm-soft"], ["--ds-alarm-ink", "--ds-alarm-soft"],
  ["--tint-warn-ink", "--tint-warn"], ["--ink", "--tint-warn"], ["--paper", "--now"], ["--pt-ink", "--pt-paper"], ["--pt-muted", "--pt-paper"],
  ["--pt-accent-text", "--pt-paper"], ["--pt-ink", "--pt-soft"]];
/** Graphics (marks, rings, rules that carry meaning), each at 3:1 on the paper and the card. */
export const GRAPHIC_TOKENS = ["--now", "--ds-accent", "--ds-alarm", "--risk", "--warn", "--ring-1", "--ring-2", "--ring-3", "--ring-4"];
const GRAPHIC_GROUNDS = ["--paper", "--ds-card"];

const COLOUR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left|block|inline)(-(start|end))?(-color)?|border-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration|text-decoration-color|column-rule|column-rule-color|stop-color|flood-color|-webkit-text-fill-color|scrollbar-color|filter)$/;
const MASK_PROPS = /^(-webkit-)?mask(-image)?$/;
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const BLACK_SHADOW = /\brgba?\(\s*0\s*[, ]\s*0\s*[, ]\s*0\s*(?:[,/]\s*[\d.]+%?\s*)?\)/g;

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".next") || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(name)) out.push(full);
  }
  return out;
}

/** Colour literals in one declaration (black shadows and masks excepted). */
export function literalsIn(decl: Decl): string[] {
  if (decl.prop.startsWith("--") || MASK_PROPS.test(decl.prop)) return [];
  let value = decl.value;
  if (/shadow$|^filter$/.test(decl.prop)) value = value.replace(BLACK_SHADOW, "");
  const found = [...value.matchAll(LITERAL)].map((m) => (m[0].endsWith("(") ? value.slice(m.index).replace(/^([a-z]+\([^)]*\)).*$/s, "$1") : m[0]));
  if (COLOUR_PROPS.test(decl.prop)) {
    const bare = value.replace(/var\([^)]*\)/g, " ");
    for (const name of COLOUR_NAMES) if (new RegExp(`(^|[\\s,(])${name}($|[\\s,)!])`, "i").test(bare)) found.push(name);
  }
  return found;
}

export type CheckInput = { files: Array<{ file: string; text: string }>; globalFiles: Set<string>; componentVars: Set<string>; allowlist: AllowEntry[] };

export function check(input: CheckInput): { findings: Finding[]; scopes: Scopes } {
  const findings: Finding[] = [];
  const parsed = input.files.map(({ file, text }) => ({ file, text, rules: parseCss(text, file) }));
  const allRules = parsed.flatMap((p) => p.rules);

  // (a) undefined variables
  const globalDefs = new Set<string>(input.componentVars);
  const fileDefs = new Map<string, Set<string>>();
  for (const { file, rules } of parsed) {
    const own = new Set<string>();
    for (const rule of rules) for (const d of rule.decls) {
      if (!d.prop.startsWith("--")) continue;
      own.add(d.prop);
      if (input.globalFiles.has(file) || splitSelectors(baseSelector(rule.selector)).includes(":root")) globalDefs.add(d.prop);
    }
    fileDefs.set(file, own);
  }
  for (const { file, rules } of parsed) {
    for (const rule of rules) for (const d of rule.decls) {
      for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
        if (m[2] === ",") continue;
        const name = m[1]!;
        if (globalDefs.has(name) || fileDefs.get(file)!.has(name)) continue;
        findings.push({ kind: "undefined-var", file, line: d.line, message: `${rule.selector} { ${d.prop} } uses ${name}, defined nowhere this page can see and with no fallback` });
      }
    }
  }

  // (b) colour literals
  const used = new Set<AllowEntry>();
  for (const { file, rules } of parsed) {
    for (const rule of rules) for (const d of rule.decls) {
      for (const literal of literalsIn(d)) {
        const allow = input.allowlist.find((a) => a.file === file && a.match.toLowerCase() === literal.toLowerCase() && (!a.selector || rule.selector.includes(a.selector)));
        if (allow) { used.add(allow); continue; }
        findings.push({ kind: "colour-literal", file, line: d.line, message: `${rule.selector} { ${d.prop}: ${d.value} } — colour ${literal} outside a token; use a token with a dark value or allowlist it with a reason` });
      }
    }
  }
  for (const a of input.allowlist) if (!used.has(a)) findings.push({ kind: "stale-allowlist", file: a.file, line: 0, message: `allowlist entry ${a.match}${a.selector ? ` (${a.selector})` : ""} matches nothing` });

  // (c) contrast
  const scopes = buildScopes(allRules);
  const fail = (scope: string, scheme: Scheme, fg: string, bg: string, ratio: number, min: number, file = "(tokens)", line = 0) =>
    findings.push({ kind: "contrast", file, line, message: `${scope} ${scheme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under ${min}:1` });
  for (const [scope, schemes] of scopes) {
    for (const scheme of ["light", "dark"] as const) {
      const tokens = schemes[scheme];
      const colour = (name: string) => { const v = tokens.get(name); return v === undefined ? null : parseColour(v); };
      const test = (fg: string, bg: string, min: number) => {
        const f = colour(fg), b = colour(bg);
        if (!f || !b || b.a === 0 || f.a === 0) return;
        const ratio = contrastRatio(f, b);
        if (ratio < min) fail(scope, scheme, fg, bg, ratio, min);
      };
      for (const fg of TEXT_TOKENS) for (const bg of GROUND_TOKENS) test(fg, bg, 4.5);
      for (const [fg, bg] of FILLED_PAIRS) test(fg, bg, 4.5);
      for (const fg of GRAPHIC_TOKENS) for (const bg of GRAPHIC_GROUNDS) test(fg, bg, 3);
    }
  }
  // Rules that set both the text and its ground: checked in the frames their file defines (or the root).
  for (const { file, rules } of parsed) {
    const frames = [...scopes.keys()].filter((s) => s !== ":root" && rules.some((r) => splitSelectors(r.selector).includes(s)));
    const where = frames.length ? frames : [":root"];
    for (const rule of rules) {
      const scheme = ruleScheme(rule);
      // A control that cannot be used is exempt (WCAG 1.4.3 "inactive user interface components").
      if (scheme === "skip" || /:disabled|\[disabled\]|\[aria-disabled/.test(rule.selector)) continue;
      const fgDecl = [...rule.decls].reverse().find((d) => d.prop === "color");
      const bgDecl = [...rule.decls].reverse().find((d) => d.prop === "background" || d.prop === "background-color");
      if (!fgDecl || !bgDecl) continue;
      for (const frame of where) for (const s of scheme === "both" ? (["light", "dark"] as const) : [scheme]) {
        const tokens = scopes.get(frame)![s];
        const fv = resolveValue(fgDecl.value.replace(/\s*!important$/, ""), tokens), bv = resolveValue(bgDecl.value.replace(/\s*!important$/, ""), tokens);
        const f = fv && parseColour(fv), b = bv && parseColour(bv);
        if (!f || !b || b.a === 0) continue;
        const ratio = contrastRatio(f, b);
        if (ratio < 4.5) fail(`${frame} ${rule.selector}`, s, fgDecl.value, bgDecl.value, ratio, 4.5, file, fgDecl.line);
      }
    }
  }
  return { findings, scopes };
}

/** Read the web app from disk and run every check. */
export function checkRepo(repoRoot: string): { findings: Finding[]; scopes: Scopes } {
  const appDir = path.join(repoRoot, "apps", "web", "app");
  const cssFiles = walk(appDir, (n) => n.endsWith(".css"));
  const files = cssFiles.map((f) => ({ file: relative(repoRoot, f), text: readFileSync(f, "utf8") }));
  const layout = readFileSync(path.join(appDir, "layout.tsx"), "utf8");
  const globalFiles = new Set([...layout.matchAll(/import\s+"(\.\/[^"]+\.css)"/g)].map((m) => relative(repoRoot, path.join(appDir, m[1]!))));
  const componentVars = new Set<string>();
  for (const f of walk(path.join(repoRoot, "apps", "web"), (n) => /\.(tsx?|mjs)$/.test(n) && !/\.test\./.test(n))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/["'`](--[a-zA-Z][\w-]*)["'`](?:\s+as\s+\w+)?\]?\s*:/g)) componentVars.add(m[1]!);
    for (const m of text.matchAll(/[{;\s](--[a-zA-Z][\w-]*)\s*:/g)) componentVars.add(m[1]!);
    for (const m of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g)) componentVars.add(m[1]!);
  }
  const allowlist = JSON.parse(readFileSync(path.join(repoRoot, "scripts", "css-colour-allowlist.json"), "utf8")) as AllowEntry[];
  return check({ files, globalFiles, componentVars, allowlist });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  const { findings } = checkRepo(process.cwd());
  for (const f of findings) console.log(`${f.kind}\t${f.file}:${f.line}\t${f.message}`);
  console.log(`${findings.length} finding(s)`);
  process.exitCode = findings.length ? 1 : 0;
}
