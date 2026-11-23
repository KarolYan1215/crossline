import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { REMOTE_LEVELS, type RemoteLevel } from "@crossline/core/remote-control";
import { auditFile, levelOf, reconcileAudit, remoteLocalAction, remoteLocalView, type RemoteControl, type RemoteLocalAction } from "../node/remote";
import { primaryOrigin, tFor, type Locale } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";

/**
 * This computer's link to the hosted account it is a device of (docs/device-mode.md). Two files, both outside the ledger: the site's
 * address in `<data>/device/link.json` (not secret; the web app reads it to know it is a device and where to send its pages), and the
 * `device` token as a DPAPI file through the worker's secret store (only this Windows user can open it; not in any backup).
 *
 * A file rather than environment variables: the person links and unlinks from the `/device` page, without editing a start script, and the
 * token never sits in a process environment.
 */
export const DEVICE_SECRET_SLOT = "machine";
export const DEVICE_SECRET_NAME = "device-token";
export const linkFile = (dataDir: string) => path.join(dataDir, "device", "link.json");

export type DeviceLinkRecord = { url: string; label: string; linkedAt: string };
export type DeviceLink = DeviceLinkRecord & { token: string | undefined };

/** The link as written, without the token: whether this install is a device at all (the web app asks the same file). */
export function readLinkRecord(dataDir: string): DeviceLinkRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(linkFile(dataDir), "utf8")) as Partial<DeviceLinkRecord>;
    const url = typeof raw.url === "string" ? primaryOrigin(raw.url) : undefined;
    return url ? { url, label: typeof raw.label === "string" ? raw.label : hostname(), linkedAt: typeof raw.linkedAt === "string" ? raw.linkedAt : "" } : undefined;
  } catch { return undefined; }
}

/** The link with its token; `token` is undefined when the secret cannot be read (then nothing is sent and the device page says why). */
export async function readDeviceLink(dataDir: string, secrets: SecretStore): Promise<DeviceLink | undefined> {
  const record = readLinkRecord(dataDir);
  if (!record) return undefined;
  const token = await secrets.read(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME).catch(() => undefined);
  return { ...record, token: token?.trim() || undefined };
}

export type LinkCheck = { ok: true } | { ok: false; code: string; message: string };

/** Asks the site whether this token is a `device` token of an account there, before anything is kept. */
export async function checkPrimary(url: string, token: string, fetchImpl: typeof fetch = fetch, locale?: Locale): Promise<LinkCheck> {
  const t = tFor(locale);
  const response = await fetchImpl(new URL("/api/device/hello", url), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    .catch(() => undefined);
  if (!response) return { ok: false, code: "DEVICE_PRIMARY_UNREACHABLE", message: t("连不上这个地址。") };
  if (response.status === 401) return { ok: false, code: "DEVICE_TOKEN_INVALID", message: t("令牌无效或已撤销：在网页版「这台电脑」重新生成一个。") };
  if (!response.ok) return { ok: false, code: `DEVICE_PRIMARY_HTTP_${response.status}`, message: t("网页版回答 {{status}}，没有连上。", { status: response.status }) };
  return { ok: true };
}

export async function saveDeviceLink(dataDir: string, secrets: SecretStore, input: { url: string; token: string; label?: string }, now = new Date()): Promise<DeviceLinkRecord> {
  const record = { url: input.url, label: (input.label ?? hostname()).slice(0, 60), linkedAt: now.toISOString() };
  await secrets.write(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME, input.token);
  mkdirSync(path.dirname(linkFile(dataDir)), { recursive: true });
  writeFileSync(linkFile(dataDir), JSON.stringify(record, null, 2));
  return record;
}

export function clearDeviceLink(dataDir: string, secrets: SecretStore): void {
  rmSync(linkFile(dataDir), { force: true });
  rmSync(nodeFile(dataDir), { force: true });
  secrets.remove(DEVICE_SECRET_SLOT, DEVICE_SECRET_NAME);
}

/**
 * 「作为算力节点」 on this computer (docs/compute-node.md): off unless the person switched it on here, and the hosted site accepts the node
 * only when it is switched on there too. A file beside the link, for the same reason the link is one.
 */
export const nodeFile = (dataDir: string) => path.join(dataDir, "device", "node.json");
export function nodeEnabled(dataDir: string): boolean {
  try { return (JSON.parse(readFileSync(nodeFile(dataDir), "utf8")) as { enabled?: unknown }).enabled === true; } catch { return false; }
}
export function setNodeEnabled(dataDir: string, enabled: boolean, now = new Date()): void {
  if (!enabled) { rmSync(nodeFile(dataDir), { force: true }); return; }
  mkdirSync(path.dirname(nodeFile(dataDir)), { recursive: true });
  const level = nodeLevel(dataDir);
  writeFileSync(nodeFile(dataDir), JSON.stringify({ enabled: true, at: now.toISOString(), ...(level !== "off" ? { level } : {}) }, null, 2));
}
/**
 * The shell's level on this computer (docs/plans/remote-control-1122.md §7.1): 「关」, 「只从手机遥控」 or 「无人值守」 (the old
 * 「允许在这台电脑上执行命令」, docs/compute-node.md P3; a kept `shell: true` reads as it). Off unless the person set it here, and only while
 * the node is on; turning the node off forgets it. The hosted site cannot change it.
 */
export function nodeLevel(dataDir: string): RemoteLevel {
  try { const kept = JSON.parse(readFileSync(nodeFile(dataDir), "utf8")) as { enabled?: unknown; level?: unknown; shell?: unknown }; return kept.enabled === true ? levelOf(kept) : "off"; }
  catch { return "off"; }
}
/** Whether the server's own assistant may run commands here: only at 「无人值守」. */
export const nodeShell = (dataDir: string): boolean => nodeLevel(dataDir) === "unattended";
export function setNodeLevel(dataDir: string, level: RemoteLevel): void {
  if (!nodeEnabled(dataDir)) return;
  const { shell: _old, ...kept } = JSON.parse(readFileSync(nodeFile(dataDir), "utf8")) as Record<string, unknown>;
  writeFileSync(nodeFile(dataDir), JSON.stringify({ ...kept, level }, null, 2));
}

type DeviceHandle = (method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined) => Promise<{ status: number; body: unknown } | undefined>;

/**
 * `/v1/device` as a standard-mode worker serves it: never on the hosted beta, only the link (a standard worker is not a linked device, so
 * it has no compute node switch), and only for the machine owner. On the hosted server any account could otherwise have linked the
 * server itself to a site of its choosing, or written its one `device/node.json` (the review of 2026-11-03).
 */
export function standardDeviceService(handle: DeviceHandle, options: { hostedBeta: boolean; machineOwner: (workspaceId: string) => boolean }): Array<{ prefix: string; handle: DeviceHandle }> {
  if (options.hostedBeta) return [];
  return [{ prefix: "/v1/device", handle: (method, pathname, workspaceId, body) =>
    pathname === "/v1/device/link" && options.machineOwner(workspaceId) ? handle(method, pathname, workspaceId, body) : Promise.resolve(undefined) }];
}

/**
 * `/v1/device/link` on the worker's loopback port, in both modes: GET the link and what waits to be sent, POST `{url, token}` (checked
 * against the site, then kept), DELETE to unlink. Linking or unlinking calls `onChanged`, which restarts the worker into the other mode.
 */
export function createDeviceLinkService(deps: { dataDir: string; secrets: SecretStore; fetch?: typeof fetch; status?: () => unknown; nodeStatus?: () => unknown;
  /** Signs this computer's Codex in with an OpenAI API key for the compute node (never kept or logged here; Codex keeps it). */
  nodeLogin?: (apiKey: string) => Promise<{ ok: true; account: unknown } | { ok: false; message: string }>;
  onChanged: () => void;
  /** Remote control on this computer (docs/plans/remote-control-1122.md): the running node's controller and its ledger check, when on. */
  remote?: () => { control?: RemoteControl | undefined; ledger?: (() => Promise<Array<{ type: string; at: string; nonce?: string; session?: string }>>) | undefined };
  /** The workspace's language, for the answers this service words itself (docs/i18n.md). */
  localeFor?: (workspaceId: string) => Locale | undefined }) {
  return {
    async handle(method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
      const locale = workspaceId ? deps.localeFor?.(workspaceId) : undefined;
      const t = tFor(locale);
      // The compute node switch: kept, then the worker restarts so the device starts or stops offering its runtime.
      if (pathname === "/v1/device/node") {
        if (method !== "POST") return { status: 405, body: { ok: false, code: "METHOD_NOT_ALLOWED" } };
        if (!readLinkRecord(deps.dataDir)) return { status: 400, body: { ok: false, code: "DEVICE_NOT_LINKED", message: t("先连接网页版，再开启算力节点。") } };
        if (typeof body?.apiKey === "string") {
          if (!deps.nodeLogin) return { status: 400, body: { ok: false, code: "NODE_LOGIN_UNAVAILABLE", message: t("这台电脑现在不能登录。") } };
          const signed = await deps.nodeLogin(body.apiKey.trim());
          return signed.ok ? { status: 200, body: { ok: true, account: signed.account } } : { status: 400, body: { ok: false, code: "NODE_API_KEY_REFUSED", message: signed.message } };
        }
        const level = typeof body?.shell === "boolean" ? (body.shell ? "unattended" : "off") : (REMOTE_LEVELS as readonly unknown[]).includes(body?.level) ? body!.level as RemoteLevel : undefined;
        if (level) {
          if (!nodeEnabled(deps.dataDir)) return { status: 400, body: { ok: false, code: "NODE_NOT_ENABLED", message: t("先开启算力节点。") } };
          // A level change ends every session from the phone at once (§7.2), then the worker restarts the node at the new level.
          if (level !== nodeLevel(deps.dataDir)) { deps.remote?.().control?.stopAll("level"); setNodeLevel(deps.dataDir, level); deps.onChanged(); }
          return { status: 200, body: { ok: true, enabled: true, level, shell: level === "unattended" } };
        }
        const enabled = body?.enabled === true;
        if (enabled !== nodeEnabled(deps.dataDir)) { setNodeEnabled(deps.dataDir, enabled); deps.onChanged(); }
        return { status: 200, body: { ok: true, enabled } };
      }
      // Remote control, set only here on this computer (§5.1, §7.1–§7.3): phones, the session folders, transcription, the audit log.
      if (pathname === "/v1/device/remote") {
        const dir = path.join(deps.dataDir, "device");
        const live = deps.remote?.();
        const view = () => ({ ok: true, level: nodeLevel(deps.dataDir), ...remoteLocalView(dir), session: live?.control?.status().session ?? null, auditFile: auditFile(dir) });
        if (method === "GET") return { status: 200, body: view() };
        if (method !== "POST") return { status: 405, body: { ok: false, code: "METHOD_NOT_ALLOWED" } };
        if (body?.disconnect === true) { live?.control?.stopAll("computer"); return { status: 200, body: view() }; }
        if (body?.check === true) {
          if (!live?.ledger) return { status: 200, body: { ok: false, code: "NODE_NOT_CONNECTED", message: t("电脑没有连上网页版，现在不能核对。") } };
          const events = await live.ledger().catch(() => undefined);
          if (!events) return { status: 200, body: { ok: false, code: "NODE_NOT_CONNECTED", message: t("电脑没有连上网页版，现在不能核对。") } };
          return { status: 200, body: { ...view(), missing: reconcileAudit(dir, events), checked: events.length } };
        }
        const action = body?.pair === "start" || body?.pair === "cancel" ? { pair: body.pair } : typeof body?.confirm === "string" ? { confirm: body.confirm }
          : typeof body?.remove === "string" ? { remove: body.remove } : Array.isArray(body?.folders) ? { folders: body.folders } : typeof body?.transcribe === "boolean" ? { transcribe: body.transcribe } : undefined;
        if (!action) return { status: 200, body: { ok: false, code: "REMOTE_ACTION_UNKNOWN" } };
        if (action && "pair" in action && action.pair === "start" && nodeLevel(deps.dataDir) === "off") return { status: 200, body: { ok: false, code: "REMOTE_DISABLED", message: t("先把「在这台电脑上执行命令」设为「只从手机遥控」或「无人值守」。") } };
        const done = remoteLocalAction(dir, action as RemoteLocalAction);
        if (!done.ok) return { status: 200, body: { ok: false, code: done.code, message: t(done.message) } };
        // A phone removed mid-session: its session ends with it.
        if ("remove" in action && live?.control?.status().session) live.control.stopAll("phone_removed");
        return { status: 200, body: view() };
      }
      if (pathname !== "/v1/device/link") return undefined;
      if (method === "GET") {
        const link = await readDeviceLink(deps.dataDir, deps.secrets);
        return { status: 200, body: { ok: true, linked: Boolean(link), ...(link ? { url: link.url, label: link.label, linkedAt: link.linkedAt, tokenReadable: Boolean(link.token) } : {}),
          ...(deps.status ? { device: deps.status() } : {}),
          node: { enabled: nodeEnabled(deps.dataDir), shell: nodeShell(deps.dataDir), level: nodeLevel(deps.dataDir), ...(deps.nodeStatus ? { status: deps.nodeStatus() } : {}) } } };
      }
      if (method === "POST") {
        const url = typeof body?.url === "string" ? primaryOrigin(body.url) : undefined;
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        if (!url) return { status: 400, body: { ok: false, code: "DEVICE_URL_INVALID", message: t("地址要以 https:// 开头，例如 https://app.crossline.lol。") } };
        if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { status: 400, body: { ok: false, code: "DEVICE_TOKEN_INVALID", message: t("令牌格式不对：复制网页版显示的整串字符。") } };
        const checked = await checkPrimary(url, token, deps.fetch, locale);
        if (!checked.ok) return { status: 400, body: checked };
        const record = await saveDeviceLink(deps.dataDir, deps.secrets, { url, token });
        deps.onChanged();
        return { status: 200, body: { ok: true, linked: true, ...record, restarting: true } };
      }
      if (method === "DELETE") {
        const was = readLinkRecord(deps.dataDir);
        clearDeviceLink(deps.dataDir, deps.secrets);
        if (was) deps.onChanged();
        return { status: 200, body: { ok: true, linked: false, restarting: Boolean(was) } };
      }
      return { status: 405, body: { ok: false, code: "METHOD_NOT_ALLOWED" } };
    }
  };
}
