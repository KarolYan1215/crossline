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
  /[\\/]data[\\/]auth\.db/i, /[\\/]auth\.db(-wal|-shm)?$/i, /[\\/]crossline\.db(-wal|-shm)?$/i
];
const EXAMPLE_ENV = /\.env\.(example|sample|template)$/i;

export const isSecretPath = (value: string): boolean => !EXAMPLE_ENV.test(value) && SECRET_PATH.some((pattern) => pattern.test(value));

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
  const text = command.trim();
  if (!text) return { decision: "allow", rule: "empty", reason: "" };
  // A path is a path whichever way it is written: the quoted, forward-slash and 8.3 spellings of a secret location are all caught here.
  const unquoted = text.replace(/["'`]/g, "");
  for (const token of unquoted.split(/\s+|[,;|&()<>]/).filter(Boolean)) {
    if (isSecretPath(token)) return { decision: "deny", rule: "secret.path", reason: `「${token.slice(0, 80)}」是凭据、密钥或会话所在的位置，不读不写` };
  }
  if (isSecretPath(unquoted)) return { decision: "deny", rule: "secret.path", reason: "命令里涉及凭据、密钥或会话所在的位置，不读不写" };
  for (const entry of NEVER) if (entry.pattern.test(text)) return { decision: "deny", rule: entry.rule, reason: entry.reason };
  // Deleting from a root or from the home directory is never a task.
  if (/(remove-item|\brm\b|\bdel\b|\brmdir\b|\brd\b)[^|;&]*(-recurse|\s-r|\s\/s)/i.test(text)) {
    for (const token of unquoted.split(/\s+/)) {
      const cleaned = token.replace(/\/$/, "");
      if (WINDOWS_ROOT.test(cleaned) || /^(~|\$home|\$env:userprofile|%userprofile%)\\?\*?$/i.test(cleaned) || normalise(cleaned) === normalise(context.homeDir)) {
        return { decision: "deny", rule: "delete.root", reason: "不删除磁盘根目录或整个用户目录" };
      }
    }
  }
  for (const entry of ASK) {
    if (!entry.pattern.test(text)) continue;
    // Deleting or moving inside the task's own directory is the task's business.
    if ((entry.rule === "delete.recursive" || entry.rule === "move.bulk") && mentionsOnly(unquoted, [context.taskDir, ...(context.writableRoots ?? [])])) continue;
    return { decision: "ask", rule: entry.rule, reason: entry.reason };
  }
  return { decision: "allow", rule: "default", reason: "" };
}

/** Whether every absolute path in the command lies inside one of the roots (and there is at least one). */
function mentionsOnly(command: string, roots: string[]): boolean {
  const paths = command.match(/[a-z]:\\[^\s;|&"']+/gi) ?? [];
  return paths.length > 0 && paths.every((path) => roots.some((root) => inside(path, root)));
}

/** A change the agent wants to make to files: confined to the task's own directories. */
export function decideFileChange(paths: string[], context: GuardContext): GuardDecision {
  const roots = [context.taskDir, ...(context.writableRoots ?? [])];
  for (const path of paths) {
    if (isSecretPath(path)) return { decision: "deny", rule: "secret.path", reason: `「${path.slice(0, 80)}」是凭据、密钥或会话所在的位置` };
    if (!roots.some((root) => inside(path, root))) {
      return { decision: "deny", rule: "write.outside", reason: `只能写任务自己的目录；「${path.slice(0, 80)}」在外面。需要改原文件时，把改动做成补丁放在任务目录里，由你合并` };
    }
  }
  return { decision: "allow", rule: "write.inside", reason: "" };
}

const READ_ONLY_TOOL = /^(list|get|search|read|fetch|query|describe|find|lookup|view|show|count|check|download_file_content)([_-]|$)/i;
const SENDS = /send|reply|forward|post|publish|share|invite|respond/i;

/** An MCP tool call: reading is allowed, sending is refused, and anything else — including a tool nobody recognises — goes to the person. */
export function decideMcpTool(server: string, tool: string): GuardDecision {
  if (SENDS.test(tool)) return { decision: "deny", rule: "mcp.send", reason: `「${server}」的 ${tool} 会对外发送，只能由本人完成` };
  if (READ_ONLY_TOOL.test(tool)) return { decision: "allow", rule: "mcp.read", reason: "" };
  return { decision: "ask", rule: "mcp.write", reason: `「${server}」的 ${tool} 可能会改动账号数据` };
}
