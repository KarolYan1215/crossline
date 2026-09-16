/**
 * Gate 6–7 evidence (design §12), read from the real ledger and the real policy functions:
 *
 *   6. an energy reading is one of three levels when observations exist, `uncalibrated` when they do
 *      not, and never a continuous score;
 *   7. the budget gate really degrades at 70 / 85 / 100 percent of the window.
 *
 *   pnpm exec tsx scripts/gate-capacity-budget-check.ts
 *
 * Neither check spends Codex quota: the percentages are fed in directly, which is what §12-7 asks for
 * ("模拟 70/85/100%"), and the capacity reading comes from whatever the ledger actually holds.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import path from "node:path";
import { budgetPolicy, deriveCapacity, modelForTier, tierUnderMode } from "../packages/core/src/index";
import { CrosslineStore } from "../packages/db/src/index";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(process.env.CROSSLINE_DATA_DIR ?? path.join(repoRoot, "data"));
const workspaceId = process.env.CROSSLINE_WORKSPACE_ID ?? "personal-crossline";
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const failures: string[] = [];

try {
  const now = new Date().toISOString();
  const observations = store.listEnergyObservations(workspaceId);
  const reading = deriveCapacity({
    now,
    selfReports: observations.filter((observation) => observation.source === "self_report")
      .map((observation) => ({ level: observation.level, confidence: observation.confidence, observedAt: observation.observedAt })),
    dailyActivity: observations.filter((observation) => observation.source === "local_activity")
      .map((observation) => ({ day: observation.observedAt.slice(0, 10), aggregate: observation.aggregate })),
    localActivityConsent: (store.getSetting(workspaceId, "localActivity.consent") ?? "unasked") as "granted" | "denied" | "unasked"
  });

  const levels = ["low", "medium", "high", "uncalibrated"];
  if (!levels.includes(reading.level)) failures.push(`capacity level is not one of ${levels.join("/")}`);
  // §12-6's real content: no continuous score may leak out under any key.
  const numeric = Object.entries(reading).filter(([key, value]) => typeof value === "number" && key !== "observationCount");
  if (numeric.length) failures.push(`capacity exposes a continuous score: ${numeric.map(([key]) => key).join(", ")}`);
  if (reading.observationCount === 0 && reading.level !== "uncalibrated") {
    failures.push("capacity claimed a level with zero observations");
  }
  console.info(JSON.stringify({ status: "gate_6_capacity", reading }, null, 1));

  const expected = [
    { usedPercent: 0, mode: "normal", warning: false },
    { usedPercent: 69, mode: "normal", warning: false },
    { usedPercent: 70, mode: "normal", warning: true },
    { usedPercent: 85, mode: "economy", warning: true },
    { usedPercent: 100, mode: "manual_core_only", warning: true }
  ] as const;
  const budget = expected.map((row) => {
    const decision = budgetPolicy(row.usedPercent);
    if (decision.mode !== row.mode || decision.warning !== row.warning) {
      failures.push(`budget gate at ${row.usedPercent}% gave ${decision.mode}/${decision.warning}`);
    }
    // The degradation that matters downstream: which model tier a capable task is allowed to use.
    const tier = tierUnderMode("capable", decision.mode);
    return { ...row, actual: decision, capableTierBecomes: tier, model: modelForTier(tier, {}) ?? "(runtime default)" };
  });
  if (tierUnderMode("capable", "economy") !== "routine") failures.push("economy did not downgrade the capable tier");
  console.info(JSON.stringify({ status: "gate_7_budget", budget }, null, 1));
} finally {
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "gates_failed" : "gates_passed", failures }));
process.exitCode = failures.length ? 1 : 0;
