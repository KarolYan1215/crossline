/**
 * Which passes a worker runs (docs/device-mode.md). A full worker runs everything, model work included. A linked device runs only what
 * needs this machine — none of them calls a model — and sends the results; every model pass belongs to the hosted site, which is the one
 * place the account's quota is spent.
 */
export type WorkerMode = "full" | "device";

/** What a device does: read this machine, then send. */
export const DEVICE_PASSES = ["screen_activity", "folders", "recordings_local", "agent_history", "uplink"] as const;

/** Passes that run a model, by the name the full worker gives them: never on a device. */
export const MODEL_PASSES = [
  "capture_analysis", "backplan", "step_plan", "dedupe_review", "titles", "goal_split", "milestone_risk", "first_drafts", "milestone_gate", "materials",
  "tutorials", "curator", "energy_advice", "mine_skills", "public_skills", "portrait", "automations", "nightly_flywheel", "diligence", "workflows",
  "assistant", "folder_lines", "recording_digest", "calendar_lines", "mail_triage", "onboarding_extract", "sponsor_eval"
] as const;

/** Passes that are not model work but belong to the primary ledger (they would act on a stale copy here). */
export const PRIMARY_ONLY_PASSES = ["calendar_sync", "calendar_publish", "notifications", "date_advance", "lessons", "return_tidy", "auto_approve", "work_split_repair"] as const;

export type WorkerPass = (typeof DEVICE_PASSES)[number] | (typeof MODEL_PASSES)[number] | (typeof PRIMARY_ONLY_PASSES)[number];

export const workerMode = (link: { url: string } | undefined): WorkerMode => link ? "device" : "full";

export function passesFor(mode: WorkerMode): readonly WorkerPass[] {
  if (mode === "device") return DEVICE_PASSES;
  return [...DEVICE_PASSES.filter((pass) => pass !== "uplink"), ...MODEL_PASSES, ...PRIMARY_ONLY_PASSES];
}
