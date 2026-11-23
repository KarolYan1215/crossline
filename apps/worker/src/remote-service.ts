import { randomUUID } from "node:crypto";
import { NODE_STATUS_SETTING, REMOTE_COMMAND, REMOTE_KINDS, type RemoteKind } from "@crossline/core";
import { readFormRuns, type CrosslineStore } from "@crossline/db";
import { tOfWorkspace } from "./locale";
import type { NodeEntry, NodeHub, NodeRemoteLink } from "./node/hub";

/**
 * The hosted worker's part in remote control from the phone (docs/plans/remote-control-1122.md): it carries the phone's signed
 * instructions to the person's computer and the computer's reports back, keeps the record (`remote.*` events, shown on the 「这台电脑」
 * page), and pushes the one thing that needs the person now — a command waiting for their 「执行」. It decides nothing about what runs:
 * the computer checks every signature and judges every command itself. It refuses early what it can (an offline computer, a paid form),
 * but the computer never relies on that.
 *
 * Nothing waits for an offline computer: an instruction to one is refused here (`REMOTE_OFFLINE`), and the phone can ask to be told when
 * it comes back (§8). Signed instructions expire in five minutes on their own.
 */
export type RemoteServiceDeps = {
  store: CrosslineStore;
  hub: () => NodeHub | undefined;
  push: (workspaceId: string, message: { title: string; body: string; path: string; tag: string }) => Promise<boolean>;
  /** The registration forms (form-service.ts): a fresh masked picture for the phone, and the pass that notices the submission. */
  forms?: { handle: (method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined) => Promise<{ status: number; body: unknown } | undefined>; pass: (workspaceId: string) => Promise<void> };
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
};

/** 「电脑上线时通知我」: kept per workspace until the computer comes back or the person turns it off. */
export const REMOTE_NOTIFY_SETTING = "remote.notify_online";
/** The record shown on the phone covers ninety days (§7.3); deleting the account deletes it with the workspace. */
const SHOWN_DAYS = 90;

/** What a computer's report becomes in the ledger; reports not listed (a streamed piece of text, a command starting) are live only. */
const LEDGER_TYPES: Record<string, string> = {
  "session.started": "remote.session.started", "session.ended": "remote.session.ended", "message.person": "remote.message", "message.assistant": "remote.message",
  "command.completed": "remote.command", "approval.asked": "remote.approval", "approval.resolved": "remote.approval", "approval.refused": "remote.approval",
  "approval.expired": "remote.approval", "files.changed": "remote.files", "folder.read": "remote.folder.read", "form.submitted": "remote.form.submitted",
  "refused": "remote.refused", "interrupted": "remote.session.interrupted"
};
export const REMOTE_EVENT_TYPES = [...new Set(Object.values(LEDGER_TYPES))];

type Live = { session?: { id: string; folder: string; approval: string; endsAt: string } | undefined; busy: boolean; draft: string; running?: string | undefined;
  pending: Map<string, Record<string, unknown>>; updatedAt: string };

/** How long the computer may take to answer each kind of instruction. */
const TIMEOUT_MS: Partial<Record<RemoteKind, number>> = { command: REMOTE_COMMAND.timeoutMs + 60_000, "session.start": 120_000, "folder.read": 180_000, "form.submit": 120_000 };

export function createRemoteService(deps: RemoteServiceDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const live = new Map<string, Live>();
  const liveOf = (workspaceId: string, host: string) => {
    const key = `${workspaceId}\n${host}`;
    let value = live.get(key);
    if (!value) { value = { busy: false, draft: "", pending: new Map(), updatedAt: now().toISOString() }; live.set(key, value); }
    return value;
  };
  const owner = (workspaceId: string) => store.getWorkspaceOwnerId(workspaceId) ?? "system";
  const record = (workspaceId: string, type: string, entityId: string, payload: Record<string, unknown>) =>
    store.appendEvent({ ownerId: owner(workspaceId), workspaceId, type, entityId, idempotencyKey: `${type}:${randomUUID()}`, payload });

  const links = (workspaceId: string): NodeRemoteLink[] => { try { return deps.hub()?.remoteFor(workspaceId) ?? []; } catch { return []; } };
  const linkFor = (workspaceId: string, host: unknown) => {
    const all = links(workspaceId);
    return typeof host === "string" && host ? all.find((link) => link.host === host) : all[0];
  };

  /** A report from a computer: kept in the record, folded into what the phone shows live, and a waiting command pushed to the phone. */
  const onEvent = (workspaceId: string, host: string, raw: Record<string, unknown>) => {
    const event: Record<string, unknown> = { ...raw, host };
    const type = String(event.type ?? "");
    const state = liveOf(workspaceId, host);
    state.updatedAt = now().toISOString();
    switch (type) {
      case "session.started": state.session = { id: String(event.session ?? ""), folder: String(event.folder ?? ""), approval: String(event.approval ?? "each"), endsAt: String(event.endsAt ?? "") }; state.busy = false; state.draft = ""; state.pending.clear(); break;
      case "session.ended": state.session = undefined; state.busy = false; state.draft = ""; state.running = undefined; state.pending.clear(); break;
      case "turn.started": state.busy = true; state.draft = ""; break;
      case "turn.completed": case "interrupted": state.busy = false; state.draft = ""; state.running = undefined; break;
      case "delta": state.draft = (state.draft + String(event.text ?? "")).slice(-32_000); break;
      case "message.assistant": state.draft = ""; break;
      case "command.started": state.running = String(event.command ?? ""); break;
      case "command.completed": state.running = undefined; break;
      case "approval.asked": state.pending.set(String(event.approval ?? ""), event); break;
      case "approval.resolved": case "approval.expired": state.pending.delete(String(event.approval ?? "")); break;
    }
    const ledgerType = LEDGER_TYPES[type];
    if (ledgerType) {
      try { record(workspaceId, ledgerType, String(event.session ?? host), { ...event, ...(type.startsWith("message.") ? { role: type === "message.person" ? "person" : "assistant" } : {}), ...(type.startsWith("approval.") ? { state: type.slice(9) } : {}) }); }
      catch (error) { log({ type: "remote.record_failed", message: String(error).slice(0, 200) }); }
    }
    // The one interruption remote control makes (push-policy: it needs the person now, and nothing runs until they answer).
    if (type === "approval.asked") {
      const t = tOfWorkspace(store, workspaceId);
      void deps.push(workspaceId, { title: t("电脑请求批准一条命令"), body: String(event.subject ?? "").slice(0, 160), path: "/computer", tag: `remote-approval-${String(event.approval ?? "")}` }).catch(() => false);
    }
  };

  /** A computer with remote control on came or went; one coming back is told to the person when they asked for it (§8). */
  const onChange = (workspaceId: string, host: string, online: boolean) => {
    if (!online) {
      const state = live.get(`${workspaceId}\n${host}`);
      if (state) { state.busy = false; state.running = undefined; state.draft = ""; }
      return;
    }
    if (store.getSetting(workspaceId, REMOTE_NOTIFY_SETTING) !== "on") return;
    store.setSetting(workspaceId, REMOTE_NOTIFY_SETTING, "off");
    const t = tOfWorkspace(store, workspaceId);
    void deps.push(workspaceId, { title: t("电脑上线了"), body: t("「{{host}}」已连上，可以从手机开始会话。", { host }), path: "/computer", tag: "remote-online" }).catch(() => false);
  };

  /** 「核对」 on the computer: this computer's instructions in the record of the last seven days (read only). */
  const ledgerFor = (workspaceId: string, host: string) => {
    const since = now().getTime() - 7 * 86_400_000;
    return store.listEvents(workspaceId, { type: REMOTE_EVENT_TYPES }).filter((event) => Date.parse(event.createdAt) >= since)
      .map((event) => ({ event, payload: (event.payload ?? {}) as Record<string, unknown> }))
      .filter(({ payload }) => payload.host === host && typeof payload.nonce === "string")
      .map(({ event, payload }) => ({ type: event.type, at: event.createdAt, nonce: String(payload.nonce), ...(typeof payload.session === "string" ? { session: payload.session } : {}) }));
  };

  /** The account's computers for the phone: those online with remote control, and those last seen with it. */
  const computers = (workspaceId: string) => {
    const online = links(workspaceId).map((link) => ({ host: link.host, role: link.role, online: true, level: link.level, phones: link.phones, folders: link.folders, transcribe: link.transcribe, forms: link.forms }));
    let nodes: NodeEntry[] = [];
    try { nodes = (JSON.parse(store.getSetting(workspaceId, NODE_STATUS_SETTING) ?? "{}") as { nodes?: NodeEntry[] }).nodes ?? []; } catch { nodes = []; }
    const offline = nodes.filter((node) => node.remote && !online.some((item) => item.host === node.host)).map((node) => ({ host: node.host, role: node.role, online: false, lastSeen: node.at }));
    return [...online, ...offline];
  };

  const history = (workspaceId: string, session?: string) => {
    const since = now().getTime() - SHOWN_DAYS * 86_400_000;
    return store.listEvents(workspaceId, { type: REMOTE_EVENT_TYPES }).filter((event) => Date.parse(event.createdAt) >= since && (!session || event.entityId === session))
      .slice(-300).map((event): Record<string, unknown> & { type: string; at: string } => ({ type: event.type, ...(event.payload as Record<string, unknown>), event: event.type, at: event.createdAt }));
  };

  const handle = async (method: string, pathname: string, workspaceId: string, body: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> => {
    if (!pathname.startsWith("/v1/remote/")) return undefined;
    const input = body ?? {};
    // Every request is a POST from the page (the supervisor hands a GET no body); what a GET would have asked is in the body.
    const query = { get: (name: string) => typeof input[name] === "string" || typeof input[name] === "number" ? String(input[name]) : undefined };
    const offline = { status: 200, body: { ok: false, code: "REMOTE_OFFLINE" } };
    if (method === "POST" && pathname === "/v1/remote/state") {
      const list = computers(workspaceId);
      const host = String(query.get("host") ?? "") || list.find((item) => item.online)?.host || list[0]?.host || "";
      const state = host ? live.get(`${workspaceId}\n${host}`) : undefined;
      const session = state?.session;
      return { status: 200, body: { ok: true, computers: list, host, notify: store.getSetting(workspaceId, REMOTE_NOTIFY_SETTING) === "on",
        live: state ? { session: session ?? null, busy: state.busy, draft: state.draft, running: state.running ?? null, pending: [...state.pending.values()] } : null,
        events: history(workspaceId, String(query.get("session") ?? "") || session?.id || undefined).filter((event) => !host || event.host === host) } };
    }
    if (method === "POST" && pathname === "/v1/remote/notify") {
      store.setSetting(workspaceId, REMOTE_NOTIFY_SETTING, input.on === true ? "on" : "off");
      return { status: 200, body: { ok: true, notify: input.on === true } };
    }
    if (method === "POST" && pathname === "/v1/remote/pair") {
      const link = linkFor(workspaceId, input.host);
      if (!link) return offline;
      if (typeof input.code !== "string" || !/^\d{8}$/.test(input.code) || typeof input.publicKey !== "string" || input.publicKey.length > 400) return { status: 200, body: { ok: false, code: "REMOTE_PAIRING_REFUSED" } };
      const answer = await link.call({ op: "pair", code: input.code, publicKey: input.publicKey, label: String(input.label ?? "").slice(0, 60) }).catch(() => undefined) as { ok?: boolean } | undefined;
      if (!answer) return offline;
      return { status: 200, body: { ...answer, host: link.host } };
    }
    if (method === "POST" && pathname === "/v1/remote/status") {
      const link = linkFor(workspaceId, query.get("host"));
      if (!link) return offline;
      const answer = await link.call({ op: "status" }, 15_000).catch(() => undefined);
      return answer ? { status: 200, body: answer } : offline;
    }
    if (method === "POST" && pathname === "/v1/remote/folders") {
      const link = linkFor(workspaceId, query.get("host"));
      if (!link) return offline;
      const answer = await link.call({ op: "folders", folder: query.get("folder") || undefined, dir: query.get("dir") ?? "", page: Number(query.get("page") ?? 0) }, 60_000).catch(() => undefined) as { ok?: boolean } | undefined;
      return answer ? { status: 200, body: answer } : offline;
    }
    if (method === "POST" && pathname === "/v1/remote/forms") {
      const forms = readFormRuns(store, workspaceId).filter((run) => run.state === "ready_to_submit")
        .map((run) => ({ id: run.id, title: run.opportunity.title, host: run.host, free: run.opportunity.cost?.amount === 0, cost: run.opportunity.cost ?? null }));
      return { status: 200, body: { ok: true, forms } };
    }
    const shot = /^\/v1\/remote\/forms\/([\w-]+)\/shot$/.exec(pathname);
    if (method === "POST" && shot) {
      if (!deps.forms) return { status: 200, body: { ok: false, code: "REMOTE_FORM_REFUSED" } };
      const answer = await deps.forms.handle("POST", `/v1/forms/${shot[1]}/remote-shot`, workspaceId, {});
      return { status: 200, body: answer?.status === 200 ? answer.body : { ok: false, code: (answer?.body as { code?: string } | undefined)?.code ?? "REMOTE_FORM_REFUSED" } };
    }
    if (method === "POST" && pathname === "/v1/remote/send") {
      const signed = input.signed as { key?: unknown; body?: unknown; sig?: unknown } | undefined;
      if (!signed || typeof signed.body !== "string" || typeof signed.key !== "string" || typeof signed.sig !== "string" || signed.body.length > 256 * 1024)
        return { status: 200, body: { ok: false, code: "REMOTE_SIGNATURE_INVALID" } };
      // Read, never trusted: only to choose the computer, the wait and the early refusals. The computer checks the signature.
      let envelope: { kind?: unknown; computer?: unknown; payload?: Record<string, unknown> };
      try { envelope = JSON.parse(signed.body) as typeof envelope; } catch { return { status: 200, body: { ok: false, code: "REMOTE_SIGNATURE_INVALID" } }; }
      const kind = (REMOTE_KINDS as readonly unknown[]).includes(envelope.kind) ? envelope.kind as RemoteKind : undefined;
      if (!kind) return { status: 200, body: { ok: false, code: "REMOTE_SIGNATURE_INVALID" } };
      const link = linkFor(workspaceId, envelope.computer);
      if (!link || link.host !== envelope.computer) return offline;
      if (kind === "form.submit") {
        const run = readFormRuns(store, workspaceId).find((item) => item.id === envelope.payload?.run);
        if (!run || run.state !== "ready_to_submit" || run.opportunity.cost?.amount !== 0) return { status: 200, body: { ok: false, code: "REMOTE_FORM_REFUSED" } };
      }
      const answer = await link.call({ op: "signed", signed: { key: signed.key, body: signed.body, sig: signed.sig } }, TIMEOUT_MS[kind] ?? 60_000).catch((error: unknown) => {
        log({ type: "remote.send_failed", kind, message: error instanceof Error ? error.message : String(error) });
        return undefined;
      }) as { ok?: boolean; code?: string } | undefined;
      if (!answer) return offline;
      if (kind === "form.submit" && answer.ok && deps.forms) void deps.forms.pass(workspaceId).catch(() => undefined);
      return { status: 200, body: answer };
    }
    return undefined;
  };

  return { handle, onEvent, onChange, ledgerFor };
}
export type RemoteService = ReturnType<typeof createRemoteService>;
