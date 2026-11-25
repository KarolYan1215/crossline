import { homedir, hostname } from "node:os";
import path from "node:path";
import type { SecretStore } from "@crossline/connectors";
import type { CrosslineStore } from "@crossline/db";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, DEVICE_IDEMPOTENCY_HEADER, tFor } from "@crossline/core";
import { localeOf } from "../locale";
import { createActivityTracker } from "../activity-recorder";
import { createWindowsActivitySource } from "../activity-source";
import { agentHistoryPass } from "../agent-history";
import { extractText } from "../extract";
import { gitRepos, privacyOf, readGitSeen, readNewCommits, saveGitSeen } from "../git-commits";
import { runtimeOwner } from "../owner";
import { recordingPass, recordingsOn, transcribeConcurrency } from "../recordings";
import { addFolder, folderFileBytes, importScreenedFiles, listFolderEntries, personNames, readFolderFile, previewFolder, removeFolder, setFolderLines, setFolderRules, syncFolders, type ScreenListed } from "../source-folders";
import { createTranscriber, createWhisperEngine, modelsDirectory } from "../transcribe";
import { startNodeAgent } from "../node/agent";
import { createNodeBrowsers } from "../node/browser";
import { localAppServer } from "../node/local-runtime";
import { loginNodeWithApiKey, readNodeAccount, type NodeAccount } from "../node/control";
import { createDeviceLinkService, nodeEnabled, nodeLevel, type DeviceLink } from "./link";
import { REMOTE_READ_MAX_BYTES } from "@crossline/core/remote-control";
import type { RemoteHooks } from "../node/remote";
import { MIRROR_INTERVAL_MS, mirrorPass } from "./mirror";
import { DEVICE_PASSES } from "./mode";
import { createOutbox, type OutboxItem, type SendResult } from "./outbox";
import { activityItem, commitItems, readDeviceState, recordingItems, reviveDocuments, sourceItems, tooLargeForSite, writeDeviceState, type QueuedItem } from "./payloads";
import { startDeviceServer } from "./server";

/**
 * The worker of a linked device (docs/device-mode.md). It reads this machine — screen activity, idle stretches, input rhythm, authorized
 * folders, local recordings, the coding-agent time summary — into the local staging ledger, exactly as the full worker does, and sends
 * the results to the hosted site through the outbox. It starts no Codex, runs no model and touches no plan: none of the full worker's
 * model passes is imported here (`device-mode.test.ts` checks the imports).
 */
export type DeviceWorkerOptions = {
  store: CrosslineStore;
  dataDir: string;
  secrets: SecretStore;
  link: DeviceLink;
  port: number;
  capabilitySecret: string | undefined;
  intervalMinutes: number;
  /** Called every pass: the worker lock's heartbeat. */
  beat: () => void;
  /** Leaves the process so the keeper loop starts it again in the other mode. */
  restart: () => void;
  runOnce?: boolean;
  fetch?: typeof fetch;
};

const log = (record: Record<string, unknown>) => console.info(JSON.stringify(record));

export async function runDeviceWorker(options: DeviceWorkerOptions): Promise<void> {
  const { store, dataDir, link } = options;
  const deviceDir = path.join(dataDir, "device");
  const fetchImpl = options.fetch ?? fetch;
  const label = hostname().slice(0, 60);
  const owner = runtimeOwner(store);
  log({ type: "device.started", primary: link.url, passes: DEVICE_PASSES, workspaceId: owner ?? null, tokenReadable: Boolean(link.token) });

  const send = async (item: OutboxItem): Promise<SendResult> => {
    if (!link.token) return { status: 401, body: { code: "DEVICE_TOKEN_UNREADABLE" } };
    const response = await fetchImpl(new URL(item.route, link.url), { method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${link.token}`, [DEVICE_IDEMPOTENCY_HEADER]: item.id, "x-crossline-device": label },
      body: JSON.stringify(item.body) });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  const outbox = createOutbox(path.join(deviceDir, "outbox"), { send });
  const state = readDeviceState(deviceDir);
  const queue = (items: QueuedItem[]) => {
    for (const item of items) outbox.enqueue(item);
    writeDeviceState(deviceDir, state);
  };
  // A folder batch the site refused for its size gives its documents back to the next pass, which sends them in batches that fit.
  const revive = () => {
    const revived = reviveDocuments(state, outbox.takeDead(tooLargeForSite));
    if (revived) { writeDeviceState(deviceDir, state); log({ type: "device.documents_revived", revived }); }
  };
  revive();
  const flush = () => outbox.flush().then((stats) => { revive(); if (stats.blocked || stats.lastError) log({ type: "device.outbox", ...stats }); return stats; })
    .catch((error: unknown) => log({ type: "device.outbox_failed", message: error instanceof Error ? error.message : String(error) }));

  // Screen activity: the same reader and tracker the full worker uses, for this machine's own workspace only.
  const intervalSeconds = Math.max(5, Number(process.env.CROSSLINE_ACTIVITY_INTERVAL_SECONDS) || 60);
  const tracker = createActivityTracker(store, () => owner ? [owner] : [], intervalSeconds);
  const source = createWindowsActivitySource({ intervalSeconds });
  let lastIdle: { idleMs: number; at: number } | undefined;
  if (!options.runOnce) source.start((reading) => { lastIdle = { idleMs: reading.idleMs, at: Date.now() }; tracker.handle(reading); });
  process.on("exit", () => source.stop());

  // Recordings: transcribed here, offline, once the person agreed to the model download; only the text is sent.
  const transcriber = createTranscriber({ ...createWhisperEngine(modelsDirectory(dataDir)), modelsDir: modelsDirectory(dataDir) });
  let transcribing = false;
  const transcribe = async () => {
    if (!owner || transcribing || !recordingsOn(store, owner)) return;
    transcribing = true;
    try {
      const outcomes = await recordingPass(store, owner, { transcriber, dataDir, timeZone: process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago",
        ...(process.env.CROSSLINE_TRANSCRIBE_LANGUAGE?.trim() ? { language: process.env.CROSSLINE_TRANSCRIBE_LANGUAGE.trim() } : {}),
        idleMs: () => lastIdle && Date.now() - lastIdle.at < 5 * 60_000 ? lastIdle.idleMs + (Date.now() - lastIdle.at) : undefined,
        modelNeeded: (waiting) => { state.modelNeeded = waiting; writeDeviceState(deviceDir, state); } }, transcribeConcurrency()).catch(() => []);
      if (outcomes.length) {
        log({ type: "device.recordings", outcomes });
        queue(recordingItems(store, owner, state));
        void flush();
      }
    } finally { transcribing = false; }
  };

  // On demand (D3): what a folder held when it was authorized is listed, screened by the site's model and only then read in; what is
  // written there afterwards is read as it arrives (source-folders.ts `importScreenedFiles`).
  const folderDeps = (workspaceId: string) => ({ dataDir, home: homedir(), readText: extractText, audio: recordingsOn(store, workspaceId), onDemand: true });
  const screen: ScreenListed = async (folder, files) => {
    if (!link.token) return undefined;
    const response = await fetchImpl(new URL("/api/device/folder-screen", link.url), { method: "POST", signal: AbortSignal.timeout(180_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${link.token}`, "x-crossline-device": label },
      body: JSON.stringify({ folder, files }) }).catch(() => undefined);
    if (!response?.ok) return undefined;
    const answer = await response.json().catch(() => undefined) as { ok?: boolean; keep?: unknown } | undefined;
    if (answer?.ok && Array.isArray(answer.keep)) return answer.keep.filter((item): item is string => typeof item === "string");
    return answer?.ok === false ? "unavailable" : undefined;
  };
  let readingFolders = false;
  const folders = async () => {
    if (!owner || readingFolders) return;
    readingFolders = true;
    try {
      const outcomes = await syncFolders(store, owner, folderDeps(owner)).catch(() => []);
      const screened = await importScreenedFiles(store, owner, folderDeps(owner), screen).catch(() => 0);
      if (outcomes.some((item) => item.read || item.removed) || screened) log({ type: "device.folders_read", outcomes, screened });
      queue(sourceItems(store, owner, state));
      void flush();
      void transcribe();
    } finally { readingFolders = false; }
  };

  const activity = () => {
    if (!owner) return;
    const item = activityItem(store, owner, state);
    if (item) queue([item]);
  };

  const history = async () => {
    if (!owner || store.getSetting(owner, AGENT_HISTORY_CONSENT) !== "on") return;
    const updatedAt = (JSON.parse(store.getSetting(owner, AGENT_HISTORY_SUMMARY) ?? "{}") as { updatedAt?: string }).updatedAt;
    if (updatedAt && Date.now() - Date.parse(updatedAt) < 6 * 3_600_000) return;
    await agentHistoryPass(store, [owner], dataDir, () => process.env.CROSSLINE_TIME_ZONE ?? "America/Chicago").catch(() => 0);
  };

  // Commits of the repositories the person authorized here (docs/plans/execution-gates-1124.md J1): ids, times, subjects and file names,
  // masked before they are queued; what was seen is kept only once they are in the outbox.
  const commits = async () => {
    if (!owner) return;
    const repos = gitRepos(store, owner);
    if (!repos.length) return;
    const read = await readNewCommits(repos, readGitSeen(store, owner), privacyOf(store, owner));
    queue(commitItems(read.commits));
    saveGitSeen(store, owner, read.seen);
    if (read.commits.length) log({ type: "device.commits", commits: read.commits.length });
  };

  // What a phone may reach here besides sessions (docs/plans/remote-control-1122.md §6.3–§6.4): this computer's authorised folders, read
  // under the same rules as the walk, and its transcriber. Both belong to the machine's owner only.
  const remoteHooks: RemoteHooks = {
    folders: {
      list: async (folder, dir, page) => owner ? listFolderEntries(store, owner, folder, dir, page) : { ok: false, message: "no owner" },
      read: async (folder, relative, as) => {
        if (!owner) return { ok: false, message: "no owner" };
        if (as === "file") return folderFileBytes(store, owner, folder, relative, REMOTE_READ_MAX_BYTES);
        const read = await readFolderFile(store, owner, folderDeps(owner), folder, relative);
        if (!read.ok) return read;
        // 「存进 Crossline」: the document is in the local ledger now and goes to the site with the next batch.
        if (as === "save") { queue(sourceItems(store, owner, state)); void flush(); }
        const text = read.doc.extractedText ?? "";
        return { ok: true, name: read.doc.fileName || relative, size: Buffer.byteLength(text), text: text.slice(0, 64 * 1024) };
      }
    },
    transcribe: async (bytes, name) => {
      const outcome = await transcriber.transcribeSpeech(bytes, name, owner ? { locale: localeOf(store, owner) } : {});
      return { state: outcome.state, ...("text" in outcome && typeof outcome.text === "string" ? { text: outcome.text } : {}),
        ...("seconds" in outcome && typeof outcome.seconds === "number" ? { seconds: outcome.seconds } : {}),
        ...("speechSeconds" in outcome && typeof outcome.speechSeconds === "number" ? { speechSeconds: outcome.speechSeconds } : {}),
        ...("workMs" in outcome && typeof outcome.workMs === "number" ? { workMs: outcome.workMs } : {}) };
    }
  };

  // 「作为算力节点」 (docs/compute-node.md): on the person's switch this computer also offers its Codex runtime to the hosted site, which
  // sends it the account's model runs; it starts none of its own.
  const node = nodeEnabled(dataDir) && link.token && !options.runOnce
    ? startNodeAgent({ url: link.url, token: link.token, dir: path.join(deviceDir, "node"), host: label, log, spawn: localAppServer, role: "device",
      level: nodeLevel(dataDir), remoteDir: deviceDir, remoteHooks, browsers: createNodeBrowsers({ profilesDir: path.join(deviceDir, "node", "browser-profiles") }),
      protect: [deviceDir] }) : undefined;
  if (node) process.on("exit", () => node.stop());
  // Who this computer's Codex is signed in as, for the device page (read once; an API-key sign-in there updates it).
  let nodeAccount: NodeAccount | undefined;
  if (nodeEnabled(dataDir) && !options.runOnce) void readNodeAccount(localAppServer).then((account) => { nodeAccount = account; }).catch(() => undefined);

  const ownerOnly = { state: "blocked" as const, code: "FOLDER_OWNER_ONLY", message: tFor(owner ? localeOf(store, owner) : undefined)("文件夹在这台电脑上，只有它的主人能授权。") };
  const server = await startDeviceServer({
    port: options.port, capabilitySecret: options.capabilitySecret, locale: (workspaceId) => workspaceId ? localeOf(store, workspaceId) : undefined,
    folders: {
      preview: async (workspaceId, folderPath, names) => workspaceId === owner ? previewFolder(folderPath, folderDeps(workspaceId), personNames(store, workspaceId, names)) : ownerOnly,
      add: async (workspaceId, folderPath, rules) => {
        if (workspaceId !== owner) return ownerOnly;
        const added = await addFolder(store, workspaceId, folderPath, folderDeps(workspaceId), rules);
        if (added.state === "added") void folders();
        return added;
      },
      remove: async (workspaceId, id, purge) => {
        const removed = removeFolder(store, workspaceId, id, { purge: Boolean(purge), dataDir });
        if (removed.purged) { queue(owner ? sourceItems(store, owner, state) : []); void flush(); }
        return removed;
      },
      setRules: async (workspaceId, id, rules) => {
        if (workspaceId !== owner) return ownerOnly;
        const saved = await setFolderRules(store, workspaceId, id, rules, folderDeps(workspaceId));
        queue(sourceItems(store, workspaceId, state));
        void flush();
        return saved;
      },
      setLines: async (workspaceId, id, lines) => {
        const saved = setFolderLines(store, workspaceId, id, lines);
        if (owner) { queue(sourceItems(store, owner, state)); void flush(); }
        return { saved };
      }
    },
    link: createDeviceLinkService({ dataDir, secrets: options.secrets, fetch: fetchImpl, localeFor: (workspaceId) => localeOf(store, workspaceId), onChanged: () => { outbox.unblock(); options.restart(); },
      nodeStatus: () => ({ ...(node?.status() ?? { state: "off" }), account: nodeAccount ?? null }),
      remote: () => ({ control: node?.remote(), ledger: node ? node.remoteLedger : undefined }),
      nodeLogin: async (apiKey) => {
        const signed = await loginNodeWithApiKey(localAppServer, apiKey);
        if (signed.ok) { nodeAccount = signed.account; log({ type: "device.node_signed_in", with: "api_key" }); }
        return signed;
      },
      status: () => ({ ...outbox.stats(), modelNeeded: state.modelNeeded ?? 0, lastPassAt: state.lastPassAt ?? null, workspaceId: owner ?? null, mirror: state.mirror ?? null }) }),
    transcription: {
      status: () => transcriber.status(),
      download: async () => {
        const current = await transcriber.status();
        if (current.state === "ready" || current.state === "downloading") return current;
        void transcriber.download().then(() => { state.modelNeeded = 0; writeDeviceState(deviceDir, state); return transcribe(); }).catch(() => undefined);
        return { state: "downloading", progress: 0 };
      }
    }
  }).catch((error: unknown) => { log({ type: "device.server_failed", message: error instanceof Error ? error.message : String(error) }); return undefined; });
  if (server) log({ type: "device.server_ready", url: server.url });

  // One step's trouble never stops the others, and never the worker: a throw here at start would have the keeper restart it in a loop.
  const step = async (name: string, work: () => unknown) => {
    try { await work(); } catch (error) { log({ type: "device.step_failed", step: name, message: error instanceof Error ? error.message : String(error) }); }
  };
  const pass = async () => {
    options.beat();
    await step("prune", () => tracker.prune());
    await step("folders", folders);
    await step("agent_history", history);
    await step("git_commits", commits);
    await step("activity", activity);
    state.lastPassAt = new Date().toISOString();
    await step("state", () => writeDeviceState(deviceDir, state));
    await flush();
  };

  // The hosted ledger, mirrored onto this computer's workspace (server to device only), at start and every ten minutes.
  let mirroring = false;
  const mirror = async () => {
    if (mirroring) return;
    mirroring = true;
    try {
      const outcome = await mirrorPass({ store, ledger: path.join(dataDir, "crossline.db"), workspaceId: owner, link, state, fetch: fetchImpl });
      writeDeviceState(deviceDir, state);
      if (outcome.error) log({ type: "device.mirror_failed", error: outcome.error });
      else if (outcome.at === outcome.checkedAt) log({ type: "device.mirrored", at: outcome.at });
    } finally { mirroring = false; }
  };

  await step("mirror", mirror);
  await pass();
  if (options.runOnce) { await server?.stop(); return; }
  setInterval(() => { void step("mirror", mirror); }, MIRROR_INTERVAL_MS);
  // Activity changes by the minute: looked at every two minutes and sent when it changed; the full pass on the worker's own interval.
  setInterval(() => { void step("activity", activity).then(flush); }, 2 * 60_000);
  let passing = false;
  setInterval(() => {
    if (passing) return;
    passing = true;
    void pass().catch((error: unknown) => log({ type: "device.pass_failed", message: error instanceof Error ? error.message : String(error) }))
      .finally(() => { passing = false; });
  }, options.intervalMinutes * 60_000);
  // The outbox's own retries, between passes.
  setInterval(() => { void flush(); }, 60_000);
}
