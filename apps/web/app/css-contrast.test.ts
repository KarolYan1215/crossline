import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINE_PALETTE } from "@crossline/identity-packs";
import { check, checkRepo, contrastRatio, parseColour, type CheckInput } from "../../../scripts/check-css-contrast";
import { lineColourRules } from "./line-colors";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const run = (files: Record<string, string>, extra: Partial<CheckInput> = {}) =>
  check({ files: Object.entries(files).map(([file, text]) => ({ file, text })), globalFiles: new Set(["g.css"]), componentVars: new Set(), allowlist: [], ...extra }).findings;

const ROOT = `:root{--paper:#FFFFFF;--ink:#0A0A0A;--mist:#CFCFCF;--line:var(--mist)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0B0B0B;--ink:#F2F2F2;--mist:#3A3A3A}}`;

describe("the stylesheet checker", () => {
  it("passes the web app's stylesheets: no undefined variable, no stray colour, AA contrast in light and dark", () => {
    const { findings } = checkRepo(repoRoot);
    expect(findings.map((f) => `${f.kind} ${f.file}:${f.line} ${f.message}`)).toEqual([]);
  // Reads every stylesheet and component of the web app; under a loaded full run that passed the 5 s default.
  }, 60_000);

  it("flags a variable defined nowhere the page can see, but not one with a fallback or one a component sets", () => {
    const findings = run({ "g.css": ROOT, "page.css": ".a{border:1px solid var(--rule)}.b{color:var(--rule, inherit)}.c{width:var(--fill)}",
      "other.css": ".helper{--rule:#000}" }, { componentVars: new Set(["--fill"]) });
    expect(findings.filter((f) => f.kind === "undefined-var").map((f) => f.message)).toEqual([expect.stringContaining("--rule")]);
  });

  it("flags a colour literal outside a token, lets black shadows and masks through, and fails a stale allowlist entry", () => {
    const findings = run({ "g.css": ROOT, "page.css": `.a{color:#5E1212}.b{box-shadow:0 1px 2px rgba(0,0,0,.1)}.c{mask-image:linear-gradient(#000,transparent)}
      .d{background:white}.e{--token:#123456}/* #ABCDEF in a comment */.f{background-color:#F3EEE6}` },
      { allowlist: [{ file: "page.css", match: "#F3EEE6", reason: "image ground" }, { file: "page.css", match: "#999", reason: "gone" }] });
    expect(findings.filter((f) => f.kind === "colour-literal").map((f) => f.message)).toEqual([expect.stringContaining("#5E1212"), expect.stringContaining("white")]);
    expect(findings.filter((f) => f.kind === "stale-allowlist")).toHaveLength(1);
  });

  it("catches a frame whose derived token kept the root's value (the onboarding bug), and a light poster with dark-scheme ink", () => {
    // `--line` is computed at the root, so remapping `--mist` in the frame does not move it: a text token resolved the same way fails.
    const findings = run({ "g.css": `${ROOT.replace("--line:var(--mist)", "--line:var(--mist);--graphite:var(--ink)")}`,
      "frame.css": ".poster{--paper:#F6F2EA;--ink:#1C1A17}" });
    expect(findings.filter((f) => f.kind === "contrast").map((f) => f.message)).toEqual([expect.stringMatching(/^\.poster dark: --graphite on --paper is 1\.\d+:1/)]);
  });

  it("checks a rule that sets text and ground together in both schemes, and leaves a disabled control alone", () => {
    const findings = run({ "g.css": `${ROOT.replace("--line:var(--mist)", "--now:#085E3A")}
      @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--now:#5FE3AE}}`, "page.css": ".tag{background:var(--now);color:#fff}.x:disabled{background:var(--mist);color:var(--paper)}" });
    expect(findings.filter((f) => f.kind === "contrast").map((f) => f.message)).toEqual([expect.stringMatching(/^:root \.tag dark: #fff on var\(--now\)/)]);
  });

  it("measures WCAG contrast", () => {
    expect(contrastRatio(parseColour("#000")!, parseColour("#fff")!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColour("#767676")!, parseColour("white")!)).toBeCloseTo(4.54, 1);
    expect(parseColour("rgb(0 0 0 / .5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });
});

describe("the person's own line colours", () => {
  const { scopes } = checkRepo(repoRoot);
  const ground = (scope: string, scheme: "light" | "dark", token: string) => parseColour(scopes.get(scope)![scheme].get(token)!)!;
  it.each(Object.entries(LINE_PALETTE))("%s reads as text on every ground, and its light value on the poster", (_, colour) => {
    for (const token of ["--paper", "--chalk", "--ds-bg", "--ds-card", "--ds-chalk"]) {
      expect(contrastRatio(parseColour(colour.light)!, ground(":root", "light", token))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseColour(colour.dark)!, ground(":root", "dark", token))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(parseColour(colour.light)!, ground(".pt-doc", "dark", token))).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps the light colour inside the poster, after the dark rules", () => {
    const css = lineColourRules([{ id: "line-x", light: "#005B66", dark: "#4FD8E6" }]);
    expect(css.endsWith(':root .pt-doc [data-line="line-x"]{--lc:#005B66}')).toBe(true);
    expect(css.indexOf("#4FD8E6")).toBeLessThan(css.lastIndexOf("#005B66"));
  });
});
