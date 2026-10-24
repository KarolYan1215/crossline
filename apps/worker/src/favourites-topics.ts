import { createHash } from "node:crypto";
import path from "node:path";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import {
  FAVOURITE_TOPICS_SCHEMA, NOTE_GAP_MS, parseTopicPlan, topicPlanKey, grownSkillFilesKey, grownSkillId, grownSkillName, TITLES_PER_RUN, dayBatch, emptyTopicPlan, mergeTopics, nightBatch, nightOf, topicOfNote, topicProgress, validateFavouriteTopics,
  type FavouriteTopic, type FavouriteTopicPlan, type FavouriteTopicsAnswer, type FavouriteTopicsContext, type GrownSkillRecord
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { grownHomeLine, readGrownSkills, writeGrownSkills, type CrosslineStore } from "@crossline/db";
import type { DispatchResult } from "./agent-service";
import type { AgentOutcome, AgentTaskInput } from "./agent-task";
import { collectFolder, collectHold, favouritesAccess, markOrganised, readCollectLedger, type CollectResult } from "./favourites-reader";
import { linePacks } from "./lines";
import { ownerOf } from "./owner";
import { claimOrganising, currentFavouritesCollector, rememberRead, sayToPerson, startFavouritesRun } from "./workflow-smith";

/**
 * The favourites organised by topic (packages/core/src/favourite-topics.ts has the rules and the owner's words). This is the worker's side:
 * the list read once for its titles, the titles sorted into topics by `crossline-favourite-topics`, then on each tick the reading that is
 * due — the day's share of the day's topic outside the night window, everything in order inside it — and the assistant organising what
 * each run read into its topics' documents. A workflow is in this mode once it has a topic plan (`collect.topics.<id>`).
 */
type RunFree = (input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void) => DispatchResult;
const TOPICS_SKILL = "crossline:crossline-favourite-topics";
/** The list read again for new favourites at most this often (by night, its first tick). */
const LIST_REFRESH_DAYS = 7;
/** Batches of titles one classification call sorts before it lets the tick go. */
const RUNS_PER_CALL = 6;

export function readTopicPlan(store: CrosslineStore, workspaceId: string, workflowId: string): FavouriteTopicPlan | undefined {
  return parseTopicPlan(store.getSetting(workspaceId, topicPlanKey(workflowId)));
}
export function writeTopicPlan(store: CrosslineStore, workspaceId: string, workflowId: string, plan: FavouriteTopicPlan): void {
  store.setSetting(workspaceId, topicPlanKey(workflowId), JSON.stringify(plan));
}
export const topicModeOn = (store: CrosslineStore, workspaceId: string, workflowId: string) => Boolean(store.getSetting(workspaceId, topicPlanKey(workflowId)));

const zoneOf = (store: CrosslineStore, workspaceId: string) => {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  return zone;
};
const readSet = (store: CrosslineStore, workspaceId: string, workflowId: string) =>
  new Set(Object.entries(readCollectLedger(store, workspaceId, workflowId).read).map(([id]) => id));

/** Sorts the listed favourites not under a topic yet, `TITLES_PER_RUN` titles a run; titles a run left out go under 「其他」. */
export function createTopicClassifier(store: CrosslineStore, cwd: string, getClient: (workspaceId: string) => CodexRpcBoundary | undefined) {
  const running = new Set<string>();
  return async function classify(workspaceId: string, workflowId: string): Promise<number> {
    const key = `${workspaceId}:${workflowId}`;
    const client = getClient(workspaceId);
    if (!client || running.has(key)) return 0;
    running.add(key);
    try {
      let sorted = 0;
      for (let run = 0; run < RUNS_PER_CALL; run += 1) {
        const plan = readTopicPlan(store, workspaceId, workflowId) ?? emptyTopicPlan();
        const listed = readCollectLedger(store, workspaceId, workflowId).listed ?? {};
        const done = new Set(plan.classified);
        const ids = Object.keys(listed).filter((id) => !done.has(id)).slice(0, TITLES_PER_RUN);
        if (!ids.length) break;
        const context: FavouriteTopicsContext = { version: "crossline.favourite-topics.v1",
          lines: linePacks(store, workspaceId).filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, name: pack.label, goal: "" })),
          existing: [...plan.topics].sort((a, b) => b.notes.length - a.notes.length).map((topic) => ({ name: topic.name, why: topic.why, count: topic.notes.length })),
          titles: ids.map((id, index) => ({ n: index + 1, title: listed[id]!.title || "（无标题）", author: listed[id]!.author ?? "", type: listed[id]!.type })) };
        const result = await runCodexSkill<FavouriteTopicsAnswer>(client, context, { skillName: TOPICS_SKILL, cwd, outputSchema: FAVOURITE_TOPICS_SCHEMA as unknown as Record<string, unknown>,
          developerInstructions: "Sort these saved notes' titles into topics as the crossline-favourite-topics Skill describes and return only the requested JSON.",
          stableKeys: ["version", "lines", "existing"], prepareInput: () => context,
          validateOutput: (output) => validateFavouriteTopics(output, ids.length, plan.topics.length), onAudit: () => {}, timeoutMs: 30 * 60_000 });
        if (!result.ok) break;
        let next = mergeTopics(plan, result.output, ids);
        // A title the model left out is not asked about again and again: it goes under 「其他」, which keeps its place at the end.
        const left = ids.filter((id) => !next.classified.includes(id));
        if (left.length) next = mergeTopics(next, { topics: [{ name: "其他", why: "标题看不出归属的收藏", notes: left.map((id) => ids.indexOf(id) + 1) }] }, ids);
        const other = next.topics.find((topic) => topic.name === "其他");
        if (other) next = { ...next, order: [...next.order.filter((id) => id !== other.id), other.id] };
        writeTopicPlan(store, workspaceId, workflowId, next);
        sorted += ids.length;
      }
      return sorted;
    } finally { running.delete(key); }
  };
}

/**
 * One step of the favourites by topic, on each tick or when the person presses 「立即运行」 (`manual`): the list first (once, then every
 * week by night), the titles sorted, then the reading that is due. Returns what was started, or undefined when nothing was due.
 */
export function favouritesTopicStep(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord, runFree: RunFree, profilesRoot: string, now: Date,
  options: { manual?: boolean; fallbackBrowser?: string | undefined } = {}): DispatchResult {
  const collector = currentFavouritesCollector();
  const access = favouritesAccess(record);
  if (!collector || !access) return { state: "blocked", code: "COLLECTOR_UNAVAILABLE", message: "这台机器上不能读取收藏。" };
  const plan = readTopicPlan(store, workspaceId, record.id) ?? emptyTopicPlan();
  const ledger = readCollectLedger(store, workspaceId, record.id);
  const clock = nightOf(now, zoneOf(store, workspaceId), plan.window);
  // A run that hit a check or broke holds the site (startFavouritesRun) until the person presses 「立即运行」; a run cut by a restart does not.
  const start = (job: Parameters<typeof startFavouritesRun>[9]) =>
    startFavouritesRun(store, workspaceId, record, runFree, profilesRoot, now, options.fallbackBrowser, access, collector, job);
  const sortThen = () => { void collector.classify?.(workspaceId, record.id).then((count) => {
    if (count && options.manual) {
      const progress = topicProgress(readTopicPlan(store, workspaceId, record.id) ?? plan, readSet(store, workspaceId, record.id));
      sayToPerson(store, workspaceId, `收藏已按标题分成 ${progress.length} 个话题：${progress.slice(0, 8).map((item) => `${item.name}（${item.total}）`).join("、")}${progress.length > 8 ? " 等" : ""}。`
        + `每天整理一个话题，最多 ${plan.perDay} 篇；${plan.window.from === plan.window.to ? "" : `${plan.window.from}–${plan.window.to} 点不限篇数持续整理。`}可在设置里改。`,
        "workflow_done", `topics:${record.id}:${clock.day}`, [{ label: "去看设置", href: "/settings#skills" }], now);
    }
  }).catch(() => undefined); };
  // 0. What is already listed is sorted even while the site is held or the list unfinished: sorting reads only the titles kept here and
  //    never opens the site (the owner, 2026-10-23: the 1170 listed before a 461 were to be sorted before the list is read again).
  const unsorted = Object.keys(ledger.listed ?? {}).filter((id) => !plan.classified.includes(id));
  if (unsorted.length && (!ledger.listedAt || collectHold(store, workspaceId, now))) {
    sortThen();
    return { state: "blocked", code: "TOPICS_SORTING", message: `正在按标题把已列出的 ${unsorted.length} 条收藏分成话题（不访问小红书）。` };
  }
  // 1. The list, for its titles: once at the start, and again each week by night for what was saved since.
  const stale = !ledger.listedAt || now.getTime() - Date.parse(ledger.listedAt) > LIST_REFRESH_DAYS * 86_400_000;
  if (!ledger.listedAt || (stale && clock.inWindow)) {
    return start({ listOnly: true, mode: ledger.listedAt ? "incremental" : "catch_up", after: (result) => {
      if (result.state === "done") sortThen();
    } });
  }
  // 2. The titles not under a topic yet: a model run, no site.
  if (Object.keys(ledger.listed ?? {}).some((id) => !plan.classified.includes(id))) {
    sortThen();
    return { state: "blocked", code: "TOPICS_SORTING", message: "正在按标题把收藏分成话题。" };
  }
  // 3. The reading that is due.
  const read = readSet(store, workspaceId, record.id);
  const ids = clock.inWindow ? nightBatch(plan, read) : dayBatch(plan, clock.day, read).ids;
  if (!ids.length) {
    return { state: "blocked", code: "TOPICS_DONE_FOR_NOW", message: clock.inWindow ? "收藏都已读完。" : `今天的 ${plan.perDay} 篇已整理完，${plan.window.from === plan.window.to ? "明天" : `${plan.window.from} 点`}继续。` };
  }
  const topic = topicOfNote(plan).get(ids[0]!);
  if (!clock.inWindow && topic && !plan.days[clock.day]) writeTopicPlan(store, workspaceId, record.id, { ...plan, days: { ...plan.days, [clock.day]: { topicId: topic.id, read: [] } } });
  const random = Math.random;
  // The reading keeps the step's clock (a test, or a step run for a given moment), moving on in real time from it.
  const offset = now.getTime() - Date.now();
  return start({ targets: ids, now: () => new Date(Date.now() + offset), gapMs: () => NOTE_GAP_MS[0] + random() * (NOTE_GAP_MS[1] - NOTE_GAP_MS[0]),
    ...(clock.inWindow ? { deadline: clock.endsAt } : {}),
    after: (result) => {
      if (!clock.inWindow && result.read.length) {
        const latest = readTopicPlan(store, workspaceId, record.id) ?? plan;
        const today = latest.days[clock.day] ?? { topicId: topic?.id ?? "", read: [] };
        writeTopicPlan(store, workspaceId, record.id, { ...latest, days: { ...latest.days, [clock.day]: { ...today, read: [...today.read, ...result.read] } } });
      }
      organiseTopics(store, workspaceId, record, runFree, collectFolder(collector.outputRoot, record.id), result, new Date());
    } });
}

/** Every tick: the step for each favourites workflow in topic mode that is on. */
export function favouritesTopicPass(store: CrosslineStore, workspaceId: string, records: GrownSkillRecord[], runFree: RunFree, profilesRoot: string, now = new Date()): string[] {
  const started: string[] = [];
  for (const record of records) {
    if (record.status !== "active" || !favouritesAccess(record) || !topicModeOn(store, workspaceId, record.id)) continue;
    const outcome = favouritesTopicStep(store, workspaceId, record, runFree, profilesRoot, now);
    if (outcome.state === "started") started.push(record.id);
  }
  return started;
}

/** What a run read goes to the assistant topic by topic: each topic's document is written or extended from the notes read for it. */
function organiseTopics(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord, runFree: RunFree, folder: string, result: CollectResult, now: Date): void {
  const plan = readTopicPlan(store, workspaceId, record.id);
  if (!plan) return;
  const byNote = topicOfNote(plan);
  // Only notes no organising run already has (claimOrganising), and only those under a topic.
  const claim = claimOrganising(workspaceId, record.id, readCollectLedger(store, workspaceId, record.id).unorganised.filter((id) => byNote.has(id)));
  const ids = claim.ids;
  const groups = new Map<FavouriteTopic, string[]>();
  for (const id of ids) { const topic = byNote.get(id); if (topic) groups.set(topic, [...(groups.get(topic) ?? []), id]); }
  if (!groups.size) { claim.release(); return; }
  const read = readSet(store, workspaceId, record.id);
  const progress = new Map(topicProgress(plan, read).map((item) => [item.id, item]));
  const last = record.lastRead && existsSync(record.lastRead.directory) && record.lastRead.directory !== folder ? record.lastRead.directory : undefined;
  const home = grownHomeLine(store, workspaceId, record);
  const lines = [...groups].map(([topic, notes]) => { const p = progress.get(topic.id)!;
    return `- 「${topic.name}」（${topic.why}）：本次新读 ${notes.length} 条（${notes.slice(0, 40).map((id) => `note-${id}.md`).join("、")}${notes.length > 40 ? " 等" : ""}），话题共 ${p.total} 条，已读 ${p.read} 条${p.read >= p.total ? "，本话题已读完" : ""}。`; });
  const started = runFree({ taskId: `flow-${record.id.replace(/^flow-/, "")}-${now.getTime().toString(36)}`, category: record.category, ...(home ? { lineId: home } : {}),
    inputs: [folder, ...(last ? [last] : [])], extraSkills: [grownSkillName(record.id)], title: `按话题整理小红书收藏：${[...groups.keys()].map((topic) => topic.name).join("、")}`.slice(0, 80),
    humanPart: "查看话题整理", what: [
      `按工作流 $${grownSkillName(record.id)} 整理收藏的笔记，按话题写：每个话题一份「话题-<话题名>.md」，再更新「话题总览.md」（每个话题一行：名称、条数、已整理条数、一句话要点）。`,
      `笔记已由 Crossline 在本人登录的浏览器里读好，放在只读输入 ${path.basename(folder)}：index.md 是目录，每条笔记一个 note-<id>.md（标题、正文、标签、作者、发布时间、互动数、每张图片的描述与图中文字、视频转写与关键帧描述、原链接）。不要再访问小红书。`,
      "本次只整理这些：", ...lines,
      "话题文件和「话题总览.md」都写在任务目录顶层。",
      ...(last ? [`上次的整理结果（${path.basename(last)}，只读）：已有的话题文件在其中。只写本次涉及的话题：把本次新读的并入上次同名的话题文件后整份写出，已写过的笔记不重写；再写更新后的「话题总览.md」。未涉及的话题文件不要输出，Crossline 会从上次结果原样带上。`] : []),
      "不在账号里做任何改动（移动、删除、取消收藏、点赞、评论、发布）。"].join("\n") },
  (outcome) => {
    claim.release();
    if (outcome.state !== "done") {
      sayToPerson(store, workspaceId, `收藏已读 ${ids.length} 条，但按话题整理没有做成：${"message" in outcome ? outcome.message : "助手未获准做这类工作"}。下次运行一起整理。`,
        "workflow_done", `topics-failed:${record.id}:${now.toISOString().slice(0, 10)}`, [{ label: "去看设置", href: "/settings#skills" }], now);
      return;
    }
    markOrganised(store, workspaceId, record.id, ids);
    // The topics this run did not touch come over from the last result, so every result holds every topic.
    carryTopicFiles(last, outcome.directory);
    rememberRead(store, workspaceId, record.id, { at: new Date().toISOString(), taskId: outcome.taskId, directory: outcome.directory, items: read.size, pages: [] });
    const finished = [...groups.keys()].filter((topic) => (progress.get(topic.id)?.read ?? 0) >= topic.notes.length).map((topic) => topic.name);
    sayToPerson(store, workspaceId, `收藏按话题整理好了：本次 ${ids.length} 条，涉及 ${[...groups.keys()].map((topic) => `「${topic.name}」`).join("、")}${finished.length ? `；${finished.map((name) => `「${name}」`).join("、")}已整理完` : ""}。${result.state === "check" ? "读取时遇到了安全验证，已停下。" : ""}`,
      "workflow_done", `topics:${record.id}:${outcome.taskId}`, [{ label: "去看结果", href: "/approvals#assistant" }], now);
  });
  if (started.state !== "started") claim.release();
  if (started.state === "blocked" && started.code !== "AGENT_BUSY")
    sayToPerson(store, workspaceId, `收藏已读 ${ids.length} 条，整理要等一下：${started.message}`, "workflow_done", `topics-wait:${record.id}:${now.toISOString().slice(0, 10)}`,
      [{ label: "打开设置", href: "/settings#automation" }], now);
}

const TOPIC_FILE = /^话题(-.+|总览)\.md$/;
/** The folder of a result that holds its topic documents: the result itself, else its one subfolder that does. */
function topicDir(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const names = readdirSync(root);
  if (names.some((name) => TOPIC_FILE.test(name))) return root;
  for (const name of names) {
    const dir = path.join(root, name);
    try { if (statSync(dir).isDirectory() && readdirSync(dir).some((inner) => TOPIC_FILE.test(inner))) return dir; } catch { /* unreadable */ }
  }
  return undefined;
}
/**
 * The topic documents a run did not write are copied from the last result into this one (beside the ones it wrote), so the assistant
 * writes only the topics a run touched instead of every topic again (each run used to output all topic documents in full). Returns
 * the names carried.
 */
export function carryTopicFiles(from: string | undefined, to: string): string[] {
  const source = from ? topicDir(from) : undefined;
  if (!source || !existsSync(to)) return [];
  const target = topicDir(to) ?? to;
  const carried: string[] = [];
  for (const name of readdirSync(source)) {
    if (!TOPIC_FILE.test(name) || existsSync(path.join(target, name))) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
    carried.push(name);
  }
  return carried;
}

/** A favourites workflow is put in topic mode with the default share and window (the person changes them in Skill 库). */
export function enableTopicMode(store: CrosslineStore, workspaceId: string, workflowId: string): FavouriteTopicPlan {
  const plan = readTopicPlan(store, workspaceId, workflowId) ?? emptyTopicPlan();
  writeTopicPlan(store, workspaceId, workflowId, plan);
  return plan;
}


/** What the workflow tells the assistant when it organises a topic: the skill installed with it. */
export const FAVOURITES_TOPICS_SKILL_MD = `---
name: xiaohongshu-favourites-topics
description: Organise the notes the person saved on Xiaohongshu, already read by Crossline into note files, one topic at a time into a topic document and an overview.
---

# 小红书收藏按话题整理

Crossline 已经在本人登录的浏览器里读好笔记（只读输入里的 note-<id>.md：标题、正文、标签、作者、时间、互动数、图片描述与图中文字、视频转写与关键帧、原链接）。本技能只做整理，不访问小红书，不在账号里做任何改动。

每个话题一份「话题-<话题名>.md」：

1. **这个话题收了什么**：两三句话，条数，时间跨度。
2. **要点**：从笔记里归纳出的方法、观点、数据和做法，每条注明来自哪几篇（标题加原链接）。同一说法多篇都提到的合并，相互矛盾的并列写出。
3. **逐篇摘记**：每篇一小节，标题、作者、链接，三到五行要点；图片里的文字和视频里说的话里有用的写进来。
4. **对本人有用的地方**：结合本人的主线，这些内容能用在哪里（选题、方法、要验证的说法），只写有依据的。

「话题总览.md」每个话题一行：名称、条数、已整理条数、一句话要点。

已有的话题文件在上次的整理结果里：只写本次涉及的话题，把新读的并入同一文件，保持结构，不重复已写过的笔记；未涉及的话题不输出（Crossline 会带上）。只用笔记里有的内容，不编造。

## Language

简体中文，客观第三人称，不用你/您/我。引用笔记原文保持原样。
`;

/**
 * Installs the favourites-by-topic workflow for a workspace (the owner's request of 2026-10-22, on the hosted site): a grown workflow that
 * reads Xiaohongshu behind the person's own login, so it waits for their consent and their login (Skill 库 「接受风险并启用」, 「登录小红书」),
 * with its organising skill written here rather than grown by the assistant. Returns the record; an existing one is kept.
 */
export function installFavouritesTopicsWorkflow(store: CrosslineStore, workspaceId: string, lineId: string, now = new Date()): GrownSkillRecord {
  const records = readGrownSkills(store, workspaceId);
  const existing = records.find((record) => record.name === "xiaohongshu-favourites-topics");
  if (existing) { enableTopicMode(store, workspaceId, existing.id); return existing; }
  const id = grownSkillId("xiaohongshu-favourites-topics", records.map((record) => record.id));
  const at = now.toISOString();
  const text = FAVOURITES_TOPICS_SKILL_MD;
  const summary = "按话题整理小红书收藏：读全部收藏的标题分成话题，每天整理一个话题（默认最多 50 篇），另在当地 2–8 点按人的速度持续整理";
  const record: GrownSkillRecord = { id, kind: "grown", name: "xiaohongshu-favourites-topics", description: summary, lines: [lineId], category: "read_research_organize",
    manifest: { name: "xiaohongshu-favourites-topics", summary, lines: [lineId], category: "read_research_organize", trigger: "on_request", schedule: null, action: "run", reminder: "",
      steps: [{ title: "读取收藏列表并按标题分话题", by: "assistant", external: false }, { title: "按话题读笔记并整理成话题文档", by: "assistant", external: false },
        { title: "查看话题整理", by: "person", external: false }],
      inputs: [], outputs: ["话题-<话题名>.md", "话题总览.md"],
      access: [{ service: "小红书", site: "https://www.xiaohongshu.com", login: true, how: "本人在 Crossline 的登录窗口里登录后，只读收藏列表和收藏的笔记（文字、图片、视频）" }],
      risks: ["读取从服务器（香港数据中心）发出，浏览器带有自动化标记，小红书可能识别为自动化访问并限流或要求验证；遇到验证会立刻停下，7 天内不再读取。",
        "白天每天最多读一个话题的 50 篇，2–8 点按每篇 1–3 分钟的速度持续读，访问量比本人平时刷得多。",
        "不点赞、不评论、不取消收藏、不发布，不改动账号。"] },
    origin: { kind: "asked", text: "按话题整理小红书收藏，每天一个话题最多 50 篇，2–8 点持续整理", requestId: `favourites-topics-${id}` }, taskId: "",
    files: [{ path: "SKILL.md", sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) }],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: ["Crossline 自带的整理说明，没有脚本"], final: "usable" },
    status: "needs_consent", pinned: true, createdAt: at, updatedAt: at, lastUsedAt: at };
  store.setSetting(workspaceId, grownSkillFilesKey(id), JSON.stringify({ files: [{ path: "SKILL.md", text }] }));
  writeGrownSkills(store, workspaceId, [...records, record]);
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.created:${id}`, type: "skill.grown.created", entityId: id,
    payload: { id, name: record.name, lines: record.lines, category: record.category, trigger: "on_request", final: "usable", origin: "asked" } });
  enableTopicMode(store, workspaceId, id);
  return record;
}

/**
 * At worker start: every collection begun (`collect.started`) and never ended (`collect.ran`) was cut off by the restart. Each gets its
 * end as `failed` with `interrupted`, so the page stops showing it as running and the next run is not held for it.
 */
export function closeInterruptedCollections(store: CrosslineStore, workspaceId: string): string[] {
  const ended = new Set(store.listEvents(workspaceId, { type: "collect.ran" }).map((event) => (event.payload as { taskId?: string }).taskId));
  const closed: string[] = [];
  for (const event of store.listEvents(workspaceId, { type: "collect.started" })) {
    const taskId = (event.payload as { taskId?: string }).taskId;
    if (!taskId || ended.has(taskId)) continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `collect.ran:${taskId}`, type: "collect.ran", entityId: event.entityId,
      payload: { taskId, state: "failed", interrupted: true, mode: "catch_up", listed: 0, listEnded: false, read: 0, gone: 0, pending: 0 } });
    closed.push(taskId);
  }
  return closed;
}
