import { tmpdir } from "node:os";
import path from "node:path";
import { ONBOARDING_PROGRESS_SETTING, readPartialTurn, type OnboardingProgress } from "../packages/core/src/index";
import { CrosslineStore } from "../packages/db/src/index";

/**
 * Shows the interview's wait in the install preview without a model (docs/onboarding-v3.md 「等待」): appends a reply to the latest seeded
 * session and writes a progress record as the worker would, refreshed every second for `seconds` (default 60) while a fake answer
 * "streams" in, then deletes it.
 *
 *   pnpm exec tsx scripts/install-preview-progress.ts [seconds]
 */
const seconds = Number(process.argv[2] ?? 60);
const store = new CrosslineStore(path.join(tmpdir(), "crossline-install-preview", "crossline.db"));
const ws = store.listWorkspaces()[0]!.id;
const session = store.getLatestOnboardingSession(ws);
if (!session) throw new Error("NO_SESSION: seed a stage first (install-preview-seed.ts)");
store.appendOnboardingMessage({ sessionId: session.id, workspaceId: ws, role: "user", content: { text: "西湖那篇 10/31 前要投出，图还差两张。" }, createdAt: new Date().toISOString() });
const answer = JSON.stringify({ reply: "两张图是瓶颈：投稿前还有 17 天，扣掉组会和两次课，真正能用的整块时间只有九个上午。先问清楚这两张图卡在哪。",
  questions: [{ id: "q1", text: "两张图卡在哪？", kind: "single" }, { id: "q2", text: "导师要先看吗？", kind: "single" }],
  slotUpdates: [{ slot: "deadline" }, { slot: "blockers" }, { slot: "evidence" }], projectsDetected: [], flywheelCandidates: [], coverage: [],
  fileDates: { dates: [{ date: "2026-10-31" }], recurring: [] }, nextAction: "ask" });
const key = `${ONBOARDING_PROGRESS_SETTING}:${session.id}`;
const startedAt = new Date().toISOString();
for (let second = 0; second < seconds; second += 1) {
  const share = Math.max(0, (second - seconds * 0.25) / (seconds * 0.6));
  const text = answer.slice(0, Math.floor(answer.length * Math.min(1, share)));
  const record: OnboardingProgress = { sessionId: session.id, startedAt, updatedAt: new Date().toISOString(), files: ["ECE548-syllabus.pdf", "西湖合作-进度.docx"],
    phase: share <= 0 ? "thinking" : share >= 1 ? "checking" : "writing", ...readPartialTurn(text), repairs: 0, stalls: 0 };
  store.setSetting(ws, key, JSON.stringify(record));
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
store.deleteSetting(ws, key);
store.close();
