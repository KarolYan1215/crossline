/**
 * One real `web_research` round trip on this machine's own Codex sign-in (docs/plans/harness-1125.md §10): the material researcher, given
 * a fictional person's private context, with no search on its own thread; each `web_research` it makes is a real scout run with live
 * search. Prints the quota first and stops if it is spent, then every `web_research` call (its queries and whether it went out), the
 * scout runs, and the pages that came back.
 *
 *   $env:CROSSLINE_CODEX_PATH = "<main checkout>\vendor\codex\codex-rs\target\release\codex.exe"; pnpm exec tsx scripts/web-research-check.ts
 *
 * Uses the checkout's Codex home (%LOCALAPPDATA%\Crossline\codex-home, not the installed app's) and installs this checkout's plugin there.
 */
import path from "node:path";
import { enterUsageWorkspace, readCostSignal, runCodexSkill, setPrivateGuardProvider, setWebAvailableProvider, startCodexSupervisor, webResearchBlocker } from "../packages/codex/src/index";
import { MATERIAL_SEARCH_SCHEMA, validateMaterialSearch, type MaterialSearchContext, type PrivateGuard } from "../packages/core/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
const SKILL = "crossline:crossline-research:material";
// A fictional person: what the run holds and what no query may carry.
const guard: PrivateGuard = { terms: ["林晓舟", "xzlin.research@example.edu", "2021123456"],
  passages: ["本人正在准备关于低功耗存内计算芯片的博士资格考试，导师要求十二月前交初稿"] };

const supervisor = await startCodexSupervisor({ port: 0, capabilitySecret: "web-research-check",
  plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
    requiredSkills: [SKILL, "crossline:crossline-web-scout"] } });
try {
  const cost = await readCostSignal(supervisor.client);
  console.log(JSON.stringify({ type: "quota", cost }));
  if (!cost.available || cost.limitReached || (cost.short?.usedPercent ?? 0) >= 95) {
    console.log(JSON.stringify({ type: "skipped", reason: "ChatGPT quota spent or unreadable: not run" }));
    process.exitCode = 2;
  } else {
    const blocker = webResearchBlocker();
    if (blocker) throw new Error(`${blocker.code}: ${blocker.message}`);
    enterUsageWorkspace("web-research-check");
    setWebAvailableProvider(() => true);
    setPrivateGuardProvider(() => guard);
    // What the runtime reports of each function call: the research calls, their queries, and whether each was answered.
    supervisor.client.onNotification((message) => {
      const item = (message.params as { item?: Record<string, unknown> } | undefined)?.item;
      if (message.method === "item/completed" && item?.type === "dynamicToolCall")
        console.log(JSON.stringify({ type: "tool", tool: item.tool, arguments: item.arguments, success: item.success }));
    });
    const context: MaterialSearchContext = { version: "crossline.manualbook.search.v1", today: new Date().toISOString().slice(0, 10),
      task: { intent: "林晓舟（学号 2021123456）准备低功耗存内计算芯片方向的博士资格考试" },
      node: { id: "n1", title: "了解资格考试的书面提案通常怎么写", kind: "read", goal: "知道资格考试书面提案的常见结构和评审看重什么", steps: [],
        researchQuestions: ["博士资格考试（qualifying exam）的书面研究提案一般包含哪些部分？", "存内计算（compute-in-memory）近两年的综述有哪些？"] },
      localFiles: [], constraints: ["本人正在准备关于低功耗存内计算芯片的博士资格考试，导师要求十二月前交初稿"] };
    const started = Date.now();
    const result = await runCodexSkill(supervisor.client, context, { skillName: SKILL, cwd: repoRoot, webResearch: true,
      developerInstructions: "Find the best public material for this one step and return only the requested JSON. Every source must be a page "
        + "`web_research` returned, cited by its exact url.", outputSchema: MATERIAL_SEARCH_SCHEMA, prepareInput: () => context,
      validateOutput: (output) => validateMaterialSearch(output), onAudit: () => {}, timeoutMs: 30 * 60_000 });
    console.log(JSON.stringify({ type: "result", ok: result.ok, seconds: Math.round((Date.now() - started) / 1000), webUrls: result.audit.webUrls ?? [],
      ...(result.ok ? { sources: result.output.sources.map((source) => source.url) } : { blocker: result.blocker }) }));
  }
} finally { await supervisor.stop(); }
