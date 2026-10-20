/**
 * Builds the worker into one ES module (`apps/worker/dist/index.mjs`) that plain `node` runs, so the hosted server no longer pays for
 * tsx compiling TypeScript at start and keeping its esbuild service alive beside the worker (decided 2026-10-16, the 2 GB server).
 *
 *   node scripts/build-worker.mjs
 *
 * The workspace packages (`@crossline/*`, raw TypeScript) are bundled in. Every other package stays outside the bundle, imported by the
 * absolute path esbuild resolves for it from the file that imports it: pnpm keeps each package's dependencies beside that package, so
 * a bare name would not be found from `apps/worker/dist`. Each source file's `import.meta.url` and `import.meta.dirname` are replaced by
 * its own original location, so paths worked out from them (the repository root, the vendored Codex, `createRequire` for HiGHS) are
 * exactly what they are under tsx. The bundle therefore runs only inside the checkout (or image) it was built in.
 */
import { readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const worker = path.join(repo, "apps", "worker");
// esbuild comes with tsx, which the worker already depends on; no separate install is needed.
const fromWorker = createRequire(path.join(worker, "package.json"));
const esbuild = createRequire(fromWorker.resolve("tsx/package.json"))("esbuild");
const builtins = new Set(builtinModules);

const outside = {
  name: "crossline-outside",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, async (args) => {
      // A Windows absolute path (an entry point, `C:\…`) also starts with a letter; it is a file, not a package.
      if (args.pluginData === "inner" || path.isAbsolute(args.path)) return undefined;
      const name = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0];
      if (args.path.startsWith("node:") || builtins.has(name)) return { path: args.path, external: true };
      if (args.path.startsWith("@crossline/")) return undefined;
      const found = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: "inner" });
      // An optional package that is not installed (a model or a decoder used on demand) stays a bare name and fails only when used.
      if (found.errors.length || !found.path) return { path: args.path, external: true };
      return { path: found.path, external: true };
    });
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const contents = source
        .replaceAll("import.meta.dirname", JSON.stringify(path.dirname(args.path)))
        .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(args.path).href));
      return { contents, loader: "ts" };
    });
  }
};

// The worker, and the server transcriber's own process (apps/worker/src/transcriber.ts, docs/phone-recording.md), which shares its code.
for (const [entry, out] of [["index.ts", "index.mjs"], ["transcriber.ts", "transcriber.mjs"]]) {
const result = await esbuild.build({
  entryPoints: [path.join(worker, "src", entry)],
  outfile: path.join(worker, "dist", out),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "warning",
  plugins: [outside],
  metafile: true
});
const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0);
console.log(JSON.stringify({ built: path.relative(repo, path.join(worker, "dist", out)), megabytes: +(bytes / 1048576).toFixed(1) }));
}
