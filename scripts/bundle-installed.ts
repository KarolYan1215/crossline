import { readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The worker and the launcher of the installed copy (docs/local-installer.md) as minified ES modules with no source maps, so the
 * installer ships compiled JavaScript instead of the repository's TypeScript (scripts/package-installer.ts used to copy every
 * `apps/*\/src` and `packages/*\/src` and run them through tsx).
 *
 *   pnpm exec tsx scripts/bundle-installed.ts <stage folder>
 *
 * writes `<stage>/apps/worker/dist/index.mjs` and `<stage>/apps/launcher/dist/main.mjs`. The workspace packages (`@crossline/*`,
 * raw TypeScript) are bundled in; every other package stays a bare import, which the installed tree's one hoisted `node_modules`
 * answers from `apps/<name>/dist` exactly as from `apps/<name>/src`. Each bundle sits at the same depth as the source folder it
 * replaces, so `import.meta.dirname`/`import.meta.url` (the app root as `../../..`, the vendored Codex, `createRequire` for HiGHS)
 * land where they did under tsx. Unlike scripts/build-worker.mjs (the server image), nothing machine-specific is baked in, and no
 * source map is written: the server keeps its maps, the installer must not carry them.
 *
 * A bundle that takes in anything but the shipped sources — a test, a test helper, a script, a package's own files — fails the build.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const fromWorker = createRequire(path.join(repoRoot, "apps", "worker", "package.json"));
const esbuild = createRequire(fromWorker.resolve("tsx/package.json"))("esbuild") as typeof import("esbuild");

/** Bare imports other than the workspace's own stay outside the bundle, by name. */
const outside: import("esbuild").Plugin = {
  name: "crossline-bare-external",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (path.isAbsolute(args.path) || args.path.startsWith("@crossline/")) return undefined;
      return { path: args.path, external: true };
    });
  }
};

type Bundle = { name: string; entry: string; out: string; allowed: RegExp };
const BUNDLES: Bundle[] = [
  { name: "worker", entry: "apps/worker/src/index.ts", out: "apps/worker/dist/index.mjs", allowed: /^(apps\/worker\/src|packages\/[a-z-]+\/src)\// },
  { name: "launcher", entry: "apps/launcher/src/main.ts", out: "apps/launcher/dist/main.mjs", allowed: /^apps\/launcher\/src\// }
];
const NOT_SHIPPED = /\.test\.tsx?$|\/testing\/|\/fixtures\//;

export async function bundleInstalled(stage: string): Promise<Array<{ name: string; out: string; kilobytes: number; sources: number }>> {
  const built = [];
  for (const bundle of BUNDLES) {
    const outfile = path.join(stage, bundle.out);
    rmSync(path.dirname(outfile), { recursive: true, force: true });
    const result = await esbuild.build({
      entryPoints: [path.join(repoRoot, bundle.entry)], outfile, bundle: true, platform: "node", format: "esm", target: "node22",
      minify: true, keepNames: true, sourcemap: false, legalComments: "none", charset: "utf8", logLevel: "warning", plugins: [outside], metafile: true
    });
    const sources = Object.keys(result.metafile.inputs).map((file) => path.relative(repoRoot, path.resolve(repoRoot, file)).replaceAll("\\", "/"));
    const unexpected = sources.filter((file) => !bundle.allowed.test(file) || NOT_SHIPPED.test(file));
    if (unexpected.length) throw new Error(`INSTALLED_BUNDLE_TOO_WIDE ${bundle.name}: ${unexpected.join(", ")}`);
    built.push({ name: bundle.name, out: bundle.out, kilobytes: Math.round(statSync(outfile).size / 1024), sources: sources.length });
  }
  return built;
}

/** Every `.map` under `root`; the installer refuses to ship one. */
export function sourceMaps(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".map"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stage = process.argv[2];
  if (!stage) throw new Error("USAGE: pnpm exec tsx scripts/bundle-installed.ts <stage folder>");
  const built = await bundleInstalled(path.resolve(stage));
  const maps = sourceMaps(path.resolve(stage, "apps"));
  if (maps.length) throw new Error(`SOURCE_MAP_STAGED ${maps.join(", ")}`);
  console.log(JSON.stringify(built));
}
