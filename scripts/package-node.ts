/**
 * Builds 「Crossline 节点」, the standalone compute node's Windows installer (docs/compute-node.md): one per-user setup exe holding
 *
 * - `main.mjs`: `apps/worker/src/node/standalone.ts` bundled and minified with everything it imports (the relay and `ws`), nothing else
 *   of Crossline — the Skills come from the server when the node connects;
 * - `node.exe`, the one running this script;
 * - `codex\codex.exe` and `codex\codex-code-mode-host.exe`: the release build of the vendored Codex (rust-v0.163.0, docs/local-installer.md);
 * - the Visual C++ runtime beside whatever imports it and the licences;
 * - `CrosslineNode.exe`, the tray (installer/node-tray/CrosslineNode.cs: icon, menu, Ctrl+Alt+H and the 小帮手's desktop window), compiled
 *   here with the .NET Framework C# compiler against the WebView2 SDK's managed DLLs, which ship beside it (`WEBVIEW2` below: version and
 *   SHA-256 pinned, Microsoft's Authenticode signature checked);
 * - `ffmpeg\ffmpeg.exe` + `ffprobe.exe` + LICENSE: a pinned static build (`FFMPEG` below), downloaded once into `%LOCALAPPDATA%\crossline-build-cache`
 *   (or `CROSSLINE_BUILD_CACHE`) and checked against its SHA-256; the node puts the folder first on PATH for the Codex it starts;
 * - `Crossline-Node-Setup.exe`, the installer again under a name without the version (the stable download link);
 * - `node-latest.json`, the update manifest, signed with `CROSSLINE_RELEASE_KEY` (scripts/release-sign.ts) when that is set.
 *
 *   pnpm exec tsx scripts/package-node.ts [--version 1.0.0] [--site https://app.crossline.lol] [--codex-dir <folder with the release binaries>]
 *     [--webview2-dir <folder>] [--update-feed https://…/node-latest.json] [--release-base https://github.com/<owner>/<repo>/releases/download]
 *
 * `--codex-dir` points at another checkout's `vendor/codex/codex-rs/target/release` (a worktree has no Codex build of its own).
 * `--webview2-dir` is the NuGet package Microsoft.Web.WebView2 at the pinned version, extracted (`nuget install Microsoft.Web.WebView2
 * -Version 1.0.2365.46`); by default the NuGet global cache is read.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CODEX_RELEASE_BINARY_SHA256 } from "../packages/codex/src/index";
import { signManifestFile } from "./release-sign";

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
  // ws loads these native speed-ups when present and works without them; playwright-core (the readers' browser on this computer,
  // node/browser.ts) is shipped beside main.mjs as its own package, since it cannot be bundled.
  external: ["bufferutil", "utf-8-validate", "playwright-core"],
  // ws is CommonJS: inside an ES module its `require` calls need one.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  metafile: true, logLevel: "warning"
});
const inputs = Object.keys(built.metafile.inputs);
// Nothing of the server's logic may end up here: only the relay, its protocol, the program and ws.
const ours = inputs.filter((file) => !file.includes("node_modules")).map((file) => file.replaceAll("\\", "/"));
// The launcher's updater and its Ed25519 check come along (2026-10-28): the node verifies its own updates with the same code.
const allowed = ["apps/worker/src/node/standalone.ts", "apps/worker/src/node/agent.ts", "apps/worker/src/node/protocol.ts", "apps/worker/src/node/control.ts",
  "apps/worker/src/node/browser.ts", "apps/launcher/src/update.ts", "apps/launcher/src/release-signature.ts"];
const unexpected = ours.filter((file) => !allowed.some((name) => file.endsWith(name)));
if (unexpected.length) throw new Error(`NODE_BUNDLE_TOO_WIDE ${unexpected.join(", ")}`);
console.log(JSON.stringify({ bundle: "main.mjs", kilobytes: Math.round(statSync(path.join(stage, "main.mjs")).size / 1024), sources: ours }));

// The readers' browser driver: playwright-core as it is installed for the worker (it drives the person's own Chrome or Edge; no browser
// is shipped).
const playwright = path.dirname(fromWorker.resolve("playwright-core/package.json"));
cpSync(playwright, path.join(stage, "node_modules", "playwright-core"), { recursive: true, dereference: true });

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

// 2b. ffmpeg, for the shell assistant's video editing on this computer: Gyan's static essentials build, from its GitHub release (the zip's
// SHA-256 pinned below, checked before anything is taken out of it). The download is kept outside the repository and reused.
const FFMPEG = {
  version: "9.0.2",
  url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
  sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
};
const buildCache = process.env.CROSSLINE_BUILD_CACHE ?? path.join(process.env.LOCALAPPDATA ?? path.join(repoRoot, ".."), "crossline-build-cache");
const ffmpegZip = path.join(buildCache, path.basename(new URL(FFMPEG.url).pathname));
if (!existsSync(ffmpegZip) || sha256(ffmpegZip) !== FFMPEG.sha256) {
  console.log(`downloading ${FFMPEG.url}`);
  const response = await fetch(FFMPEG.url);
  if (!response.ok) throw new Error(`FFMPEG_DOWNLOAD_FAILED ${response.status}`);
  mkdirSync(buildCache, { recursive: true });
  writeFileSync(ffmpegZip, Buffer.from(await response.arrayBuffer()));
}
if (sha256(ffmpegZip) !== FFMPEG.sha256) throw new Error(`FFMPEG_HASH_MISMATCH ${ffmpegZip}`);
const ffmpegTop = `ffmpeg-${FFMPEG.version}-essentials_build`;
const ffmpegOut = path.join(buildCache, ffmpegTop);
rmSync(ffmpegOut, { recursive: true, force: true });
// Windows' own bsdtar reads zip; named by path so Git's tar (no zip support) is never the one found first.
run(path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", ffmpegZip, "-C", buildCache,
  `${ffmpegTop}/bin/ffmpeg.exe`, `${ffmpegTop}/bin/ffprobe.exe`, `${ffmpegTop}/LICENSE`]);
mkdirSync(path.join(stage, "ffmpeg"), { recursive: true });
for (const binary of ["ffmpeg.exe", "ffprobe.exe"]) cpSync(path.join(ffmpegOut, "bin", binary), path.join(stage, "ffmpeg", binary));
cpSync(path.join(ffmpegOut, "LICENSE"), path.join(stage, "ffmpeg", "LICENSE.txt"));
const ffmpegVersion = run(path.join(stage, "ffmpeg", "ffmpeg.exe"), ["-hide_banner", "-version"]).split("\n")[0]!.trim();
if (!ffmpegVersion.includes(FFMPEG.version)) throw new Error(`FFMPEG_VERSION_UNEXPECTED ${ffmpegVersion}`);

// 3. The Visual C++ runtime, app-local, beside each binary that imports it (a fresh Windows may not have it).
const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
const vsRoot = existsSync(vswhere) ? run(vswhere, ["-latest", "-products", "*", "-property", "installationPath"]).trim() : "";
if (!vsRoot) throw new Error("VISUAL_STUDIO_MISSING: the VC++ runtime and dumpbin come from a Visual Studio (or Build Tools) install");
const newest = (dir: string) => readdirSync(dir).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1)!;
const redist = path.join(vsRoot, "VC", "Redist", "MSVC", newest(path.join(vsRoot, "VC", "Redist", "MSVC")), "x64");
const crtDir = path.join(redist, readdirSync(redist).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name))!);
const dumpbin = path.join(vsRoot, "VC", "Tools", "MSVC", newest(path.join(vsRoot, "VC", "Tools", "MSVC")), "bin", "Hostx64", "x64", "dumpbin.exe");
const VC_RUNTIME = /^(msvcp140[a-z0-9_]*|vcruntime140[a-z0-9_]*|concrt140|vccorlib140)\.dll$/i;
for (const binary of [path.join(stage, "node.exe"), path.join(stage, "codex", "codex.exe"), path.join(stage, "codex", "codex-code-mode-host.exe"),
  path.join(stage, "ffmpeg", "ffmpeg.exe"), path.join(stage, "ffmpeg", "ffprobe.exe")]) {
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
  `- FFmpeg ${FFMPEG.version}（ffmpeg\\ffmpeg.exe、ffmpeg\\ffprobe.exe，Gyan Doshi 的 essentials 静态构建，${FFMPEG.url}），`,
  "  GPLv3，见 ffmpeg\\LICENSE.txt；FFmpeg 源码见 https://ffmpeg.org/releases/ ，该构建所含各库的源码与配置见 https://www.gyan.dev/ffmpeg/builds/",
  "- playwright-core（node_modules\playwright-core，用来驱动本机的 Chrome 或 Edge 读取本人登录的网站），Apache-2.0，见其目录内的 LICENSE",
  "- Microsoft Visual C++ 运行库（msvcp140*.dll、vcruntime140*.dll，放在用到它们的模块旁边），按 Visual Studio 许可条款中的可分发代码条款随附",
  "- Microsoft Edge WebView2 SDK 1.0.2365.46（Microsoft.Web.WebView2.Core.dll、Microsoft.Web.WebView2.WinForms.dll、WebView2Loader.dll，",
  "  来自 NuGet 包 Microsoft.Web.WebView2），托盘程序 CrosslineNode.exe 用它显示小帮手窗口；BSD 式许可，见",
  "  https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2365.46/License 。WebView2 运行时本身由 Windows 提供，不随包",
  ""
].join("\r\n"));
// Kept for installs from before the tray, whose sign-in entry still names it: it now starts the tray, which starts the node.
writeFileSync(path.join(stage, "start.vbs"), [
  "Set shell = CreateObject(\"WScript.Shell\")",
  "folder = CreateObject(\"Scripting.FileSystemObject\").GetParentFolderName(WScript.ScriptFullName)",
  "extra = \"\"",
  "If WScript.Arguments.Count > 0 Then extra = \" --background\"",
  "shell.CurrentDirectory = folder",
  `shell.Run """" & folder & "\\CrosslineNode.exe"" --site ${site}" & extra, 0, False`,
  ""
].join("\r\n"));

// 5. The tray, against the WebView2 SDK's managed DLLs (shipped beside it; the runtime itself is Windows' own, Evergreen WebView2).
const WEBVIEW2 = {
  version: "1.0.2365.46",
  files: {
    // From nuget.org's package (its SHA-512 checked against NuGet's catalog, 2026-11-03): lib/net45 and runtimes/win-x64/native. The
    // values pinned before matched no file of that package.
    "Microsoft.Web.WebView2.Core.dll": "a7baa548c354ef9223f4fd19d2bae33c3eb8cb987bf7b577828897388110740f",
    "Microsoft.Web.WebView2.WinForms.dll": "3bf5b0990756e5b8e6502d51bc228962d9d3e59a358eaca9ba8dc87bea86c1de",
    "WebView2Loader.dll": "5ebda0b70e04873607ff0e8ceea8fb29074b14717c2a67c2086f4ee42404ec7a"
  } as Record<string, string>
};
const webview2Root = option("webview2-dir")
  ?? path.join(process.env.USERPROFILE ?? "", ".nuget", "packages", "microsoft.web.webview2", WEBVIEW2.version);
const webview2File = (name: string) => [path.join(webview2Root, name), path.join(webview2Root, "lib", "net45", name),
  path.join(webview2Root, "lib", "net462", name), path.join(webview2Root, "runtimes", "win-x64", "native", name)].find((file) => existsSync(file));
for (const [name, pinned] of Object.entries(WEBVIEW2.files)) {
  const file = webview2File(name);
  if (!file) throw new Error(`WEBVIEW2_SDK_MISSING ${name}: nuget install Microsoft.Web.WebView2 -Version ${WEBVIEW2.version}, or pass --webview2-dir`);
  if (sha256(file) !== pinned) throw new Error(`WEBVIEW2_HASH_MISMATCH ${name} (${file}): expected the pinned ${WEBVIEW2.version} build`);
  // Microsoft's own signature, beside the pin: a file with the right hash is by definition the right file, this says who made it.
  const signer = run("powershell.exe", ["-NoProfile", "-Command", `$s=Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`]).trim();
  if (!/^Valid\|CN=Microsoft Corporation,/.test(signer)) throw new Error(`WEBVIEW2_SIGNATURE_INVALID ${name}: ${signer}`);
  cpSync(file, path.join(stage, name));
}
const icon = path.join(out, "crossline.ico");
run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "installer", "make-icon.ps1"), "-Out", icon]);
const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
run(csc, ["-nologo", "-target:winexe", "-optimize", "-platform:x64", `-win32icon:${icon}`, `-out:${path.join(stage, "CrosslineNode.exe")}`,
  "-r:System.Windows.Forms.dll", "-r:System.Drawing.dll", `-r:${path.join(stage, "Microsoft.Web.WebView2.Core.dll")}`,
  `-r:${path.join(stage, "Microsoft.Web.WebView2.WinForms.dll")}`, path.join(repoRoot, "installer", "node-tray", "CrosslineNode.cs")]);

const base = option("release-base") ?? "https://github.com/KarolYan1215/crossline-releases/releases/download";
const updateFeed = option("update-feed") ?? `${base.replace(/\/download$/, "")}/latest/download/node-latest.json`;
const release = { version, site, updateFeed, codex: codexVersion, codexSha256: sha256(path.join(stage, "codex", "codex.exe")), node: process.version,
  ffmpeg: { version: FFMPEG.version, zipSha256: FFMPEG.sha256 },
  webview2: { version: WEBVIEW2.version, sha256: WEBVIEW2.files }, builtAt: new Date().toISOString() };
writeFileSync(path.join(stage, "release.json"), `${JSON.stringify(release, null, 2)}\n`);

// 6. The installer.
const iscc = [process.env.ISCC, path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe", "C:\\Program Files\\Inno Setup 6\\ISCC.exe"].find((file) => file && existsSync(file));
if (!iscc) throw new Error("INNO_SETUP_MISSING: install Inno Setup 6 (winget install JRSoftware.InnoSetup) or set ISCC");
const languages = path.join(path.dirname(iscc), "Languages");
const chinese = [path.join(languages, "ChineseSimplified.isl"), path.join(languages, "Unofficial", "ChineseSimplified.isl"),
  path.join(repoRoot, "installer", "ChineseSimplified.isl")].find((file) => existsSync(file)) ?? path.join(path.dirname(iscc), "Default.isl");
run(iscc, [`/DAppVersion=${version}`, `/DStage=${stage}`, `/DOutputDir=${out}`, `/DIconFile=${icon}`, `/DLanguageFile=${chinese}`, "/Q",
  path.join(repoRoot, "installer", "crossline-node.iss")]);
const setup = path.join(out, `Crossline-Node-Setup-${version}.exe`);
// The same installer under a name without the version, so `releases/latest/download/Crossline-Node-Setup.exe` always works as a link.
cpSync(setup, path.join(out, "Crossline-Node-Setup.exe"));
console.log(JSON.stringify({ setup, megabytes: Math.round(statSync(setup).size / 1_048_576), sha256: sha256(setup), ...release }));

// 7. The update manifest, as the public releases repository serves it (asset `node-latest.json`), signed when the key is at hand.
const manifestFile = path.join(out, "node-latest.json");
writeFileSync(manifestFile, `${JSON.stringify({ product: "crossline-node", version, url: `${base}/node-v${version}/${path.basename(setup)}`,
  sha256: sha256(setup), size: statSync(setup).size, publishedAt: new Date().toISOString() }, null, 2)}\n`);
if (process.env.CROSSLINE_RELEASE_KEY) console.log(JSON.stringify(signManifestFile(manifestFile)));
else console.warn("node-latest.json is NOT signed: nodes refuse it until `scripts/release-sign.ts sign` runs with CROSSLINE_RELEASE_KEY");
