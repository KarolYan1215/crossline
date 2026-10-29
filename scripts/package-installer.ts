import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CODEX_RELEASE_BINARY_SHA256 } from "../packages/codex/src/index";
import { bundleInstalled, sourceMaps } from "./bundle-installed";
import { signManifestFile } from "./release-sign";

/**
 * Builds the Windows installer (docs/local-installer.md, work package 2):
 *
 *   pnpm exec tsx scripts/package-installer.ts --version 0.2.0 [--telemetry-url https://…] [--update-feed https://…/latest.json]
 *     [--ms-client-id …] [--release-base https://github.com/<owner>/<repo>/releases/download] [--skip-web-build]
 *
 * 1. builds the web app into apps/web/.next-prod (unless --skip-web-build);
 * 2. stages a tree that mirrors the repository under dist/installer/stage — the workspace's package.json files, the built web app,
 *    the worker and the launcher as minified bundles (scripts/bundle-installed.ts; no TypeScript source and no source map ships), the
 *    Skills — and installs production dependencies into it as one hoisted node_modules, on the same node.exe that is then shipped
 *    (so native modules match its ABI);
 * 3. adds node.exe, the release Codex runtime and its code-mode host (checked against the pinned hash), their licences, the tray
 *    (compiled here with the .NET Framework C# compiler) and release.json;
 * 4. compiles installer/crossline.iss with Inno Setup and writes latest.json for the public releases repository.
 *
 * Workspace links (node_modules/@crossline/*) are left out on purpose; the launcher makes them as junctions on first start
 * (apps/launcher/src/links.ts).
 *
 * DISCONTINUED (the owner, 2026-10-28): only the device and node packages are published from now on, so the Skills' prompts and the
 * core logic stay on the server. This script refuses to run without `--final-release`, which exists for one last build whose launcher
 * understands the signed `discontinued` manifest (docs/local-installer.md 「停发」). It needs `CROSSLINE_RELEASE_KEY` to sign latest.json.
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (!args.includes("--final-release")) {
  throw new Error("FULL_INSTALLER_DISCONTINUED: the full installed copy is no longer published (docs/local-installer.md 「停发」); "
    + "build the node package (scripts/package-node.ts) instead, or pass --final-release for the one last build");
}
if (!process.env.CROSSLINE_RELEASE_KEY) throw new Error("RELEASE_KEY_NOT_SET: the final release's latest.json must be signed (scripts/release-sign.ts)");
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const version = option("version") ?? (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION_INVALID ${version}`);
const out = path.join(repoRoot, "dist", "installer");
const stage = path.join(out, "stage");
const isWindows = process.platform === "win32";
if (!isWindows) throw new Error("PACKAGE_WINDOWS_ONLY");

function run(command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  console.log(`> ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: "inherit", shell: /\.(cmd|bat)$/i.test(command) });
  if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status}`);
}
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const copy = (from: string, to: string, filter?: (source: string) => boolean) =>
  cpSync(path.join(repoRoot, from), path.join(stage, to), { recursive: true, ...(filter ? { filter } : {}) });

// 1. The web build.
if (!args.includes("--skip-web-build")) run("pnpm.cmd", ["build:prod"], repoRoot);
if (!existsSync(path.join(repoRoot, "apps", "web", ".next-prod", "BUILD_ID"))) throw new Error("WEB_BUILD_MISSING");

// 2. The staged tree.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "tsconfig.base.json"]) copy(file, file);
const workspaces = ["apps/web", "apps/worker", "apps/launcher", ...readdirSync(path.join(repoRoot, "packages")).map((name) => `packages/${name}`)];
// Only each workspace's package.json (the frozen install needs them): no TypeScript source ships. The worker and the launcher go in
// as minified bundles with the workspace packages inside (scripts/bundle-installed.ts), the web app as its Next build.
for (const workspace of workspaces) copy(`${workspace}/package.json`, `${workspace}/package.json`);
// Every app in the workspace must be present for a frozen install; the ones not shipped are reduced to their package.json.
for (const name of readdirSync(path.join(repoRoot, "apps"))) {
  if (!existsSync(path.join(stage, "apps", name)) && existsSync(path.join(repoRoot, "apps", name, "package.json"))) copy(`apps/${name}/package.json`, `apps/${name}/package.json`);
}
// Not the build cache, and not `types/` — Next's type-check stubs, which `next start` never reads and which name the builder's paths.
const nextBuild = path.join(repoRoot, "apps", "web", ".next-prod");
const notShippedBuild = (source: string) => {
  const top = path.relative(nextBuild, source).split(path.sep)[0];
  return top !== "cache" && top !== "types";
};
copy("apps/web/.next-prod", "apps/web/.next-prod", notShippedBuild);
copy("apps/web/public", "apps/web/public");
copy("apps/web/next.config.mjs", "apps/web/next.config.mjs");
// The Skills stay as they are: the Codex runtime reads each SKILL.md as text.
copy("skills", "skills");
const bundles = await bundleInstalled(stage);
console.log(JSON.stringify({ bundles }));

// Production dependencies, flat, with real files (hoisted), built by the node that ships.
const node = process.execPath;
run("pnpm.cmd", ["install", "--prod", "--frozen-lockfile", "--config.node-linker=hoisted", "--config.package-import-method=copy"], stage, { ...process.env, npm_config_nodedir: "" });
rmSync(path.join(stage, "node_modules", "@crossline"), { recursive: true, force: true });
// Third-party packages' own source maps are dead weight; then nothing may carry one (a Next build with source maps on, a bundle).
for (const map of sourceMaps(path.join(stage, "node_modules"))) rmSync(map, { force: true });
const maps = sourceMaps(stage);
if (maps.length) throw new Error(`SOURCE_MAP_STAGED ${maps.slice(0, 10).map((file) => path.relative(stage, file)).join(", ")}`);
// Nothing of the repository's TypeScript either (a package's own .d.ts under node_modules is not ours).
const ownSource = readdirSync(stage, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name))
  .map((entry) => path.relative(stage, path.join(entry.parentPath, entry.name)))
  .filter((file) => !file.split(path.sep).includes("node_modules"));
if (ownSource.length) throw new Error(`TYPESCRIPT_STAGED ${ownSource.slice(0, 10).join(", ")}`);
// Runtime libraries for other systems are dead weight in a Windows-only build.
const onnx = path.join(stage, "node_modules", "onnxruntime-node", "bin");
if (existsSync(onnx)) for (const napi of readdirSync(onnx)) for (const platform of readdirSync(path.join(onnx, napi))) {
  if (platform !== "win32") rmSync(path.join(onnx, napi, platform), { recursive: true, force: true });
}

// The Visual C++ runtime, app-local. A developer's machine always has it installed; a fresh Windows does not, and onnxruntime
// (recording transcription) imports MSVCP140/VCRUNTIME140 and would fail to load there. The DLLs are copied beside each binary that
// imports them, from the Visual Studio Redist folder Microsoft permits shipping, then every x64 binary's imports are checked.
const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
const vsRoot = existsSync(vswhere) ? spawnSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).stdout.trim() : "";
if (!vsRoot) throw new Error("VISUAL_STUDIO_MISSING: the VC++ runtime and dumpbin come from a Visual Studio (or Build Tools) install");
const newest = (dir: string) => readdirSync(dir).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1)!;
const redist = path.join(vsRoot, "VC", "Redist", "MSVC", newest(path.join(vsRoot, "VC", "Redist", "MSVC")), "x64");
const crtDir = path.join(redist, readdirSync(redist).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))!);
const dumpbin = path.join(vsRoot, "VC", "Tools", "MSVC", newest(path.join(vsRoot, "VC", "Tools", "MSVC")), "bin", "Hostx64", "x64", "dumpbin.exe");
const VC_RUNTIME = /^(msvcp140[a-z0-9_]*|vcruntime140[a-z0-9_]*|concrt140|vccorlib140)\.dll$/i;
const binaries = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  // Other architectures' copies are never loaded on x64 Windows.
  if (entry.isDirectory()) return /^(arm64|ia32|x86|darwin|linux)$/i.test(entry.name) ? [] : binaries(full);
  return /\.(exe|dll|node)$/i.test(entry.name) ? [full] : [];
});
const importsOf = (file: string) => (spawnSync(dumpbin, ["/nologo", "/dependents", file], { encoding: "utf8" }).stdout.match(/^\s+(\S+\.dll)\s*$/gim) ?? [])
  .map((line) => line.trim());
const missing: string[] = [];
for (const binary of binaries(stage)) for (const dll of importsOf(binary).filter((name) => VC_RUNTIME.test(name))) {
  const target = path.join(path.dirname(binary), dll.toLowerCase());
  if (existsSync(path.join(path.dirname(binary), dll))) continue;
  const source = path.join(crtDir, dll.toLowerCase());
  if (!existsSync(source)) { missing.push(`${path.relative(stage, binary)} → ${dll}`); continue; }
  cpSync(source, target);
  console.log(`vc runtime: ${path.relative(stage, target)}`);
}
if (missing.length) throw new Error(`VC_RUNTIME_UNRESOLVED ${missing.join(", ")}`);

// 3. The runtime, the tray and what this build is.
cpSync(node, path.join(stage, "node.exe"));
const codexOut = path.join(repoRoot, "vendor", "codex", "codex-rs", "target", "release");
const codexDir = path.join(stage, "codex");
mkdirSync(codexDir, { recursive: true });
for (const binary of ["codex.exe", "codex-code-mode-host.exe"]) {
  if (!existsSync(path.join(codexOut, binary))) throw new Error(`CODEX_RELEASE_MISSING ${binary}: build it first (docs/local-installer.md)`);
  cpSync(path.join(codexOut, binary), path.join(codexDir, binary));
}
if (sha256(path.join(codexDir, "codex.exe")) !== CODEX_RELEASE_BINARY_SHA256) throw new Error("CODEX_RELEASE_HASH_MISMATCH");
const notices = path.join(stage, "licenses");
mkdirSync(notices, { recursive: true });
cpSync(path.join(repoRoot, "vendor", "codex", "LICENSE"), path.join(codexDir, "LICENSE"));
cpSync(path.join(repoRoot, "vendor", "codex", "NOTICE"), path.join(codexDir, "NOTICE"));
cpSync(path.join(repoRoot, "vendor", "codex", "LICENSE"), path.join(notices, "codex-LICENSE.txt"));
cpSync(path.join(repoRoot, "vendor", "codex", "NOTICE"), path.join(notices, "codex-NOTICE.txt"));
const nodeLicense = path.join(out, "cache", `node-${process.version}-LICENSE.txt`);
if (!existsSync(nodeLicense)) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!response.ok) throw new Error(`NODE_LICENSE_DOWNLOAD_FAILED ${response.status}`);
  mkdirSync(path.dirname(nodeLicense), { recursive: true });
  writeFileSync(nodeLicense, await response.text());
}
cpSync(nodeLicense, path.join(notices, "node-LICENSE.txt"));
writeFileSync(path.join(notices, "README.txt"), [
  "Crossline 随附的第三方程序：",
  `- Node.js ${process.version}（node.exe），MIT 等许可，见 node-LICENSE.txt`,
  "- OpenAI Codex（codex\\codex.exe、codex\\codex-code-mode-host.exe），Apache-2.0，见 codex-LICENSE.txt 与 codex-NOTICE.txt；",
  "  源码固定在 https://github.com/openai/codex 的 rust-v0.163.0（83086188ae0614bd882818ff1aa23f3194962012），附一处 Windows 迁移校验和补丁",
  "- Microsoft Visual C++ 运行库（msvcp140*.dll、vcruntime140*.dll，放在用到它们的模块旁边），按 Visual Studio 许可条款中的可分发代码条款随附",
  "- node_modules 下各软件包的许可证在各自目录中",
  ""
].join("\r\n"));

const icon = path.join(out, "crossline.ico");
run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "installer", "make-icon.ps1"), "-Out", icon], repoRoot);
const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
run(csc, ["-nologo", "-target:winexe", "-optimize", `-win32icon:${icon}`, `-out:${path.join(stage, "Crossline.exe")}`,
  "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", path.join(repoRoot, "installer", "tray", "Crossline.cs")], repoRoot);

const release = { version, ...(option("telemetry-url") ? { telemetryUrl: option("telemetry-url") } : {}),
  ...(option("update-feed") ? { updateFeed: option("update-feed") } : {}),
  ...(option("ms-client-id") ? { msClientId: option("ms-client-id"), msTenantId: option("ms-tenant-id") ?? "common" } : {}) };
writeFileSync(path.join(stage, "release.json"), `${JSON.stringify(release, null, 2)}\n`);

// 4. The installer.
const iscc = [process.env.ISCC, path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe"].find((file) => file && existsSync(file));
if (!iscc) throw new Error("INNO_SETUP_MISSING: install Inno Setup 6 (winget install JRSoftware.InnoSetup) or set ISCC");
const languages = path.join(path.dirname(iscc), "Languages");
const chinese = [path.join(languages, "ChineseSimplified.isl"), path.join(languages, "Unofficial", "ChineseSimplified.isl"),
  path.join(repoRoot, "installer", "ChineseSimplified.isl")].find((file) => existsSync(file)) ?? path.join(path.dirname(iscc), "Default.isl");
run(iscc, [`/DAppVersion=${version}`, `/DStage=${stage}`, `/DOutputDir=${out}`, `/DIconFile=${icon}`, `/DLanguageFile=${chinese}`, "/Q",
  path.join(repoRoot, "installer", "crossline.iss")], repoRoot);

const setup = path.join(out, `Crossline-Setup-${version}.exe`);
// The public releases repository serves the file as a release asset named after its tag (docs/local-installer.md, 更新).
const base = option("release-base") ?? "https://github.com/KarolYan1215/crossline-releases/releases/download";
const manifest = { product: "crossline", version, url: `${base}/v${version}/${path.basename(setup)}`, sha256: sha256(setup), size: statSync(setup).size,
  publishedAt: new Date().toISOString() };
writeFileSync(path.join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ setup, ...signManifestFile(path.join(out, "latest.json")) }));
