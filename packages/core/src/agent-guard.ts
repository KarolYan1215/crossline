import { tFor, type Locale } from "./i18n";

/**
 * The guard rails for the assistant that runs with a shell and file access.
 *
 * This is a tripwire, not a sandbox. The assistant runs with full access to the person's account (that was the decision), so nothing
 * here can stop a script that is written to get around a text check. What it does is catch the ordinary ways an honest-but-wrong
 * agent hurts someone — reading a password store, deleting a folder, publishing, sending, spending, changing system settings — and
 * turn each into a refusal the agent has to work around in the open, where the audit trail shows it. The real protection is the rest of
 * the design: every task works in its own directory or a git worktree, snapshots exist before it starts, every command is recorded,
 * and the last step of anything that leaves the machine is the person's.
 *
 * Content the assistant reads (a web page, an email, a file) is data. Nothing it says can authorise a send, a payment, a deletion or a
 * change to the machine; those are refused here whatever the task says.
 */
export type GuardDecision = { decision: "allow" | "deny" | "ask"; rule: string; reason: string };

export type GuardContext = {
  /** The task's own directory: everything it makes goes here. */
  taskDir: string;
  /** Other places it may write (a git worktree made for the task). */
  writableRoots?: string[];
  /** The person's home directory, so `~` and `%USERPROFILE%` can be recognised. */
  homeDir: string;
  /** The language of the reasons, which the person reads when a step is refused or asked about (default Chinese). */
  locale?: Locale | undefined;
  /**
   * What the run may reach over the network from its shell (Rule of Two, docs/plans/harness-1125.md §3): `none` for a run that reads
   * untrusted content (every network command refused), `packages` for a research run (only package installs and git clone/fetch/pull).
   * Absent: the old tripwire, no network check.
   */
  egress?: "none" | "packages" | undefined;
};

/** Lower-cased, backslashes, and `.`/`..` resolved by hand: this file ships to the browser too, so it cannot borrow node's path. */
const normalise = (value: string) => {
  const parts: string[] = [];
  for (const part of value.replace(/\//g, "\\").split("\\")) {
    if (part === "..") { if (parts.length > 1) parts.pop(); } else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("\\").toLowerCase();
};
const inside = (target: string, root: string) => {
  const a = normalise(target), b = normalise(root);
  return a === b || a.startsWith(`${b}\\`);
};

/** Paths a person keeps credentials, keys and sessions in. Reading or writing any of them is refused, whatever the task. */
const SECRET_PATH = [
  /[\\/]\.ssh([\\/]|$)/i, /[\\/]\.aws([\\/]|$)/i, /[\\/]\.gnupg([\\/]|$)/i, /[\\/]\.kube([\\/]|$)/i, /[\\/]\.azure([\\/]|$)/i,
  /[\\/]\.docker[\\/]config\.json/i, /[\\/]\.npmrc$/i, /[\\/]\.pypirc$/i, /[\\/]\.git-credentials$/i, /[\\/]\.netrc$/i,
  /[\\/]\.codex[\\/]auth\.json/i, /[\\/]\.claude[\\/]\.credentials/i, /codex-home[\\/]auth\.json/i,
  /appdata[\\/]local[\\/]google[\\/]chrome[\\/]user data/i, /appdata[\\/]local[\\/]microsoft[\\/]edge[\\/]user data/i,
  /appdata[\\/]roaming[\\/]mozilla[\\/]firefox/i, /appdata[\\/]local[\\/]bravesoftware/i,
  /appdata[\\/](local|roaming)[\\/]microsoft[\\/](credentials|protect|vault)/i,
  /\.kdbx?$/i, /keepass/i, /1password/i, /bitwarden/i, /[\\/]login data$/i, /[\\/]cookies$/i, /[\\/]web data$/i,
  /id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|pfx|p12|ppk)$/i,
  /(^|[\\/])\.env(\.[a-z0-9_-]+)?$/i,
  /[\\/]data[\\/]auth\.db/i, /[\\/]auth\.db(-wal|-shm)?$/i, /[\\/]crossline\.db(-wal|-shm)?$/i,
  // The browser profiles the person logged in with for a workflow: read only by Crossline's site reader, never by the assistant.
  /crossline[\\/]browser-profiles/i,
  // On a compute node with the shell allowed (docs/compute-node.md P3): the node's token, its own Codex sign-in and its browser profiles,
  // a linked device's node profiles, and the DPAPI secret files (the device link token among them).
  /crossline node[\\/](token\.bin|codex-home|browser-profiles)/i, /[\\/]device[\\/]node[\\/]browser-profiles/i, /[\\/]secrets[\\/][^\\/]+\.bin$/i
];
const EXAMPLE_ENV = /\.env\.(example|sample|template)$/i;

export const isSecretPath = (value: string): boolean => !EXAMPLE_ENV.test(value) && SECRET_PATH.some((pattern) => pattern.test(value));

/**
 * Where the skills a run is given live (the owner's decision of 2026-11-25, docs/plans/harness-1125.md 「Skill 供应链」): the skill library
 * Crossline writes (`…\Crossline\skill-library\<workspace>`, its `lock.json` and the quarantine beside it), the repository's own plugin
 * (`skills\marketplace\…`), and the runtime's copies of Crossline's plugins. Only the worker writes them, after its scan and review; the
 * assistant's shell and file tools may read them but never write — the hole in Hermes was a generic file tool getting round the skill
 * install's approval.
 */
const SKILL_STORE = [/(^|[\\/\s=:])skill-(library|quarantine)(?![\w.-])/i, /(^|[\\/\s=:])skills[\\/]marketplace(?![\w.-])/i,
  /[\\/]plugins[\\/]cache[\\/]crossline-(library|local)(?![\w.-])/i];
export const isSkillStorePath = (value: string): boolean => SKILL_STORE.some((pattern) => pattern.test(value));
/**
 * An 8.3 short name (`CROSSL~1`, `SKILL-~1`): a spelling of a protected folder the text patterns cannot see (review of 2026-11-25).
 * A command that writes is asked to name its paths in full; reading through one stays allowed. Text cannot follow a path built in a
 * variable: that is what the sandbox's own deny on these folders (`protectSkillFolders`) and the file-change check on real paths are for.
 */
// not-nl: a path spelling, not natural language
const SHORT_NAME = /(^|[\\/\s=:])[^\\/\s=:]{1,6}~\d(?!\d)/;
/** Commands that only read or list: the one kind that may name a skill folder. Anything else, or any redirect, is a write. */
const READ_ONLY_WORDS = new Set(["cat", "type", "gc", "get-content", "ls", "dir", "gci", "get-childitem", "head", "tail", "less", "more", "select-string", "sls",
  "findstr", "grep", "rg", "test-path", "get-item", "gi", "resolve-path", "get-filehash", "sha256sum", "shasum", "wc", "stat", "tree", "measure-object", "select-object",
  "sort-object", "where-object", "format-table", "format-list", "write-output", "echo"]);
const readsOnly = (command: string) => !/(^|[^-=<>])>/.test(command.replace(/["'`][^"'`]*["'`]/g, ""))
  && commandsIn(command).every(({ word }) => READ_ONLY_WORDS.has(word));

/** Things that publish, send, spend, or change the machine. A task can ask for none of them; the last step is the person's. */
const NEVER: Array<{ rule: string; reason: string; pattern: RegExp }> = [
  { rule: "send.mail", reason: "发送邮件由本人完成；助手只起草", pattern: /send-mailmessage|\bsendmail\b|\bsmtp\b|outlook\.application|createitem\s*\(|mailto:/i },
  { rule: "send.webhook", reason: "向聊天或通知服务发消息由本人完成", pattern: /hooks\.slack\.com|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|api\.twilio\.com|graph\.microsoft\.com\/[^ ]*\/sendmail/i },
  { rule: "publish.package", reason: "发布软件包或镜像由本人完成", pattern: /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bcargo\s+publish\b|\bgh\s+release\s+create\b/i },
  { rule: "publish.social", reason: "发帖与对外发布由本人完成", pattern: /xiaohongshu\.com\/.*(publish|post)|api\.twitter\.com\/2\/tweets|api\.x\.com\/2\/tweets|graph\.facebook\.com\/[^ ]*\/feed/i },
  { rule: "money", reason: "付款、下单与交易只能由本人完成", pattern: /\blongbridge\b|\balpaca\b|\binteractivebrokers\b|\bibkr\b|\brobinhood\b|api\.stripe\.com|paypal\.com\/v[0-9]\/payments|\/orders?\b.*\b(buy|sell)\b/i },
  { rule: "system.registry", reason: "改注册表是改系统设置", pattern: /\breg(\.exe)?\s+(add|delete|import|load|unload)\b|\bregedit\b|set-itemproperty\s+[^|]*hk(lm|cu):/i },
  { rule: "system.tasks", reason: "计划任务、服务、防火墙和启动项属于系统设置", pattern: /\bschtasks(\.exe)?\s+\/(create|change|delete)\b|register-scheduledtask|\bsc(\.exe)?\s+(create|config|delete|stop)\b|\bnetsh\b|new-netfirewallrule|set-netfirewall|\bbcdedit\b/i },
  { rule: "system.policy", reason: "执行策略、杀毒和账户设置属于系统设置", pattern: /set-executionpolicy|set-mppreference|add-mppreference|disable-windowsoptionalfeature|\bnet\s+(user|localgroup)\b|\bdiskpart\b|\bformat(\.com)?\s+[a-z]:|\bcipher\s+\/w|\bmanage-bde\b/i },
  { rule: "system.elevate", reason: "提权运行", pattern: /-verb\s+runas|\brunas\s+\/|start-process[^|]*-verb\s+runas/i },
  { rule: "download.execute", reason: "下载后直接执行", pattern: /(iwr|invoke-webrequest|curl|wget|irm|invoke-restmethod)[^|]*\|\s*(iex|invoke-expression|sh|bash|powershell|pwsh|cmd)\b|\biex\s*\(\s*(new-object|iwr|invoke-webrequest|irm)|certutil[^|]*-urlcache|bitsadmin\s+\/transfer/i }
];

/** Things that are sometimes right but not on the assistant's say-so: they go to the person. */
const ASK: Array<{ rule: string; reason: string; pattern: RegExp }> = [
  { rule: "install.global", reason: "在系统里安装软件", pattern: /\b(winget|choco|scoop)\s+(install|upgrade)\b|\bmsiexec\b|install-module|install-package|\bnpm\s+(i|install)\s+(-g|--global)\b|\bpip3?\s+install\b[^|]*--user\b|\bsetup\.exe\b/i },
  { rule: "git.remote", reason: "把东西推到远端", pattern: /\bgit\s+push\b|\bgh\s+(pr|issue)\s+(create|comment|merge|close)\b/i },
  { rule: "net.upload", reason: "向外部地址上传数据", pattern: /(invoke-restmethod|invoke-webrequest|irm|iwr)[^|]*-method\s+(post|put|patch|delete)|\bcurl\b[^|]*(-x\s*(post|put|patch|delete)|--data|\s-d\s|-f\s|--upload-file|-t\s)|\bscp\b|\bsftp\b|\bftp\b|azcopy|aws\s+s3\s+(cp|sync|mv)|rclone/i },
  { rule: "delete.recursive", reason: "递归或强制删除", pattern: /(remove-item|\brm\b|\bdel\b|\brmdir\b|\brd\b|\berase\b)[^|;&]*(-recurse|\s-r\b|\s-rf\b|\s-fr\b|\s\/s\b|-force|\*)/i },
  { rule: "move.bulk", reason: "批量移动或重命名", pattern: /(move-item|\bmv\b|\bmove\b|rename-item)[^|;&]*(\*|-recurse|-force)/i }
];

const WINDOWS_ROOT = /^[a-z]:\\?$/i;

export function decideCommand(command: string, context: GuardContext): GuardDecision {
  const t = tFor(context.locale);
  const text = command.trim();
  if (!text) return { decision: "allow", rule: "empty", reason: "" };
  // A path is a path whichever way it is written: the quoted, forward-slash and 8.3 spellings of a secret location are all caught here.
  const unquoted = text.replace(/["'`]/g, "");
  for (const token of unquoted.split(/\s+|[,;|&()<>]/).filter(Boolean)) {
    if (isSecretPath(token)) return { decision: "deny", rule: "secret.path", reason: t("「{{path}}」是凭据、密钥或会话所在的位置，不读不写", { path: token.slice(0, 80) }) };
  }
  if (isSecretPath(unquoted)) return { decision: "deny", rule: "secret.path", reason: t("命令里涉及凭据、密钥或会话所在的位置，不读不写") };
  if (isSkillStorePath(unquoted) && !readsOnly(text)) return { decision: "deny", rule: "skill.write", reason: t("skill 目录只由 Crossline 在扫描和审查之后写入，助手不能直接改") };
  if (SHORT_NAME.test(unquoted) && !readsOnly(text)) return { decision: "deny", rule: "path.short", reason: t("写入时请用完整路径，不用 8.3 短名") };
  for (const entry of NEVER) if (entry.pattern.test(text)) return { decision: "deny", rule: entry.rule, reason: t(entry.reason) };
  // Deleting from a root or from the home directory is never a task.
  if (/(remove-item|\brm\b|\bdel\b|\brmdir\b|\brd\b)[^|;&]*(-recurse|\s-r|\s\/s)/i.test(text)) {
    for (const token of unquoted.split(/\s+/)) {
      const cleaned = token.replace(/\/$/, "");
      if (WINDOWS_ROOT.test(cleaned) || /^(~|\$home|\$env:userprofile|%userprofile%)\\?\*?$/i.test(cleaned) || normalise(cleaned) === normalise(context.homeDir)) {
        return { decision: "deny", rule: "delete.root", reason: t("不删除磁盘根目录或整个用户目录") };
      }
    }
  }
  // A run with an egress limit: every network command is refused, but package installs and git clone/fetch/pull in a research run.
  // An upload or a push keeps its own rule, so the failure card still says it was an outward act.
  if (context.egress) {
    const use = networkUse(text);
    if (use === "other" || (use === "package" && context.egress === "none")) {
      const outward = ASK.find((entry) => (entry.rule === "git.remote" || entry.rule === "net.upload") && entry.pattern.test(text));
      return { decision: "deny", rule: outward?.rule ?? "net.egress", reason: t(context.egress === "none"
        ? "这次运行拿到的是别人写的内容，命令一律不联网" : "调研运行只放行安装软件包和 git 拉取，其他联网命令不放行") };
    }
  }
  for (const entry of ASK) {
    if (!entry.pattern.test(text)) continue;
    // Deleting or moving inside the task's own directory is the task's business.
    // So is one that names only relative paths: commands run in the task directory, and 「删除 skill/scripts/__pycache__」 was put
    // to the person twice in one evening (2026-10-14). Leaving it — `..`, `~`, a drive, an environment variable — still asks.
    if ((entry.rule === "delete.recursive" || entry.rule === "move.bulk")
      && (mentionsOnly(withoutShell(unquoted), [context.taskDir, ...(context.writableRoots ?? [])]) || onlyRelative(withoutShell(unquoted)))) continue;
    return { decision: "ask", rule: entry.rule, reason: t(entry.reason) };
  }
  return { decision: "allow", rule: "default", reason: "" };
}

/** The runtime spells out the shell it runs a command in (`C:\Windows\…\powershell.exe -Command …`); that path is not a target. */
const withoutShell = (command: string) => command.replace(/^\s*[a-z]:[\\/][^\s]*?[\\/](powershell|pwsh|cmd)(\.exe)?\s+((-|\/)\w+\s+)*/i, "");

/** Commands that reach the network whatever their arguments. */
const NET_COMMANDS = new Set(["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "start-bitstransfer", "bitsadmin", "ssh", "scp", "sftp",
  "ftp", "tftp", "nc", "ncat", "netcat", "telnet", "socat", "rsync", "test-netconnection", "tnc", "resolve-dnsname", "nslookup", "ping", "aria2c", "http",
  "https", "xh", "gh", "az", "aws", "gcloud", "gsutil", "rclone", "azcopy", "npx", "pnpx", "bunx", "uvx", "pipx", "install-module", "install-package",
  "save-module", "find-module", "install-psresource", "winget", "choco", "scoop"]);
const URL_OPENERS = new Set(["start", "start-process", "saps", "explorer", "xdg-open", "open", "rundll32", "msedge", "chrome", "firefox", "certutil"]);
const INTERPRETERS = new Set(["python", "python3", "py", "pythonw", "node", "deno", "bun", "ruby", "perl", "php"]);
/** Code that opens a connection, in a one-liner or a here-string handed to an interpreter (quotes already removed). */
const NET_CODE = /\b(urllib[23]?|requests|httpx|aiohttp|http\.client|httplib|socket|websockets?|ftplib|smtplib|paramiko|pycurl|urlopen|selenium|playwright|puppeteer|axios|node-fetch|undici)\b|\bfetch\s*\(|\brequire\s*\(\s*(node:)?(https?|net|dgram|tls|dns|http2)\s*\)|\b(from|import)\s*\(?\s*(node:)?(https?|net|dgram|tls|dns|http2)\b|\bhttps?\.(get|request)\s*\(|\bnet\.(connect|createconnection)\b|net::http|lwp::|open-uri|file_get_contents\s*\(\s*https?:/i;
/** .NET's own network classes, reachable from any PowerShell line. */
const NET_DOTNET = /\bnet\.webclient\b|system\.net\.(webclient|http|sockets|webrequest|httpwebrequest)|\[net\.(webclient|http|sockets|webrequest)|\bhttpclient\b|\b(download|upload)(string|file|data)(async)?\b|webrequest\]::create/i;
/** A command whose text cannot be read is not one the guard can say stays offline. */
const ENCODED = /\s-(e|ec|enc|encodedcommand)\s+[a-z0-9+/=]{16,}/i;

/** Each command in a line (split at separators, blocks and subexpressions) as its program name and the rest. */
function commandsIn(command: string): Array<{ word: string; args: string[]; raw: string }> {
  return withoutShell(command.replace(/["'`]/g, "")).split(/\r?\n|[;|&{}()]|\$\(/).map((segment) => {
    const cleaned = segment.trim().replace(/^(\$[\w:]+\s*=\s*)+/, "").replace(/^[&.]\s+/, "")
      .replace(/^(cmd(\.exe)?\s+\/[ck]\s+|(powershell|pwsh)(\.exe)?\s+(-\w+\s+)*)/i, "");
    const [first = "", ...args] = cleaned.split(/\s+/).filter(Boolean);
    const word = first.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
    return { word, args, raw: segment };
  }).filter((entry) => entry.word);
}

/** The subcommand of a package manager or git: its first argument that is not a flag (git's `-C dir`/`-c key=value` skipped). */
const subcommand = (args: string[]): string[] => {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (/^-[cC]$/.test(args[i]!)) { i += 1; continue; }
    if (!args[i]!.startsWith("-")) rest.push(args[i]!.toLowerCase());
  }
  return rest;
};

/**
 * Whether a command reaches the network, and how (docs/plans/harness-1125.md §3): `package` for installing packages or pulling with git
 * (what a research run may do), `other` for anything else that connects, undefined when nothing in it is known to. A script run by name
 * (`python plot.py`) is not read: that is the sandbox's part, and without one the run's audit says the guard is all there is.
 */
export function networkUse(command: string): "package" | "other" | undefined {
  const text = command.replace(/["'`]/g, "");
  if (NET_DOTNET.test(text) || ENCODED.test(text)) return "other";
  const commands = commandsIn(command);
  let use: "package" | undefined;
  // The code an interpreter may run: every line but the package and git commands (`pip install requests` names a package, not a connection).
  let code = withoutShell(text);
  for (const { word, args, raw } of commands) {
    const sub = subcommand(args);
    const module = INTERPRETERS.has(word) ? args.indexOf("-m") : -1;
    if (["pip", "pip3", "uv", "npm", "pnpm", "yarn", "git", "conda", "mamba", "micromamba", "gem", "cargo", "go"].includes(word)
      || (module >= 0 && /^pip3?$/i.test(args[module + 1] ?? ""))) code = code.replace(raw, " ");
    if (NET_COMMANDS.has(word)) return "other";
    if (URL_OPENERS.has(word) && args.some((arg) => /^(https?|ftp):\/\//i.test(arg) || /-urlcache/i.test(arg))) return "other";
    const pip = word === "pip" || word === "pip3" ? sub
      : module >= 0 && /^pip3?$/i.test(args[module + 1] ?? "") ? subcommand(args.slice(module + 2))
      : word === "uv" && sub[0] === "pip" ? sub.slice(1) : undefined;
    if (pip) {
      if (pip[0] === "install") use = "package";
      else if (["download", "wheel", "index", "search"].includes(pip[0] ?? "")) return "other";
      continue;
    }
    if (word === "uv") {
      if (["add", "sync"].includes(sub[0] ?? "")) use = "package";
      else if (["lock", "tool", "publish", "python"].includes(sub[0] ?? "")) return "other";
      continue;
    }
    if (word === "npm" || word === "pnpm" || word === "yarn") {
      if (!sub.length && word === "yarn") use = "package";
      else if (["install", "i", "add", "ci"].includes(sub[0] ?? "")) use = "package";
      else if (["update", "up", "upgrade", "dlx", "exec", "x", "create", "init", "view", "info", "show", "search", "login", "adduser", "whoami", "outdated", "audit", "fetch", "dedupe"].includes(sub[0] ?? "")) return "other";
      continue;
    }
    if (word === "git") {
      if (["clone", "fetch", "pull"].includes(sub[0] ?? "")) use = "package";
      else if (["push", "ls-remote", "send-email", "request-pull"].includes(sub[0] ?? "") || (sub[0] === "remote" && sub[1] === "update")
        || (sub[0] === "submodule" && sub[1] === "update") || (sub[0] === "archive" && args.some((arg) => /^--remote/.test(arg)))) return "other";
      continue;
    }
    if (["conda", "mamba", "micromamba", "gem", "cargo", "go"].includes(word)
      && ["install", "create", "update", "add", "fetch", "search", "get", "download", "publish"].includes(sub[0] ?? "")) return "other";
    if (word === "go" && sub[0] === "mod" && sub[1] === "download") return "other";
  }
  if (commands.some(({ word }) => INTERPRETERS.has(word)) && NET_CODE.test(code)) return "other";
  return use;
}

/** No path in the command can leave the working directory: no drive, root, UNC, home, environment variable, parent or wildcard-only target. */
function onlyRelative(command: string): boolean {
  return !/[a-z]:[\\/]|(^|[\s='"(])[\\/]|~|\$env:|\$home|%[a-z_]+%|\.\.|(^|[\s;|&])(cd|set-location|push-location|sl|pushd)\b/i.test(command)
    && !/(remove-item|\brm\b|\bdel\b|\brmdir\b|\brd\b|\berase\b|move-item|\bmv\b|\bmove\b)\s+(-\S+\s+)*\*(\s|$)/i.test(command);
}

/** Whether every absolute path in the command lies inside one of the roots (and there is at least one). */
function mentionsOnly(command: string, roots: string[]): boolean {
  const paths = command.match(/[a-z]:\\[^\s;|&"']+/gi) ?? [];
  return paths.length > 0 && paths.every((path) => roots.some((root) => inside(path, root)));
}

/** Whether a script's own text opens a connection (a `run.*` the worker is about to re-run without the network). */
export function codeUsesNetwork(source: string): boolean {
  const text = source.replace(/["'`]/g, "");
  return NET_CODE.test(text) || NET_DOTNET.test(text) || /\b(invoke-webrequest|invoke-restmethod|iwr|irm|start-bitstransfer|curl|wget)\b/i.test(text);
}

/**
 * The machine owner's shell runs, classified at dispatch by what they are handed (Rule of Two, docs/plans/harness-1125.md §3). Every such
 * run holds the person's private data, so it may have at most one of untrusted content and the network:
 * - `untrusted-input` — handed a mail's text, a watched page, a site read behind the person's login, or a downloaded or saved web file:
 *   no egress at all, web search off;
 * - `research` — everything else: web search from the cache, network commands only to install packages or pull with git.
 */
export type AgentRunProfile = "untrusted-input" | "research";
export type RunIsolation = { profile: AgentRunProfile; egress: "none" | "packages"; webSearch: "disabled" | "cached"; untrusted: string[] };
/** Files that are someone else's words: mail and saved web pages. */
const UNTRUSTED_FILE = /\.(eml|msg|mbox|html?|mhtml?|webarchive|url)$/i;
export function classifyAgentRun(run: { inputs: string[]; homeDir: string; untrusted?: string[] }): RunIsolation {
  const downloads = `${normalise(run.homeDir)}\\downloads`;
  const untrusted = new Set(run.untrusted ?? []);
  for (const input of run.inputs) {
    if (inside(input, downloads)) untrusted.add("download");
    else if (UNTRUSTED_FILE.test(input)) untrusted.add(/\.(eml|msg|mbox)$/i.test(input) ? "mail" : "page");
  }
  return untrusted.size
    ? { profile: "untrusted-input", egress: "none", webSearch: "disabled", untrusted: [...untrusted] }
    : { profile: "research", egress: "packages", webSearch: "cached", untrusted: [] };
}

/**
 * What enforces the owner's shell on this computer (docs/plans/harness-1125.md §9.1): Codex's MXC Windows sandbox, the legacy elevated
 * Windows sandbox someone already set up, or nothing but the guard.
 */
export type ShellSandbox = "mxc" | "elevated" | "guard-only";
/**
 * Reads the runtime's `windowsSandbox/readiness` (a runtime launched with `features.prefer_mxc=true`) and the configured `windows.sandbox`.
 * With no legacy backend configured, `ready` can only mean MXC (an unconfigured legacy sandbox reports `notConfigured`). With `elevated`
 * configured, `ready` means MXC or a finished elevated setup — both real sandboxes, recorded as the weaker one. With `unelevated`, `ready`
 * says nothing (that backend blocks the network only through proxy variables), so it counts as none.
 */
export function shellSandboxFrom(readiness: string | undefined, configured: string | undefined): Exclude<ShellSandbox, "guard-only"> | undefined {
  if (readiness !== "ready") return undefined;
  if (configured === undefined || configured === "mxc") return "mxc";
  return configured === "elevated" ? "elevated" : undefined;
}
/**
 * The owner's decision of 2026-11-25 (docs/plans/harness-1125.md §9.1): with a sandbox, the run keeps its profile and the sandbox enforces
 * it. Without one, a run handed untrusted content is refused, and a research run goes on with no network from its shell at all (`egress:
 * "none"`, the guard alone) — it then neither uses the network nor reads untrusted content.
 */
export function decideShellIsolation(run: RunIsolation, sandbox: Exclude<ShellSandbox, "guard-only"> | undefined):
  { ok: true; isolation: RunIsolation; sandbox: ShellSandbox } | { ok: false } {
  if (sandbox) return { ok: true, isolation: run, sandbox };
  if (run.profile === "untrusted-input") return { ok: false };
  return { ok: true, isolation: { ...run, egress: "none" }, sandbox: "guard-only" };
}

/** A change the agent wants to make to files: confined to the task's own directories. */
export function decideFileChange(paths: string[], context: GuardContext): GuardDecision {
  const t = tFor(context.locale);
  const roots = [context.taskDir, ...(context.writableRoots ?? [])];
  for (const path of paths) {
    if (isSecretPath(path)) return { decision: "deny", rule: "secret.path", reason: t("「{{path}}」是凭据、密钥或会话所在的位置", { path: path.slice(0, 80) }) };
    // Even inside a writable root (a worktree of the Crossline repository holds `skills\marketplace`).
    if (isSkillStorePath(path)) return { decision: "deny", rule: "skill.write", reason: t("skill 目录只由 Crossline 在扫描和审查之后写入，助手不能直接改") };
    if (!roots.some((root) => inside(path, root))) {
      return { decision: "deny", rule: "write.outside", reason: t("只能写任务自己的目录；「{{path}}」在外面。需要改原文件时，把改动做成补丁放在任务目录里，由你合并", { path: path.slice(0, 80) }) };
    }
  }
  return { decision: "allow", rule: "write.inside", reason: "" };
}

const READ_ONLY_TOOL = /^(list|get|search|read|fetch|query|describe|find|lookup|view|show|count|check|download_file_content)([_-]|$)/i;
const SENDS = /send|reply|forward|post|publish|share|invite|respond/i;

/** An MCP tool call: reading is allowed, sending is refused, and anything else — including a tool nobody recognises — goes to the person. */
export function decideMcpTool(server: string, tool: string, locale?: Locale): GuardDecision {
  const t = tFor(locale);
  if (SENDS.test(tool)) return { decision: "deny", rule: "mcp.send", reason: t("「{{server}}」的 {{tool}} 会对外发送，只能由本人完成", { server, tool }) };
  if (READ_ONLY_TOOL.test(tool)) return { decision: "allow", rule: "mcp.read", reason: "" };
  return { decision: "ask", rule: "mcp.write", reason: t("「{{server}}」的 {{tool}} 可能会改动账号数据", { server, tool }) };
}

/**
 * Whether a command stays inside the given folders (docs/plans/remote-control-1122.md §7.1, 「会话文件夹内自动」): every drive path in it lies
 * inside one of them, and it names nothing that could point elsewhere — no home, environment variable, parent, UNC or root path, no change
 * of directory. URLs are not paths. A command with no path at all stays where it runs, which is the session's folder.
 */
export function confinedTo(command: string, roots: string[]): boolean {
  const text = withoutShell(command.replace(/["'`]/g, "")).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
  if (/~|\$env:|\$home|%[a-z_]+%|\.\.|(^|[\s=(])\\\\|(^|[\s='"(])\/|(^|[\s;|&])(cd|chdir|set-location|push-location|sl|pushd)\b/i.test(text)) return false;
  const paths = text.match(/[a-z]:[\\/][^\s;|&"'()]*/gi) ?? [];
  return roots.length > 0 && paths.every((path) => roots.some((root) => inside(path, root)));
}
