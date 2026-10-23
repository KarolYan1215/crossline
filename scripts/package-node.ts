/**
 * Builds 「Crossline 节点」, the standalone compute node's Windows installer (docs/compute-node.md): one per-user setup exe holding
 *
 * - `main.mjs`: `apps/worker/src/node/standalone.ts` bundled and minified with everything it imports (the relay and `ws`), nothing else
 *   of Crossline — the Skills come from the server when the node connects;
 * - `node.exe`, the one running this script;
 * - `codex\codex.exe` and `codex\codex-code-mode-host.exe`: the release build of the vendored Codex (rust-v0.163.0, docs/local-installer.md);
 * - the Visual C++ runtime beside whatever imports it, the licences, and `start.vbs`, which starts the program without a console window.
 *
 *   pnpm exec tsx scripts/package-node.ts [--version 1.0.0] [--site https://app.crossline.lol] [--codex-dir <folder with the release binaries>]
 *
 * `--codex-dir` points at another checkout's `vendor/codex/codex-rs/target/release` (a worktree has no Codex build of its own).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CODEX_RELEASE_BINARY_SHA256 } from "../packages/codex/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const version = option("version") ?? "1.0.0";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION_INVALID ${version}`);
const site = new URL(option("site") ?? "https://app.crossline.lol").origin;
if (process.platform !== "win32") throw new Error("PACKAGE_WINDOWS_ONLY");
const out = path.join(repoRoot, "dist", "node-installer");
const stage = path.join(out, "stage");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`COMMAND_FAILED ${command} ${result.status} ${(result.stderr || result.stdout).slice(0, 400)}`);
  return result.stdout;
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, "codex"), { recursive: true });

// 1. The program, one minified file. esbuild comes with tsx, as for the worker bundle.
const fromWorker = createRequire(path.join(repoRoot, "apps", "worker", "package.json"));
const esbuild = createRequire(fromWorker.resolve("tsx/package.json"))("esbuild") as typeof import("esbuild");
const built = await esbuild.build({
  entryPoints: [path.join(repoRoot, "apps", "worker", "src", "node", "standalone.ts")],
  outfile: path.join(stage, "main.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", minify: true, legalComments: "none",
  // ws loads these native speed-ups when present and works without them.
  external: ["bufferutil", "utf-8-validate"],
  // ws is CommonJS: inside an ES module its `require` calls need one.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  metafile: true, logLevel: "warning"
});
const inputs = Object.keys(built.metafile.inputs);
// Nothing of the server's logic may end up here: only the relay, its protocol, the program and ws.
const ours = inputs.filter((file) => !file.includes("node_modules")).map((file) => file.replaceAll("\\", "/"));
const allowed = ["apps/worker/src/node/standalone.ts", "apps/worker/src/node/agent.ts", "apps/worker/src/node/protocol.ts", "apps/worker/src/node/control.ts"];
const unexpected = ours.filter((file) => !allowed.some((name) => file.endsWith(name)));
if (unexpected.length) throw new Error(`NODE_BUNDLE_TOO_WIDE ${unexpected.join(", ")}`);
console.log(JSON.stringify({ bundle: "main.mjs", kilobytes: Math.round(statSync(path.join(stage, "main.mjs")).size / 1024), sources: ours }));

// 2. node.exe and Codex.
cpSync(process.execPath, path.join(stage, "node.exe"));
const codexOut = option("codex-dir") ?? path.join(repoRoot, "vendor", "codex", "codex-rs", "target", "release");
for (const binary of ["codex.exe", "codex-code-mode-host.exe"]) {
  if (!existsSync(path.join(codexOut, binary))) throw new Error(`CODEX_RELEASE_MISSING ${binary}: build it first (docs/local-installer.md)`);
  cpSync(path.join(codexOut, binary), path.join(stage, "codex", binary));
}
const codexVersion = run(path.join(stage, "codex", "codex.exe"), ["--version"]).trim();
if (!/\b0\.163\.0\b/.test(codexVersion)) throw new Error(`CODEX_VERSION_UNEXPECTED ${codexVersion}`);
// The pinned release build only (codex-baseline.json `release`): a binary from elsewhere is never shipped by accident.
if (sha256(path.join(stage, "codex", "codex.exe")) !== CODEX_RELEASE_BINARY_SHA256) throw new Error("CODEX_RELEASE_HASH_MISMATCH");

// 3. The Visual C++ runtime, app-local, beside each binary that imports it (a fresh Windows may not have it).
const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
const vsRoot = existsSync(vswhere) ? run(vswhere, ["-latest", "-products", "*", "-property", "installationPath"]).trim() : "";
if (!vsRoot) throw new Error("VISUAL_STUDIO_MISSING: the VC++ runtime and dumpbin come from a Visual Studio (or Build Tools) install");
const newest = (dir: string) => readdirSync(dir).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1)!;
const redist = path.join(vsRoot, "VC", "Redist", "MSVC", newest(path.join(vsRoot, "VC", "Redist", "MSVC")), "x64");
const crtDir = path.join(redist, readdirSync(redist).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))!);
const dumpbin = path.join(vsRoot, "VC", "Tools", "MSVC", newest(path.join(vsRoot, "VC", "Tools", "MSVC")), "bin", "Hostx64", "x64", "dumpbin.exe");
const VC_RUNTIME = /^(msvcp140[a-z0-9_]*|vcruntime140[a-z0-9_]*|concrt140|vccorlib140)\.dll$/i;
for (const binary of [path.join(stage, "node.exe"), path.join(stage, "codex", "codex.exe"), path.join(stage, "codex", "codex-code-mode-host.exe")]) {
  const imports = (run(dumpbin, ["/nologo", "/dependents", binary]).match(/^\s+(\S+\.dll)\s*$/gim) ?? []).map((line) => line.trim());
  for (const dll of imports.filter((name) => VC_RUNTIME.test(name))) {
    const source = path.join(crtDir, dll.toLowerCase());
    if (!existsSync(source)) throw new Error(`VC_RUNTIME_UNRESOLVED ${path.basename(binary)} → ${dll}`);
    cpSync(source, path.join(path.dirname(binary), dll.toLowerCase()));
    console.log(`vc runtime: ${path.relative(stage, path.join(path.dirname(binary), dll.toLowerCase()))}`);
  }
}

// 4. Licences, the hidden starter and what this build is.
const notices = path.join(stage, "licenses");
mkdirSync(notices, { recursive: true });
for (const name of ["LICENSE", "NOTICE"]) {
  cpSync(path.join(repoRoot, "vendor", "codex", name), path.join(stage, "codex", name));
  cpSync(path.join(repoRoot, "vendor", "codex", name), path.join(notices, `codex-${name}.txt`));
}
const nodeLicense = path.join(out, "cache", `node-${process.version}-LICENSE.txt`);
if (!existsSync(nodeLicense)) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!response.ok) throw new Error(`NODE_LICENSE_DOWNLOAD_FAILED ${response.status}`);
  mkdirSync(path.dirname(nodeLicense), { recursive: true });
  writeFileSync(nodeLicense, await response.text());
}
cpSync(nodeLicense, path.join(notices, "node-LICENSE.txt"));
cpSync(path.join(repoRoot, "node_modules", ".pnpm", readdirSync(path.join(repoRoot, "node_modules", ".pnpm")).find((name) => /^ws@/.test(name))!, "node_modules", "ws", "LICENSE"),
  path.join(notices, "ws-LICENSE.txt"));
writeFileSync(path.join(notices, "README.txt"), [
  "Crossline 节点随附的第三方程序：",
  `- Node.js ${process.version}（node.exe），MIT 等许可，见 node-LICENSE.txt`,
  `- OpenAI Codex（codex\\codex.exe、codex\\codex-code-mode-host.exe，${codexVersion}），Apache-2.0，见 codex-LICENSE.txt 与 codex-NOTICE.txt；`,
  "  源码固定在 https://github.com/openai/codex 的 rust-v0.163.0（83086188ae0614bd882818ff1aa23f3194962012），附一处 Windows 迁移校验和补丁",
  "- ws（打包在 main.mjs 内），MIT，见 ws-LICENSE.txt",
  "- Microsoft Visual C++ 运行库（msvcp140*.dll、vcruntime140*.dll，放在用到它们的模块旁边），按 Visual Studio 许可条款中的可分发代码条款随附",
  ""
].join("\r\n"));
// wscript runs node with no window; `--autostart` comes from the sign-in entry and keeps the page closed when nothing is missing.
writeFileSync(path.join(stage, "start.vbs"), [
  "Set shell = CreateObject(\"WScript.Shell\")",
  "folder = CreateObject(\"Scripting.FileSystemObject\").GetParentFolderName(WScript.ScriptFullName)",
  "extra = \"\"",
  "If WScript.Arguments.Count > 0 Then extra = \" \" & WScript.Arguments(0)",
  "shell.CurrentDirectory = folder",
  `shell.Run """" & folder & "\\node.exe"" """ & folder & "\\main.mjs"" --site ${site}" & extra, 0, False`,
  ""
].join("\r\n"));
const release = { version, site, codex: codexVersion, codexSha256: sha256(path.join(stage, "codex", "codex.exe")), node: process.version, builtAt: new Date().toISOString() };
writeFileSync(path.join(stage, "release.json"), `${JSON.stringify(release, null, 2)}\n`);

// 5. The installer.
const icon = path.join(out, "crossline.ico");
run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "installer", "make-icon.ps1"), "-Out", icon]);
const iscc = [process.env.ISCC, path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe"].find((file) => file && existsSync(file));
if (!iscc) throw new Error("INNO_SETUP_MISSING: install Inno Setup 6 (winget install JRSoftware.InnoSetup) or set ISCC");
const languages = path.join(path.dirname(iscc), "Languages");
const chinese = [path.join(languages, "ChineseSimplified.isl"), path.join(languages, "Unofficial", "ChineseSimplified.isl"),
  path.join(repoRoot, "installer", "ChineseSimplified.isl")].find((file) => existsSync(file)) ?? path.join(path.dirname(iscc), "Default.isl");
run(iscc, [`/DAppVersion=${version}`, `/DStage=${stage}`, `/DOutputDir=${out}`, `/DIconFile=${icon}`, `/DLanguageFile=${chinese}`, "/Q",
  path.join(repoRoot, "installer", "crossline-node.iss")]);
const setup = path.join(out, `Crossline-Node-Setup-${version}.exe`);
console.log(JSON.stringify({ setup, megabytes: Math.round(statSync(setup).size / 1_048_576), sha256: sha256(setup), ...release }));
