/**
 * Every type the ledger holds (docs/plans/condense-1127.md §C, 2026-11-27): one source of truth for writers, readers and
 * `pnpm review:ledger`. `CrosslineStore.appendEvent` and `listEvents` take only these names, so a misspelt or retired type fails
 * typecheck instead of writing a row nobody reads.
 *
 * - A few types stand alone: hot state sources with many readers and a meaning of their own.
 * - `<entity>.changed` carries what changed as `payload.change`, one of the values listed for it.
 * - `job.ran` is a background run, cooldown or backfill marker: `payload.job` and `payload.state`.
 * - `person.decided` is a decision of the person's that no code reads back, kept as audit: `payload.subject` and `payload.decision`.
 *
 * Per-tick progress is not here: it goes to the JSONL logs (CLAUDE.md 「Telemetry is not the ledger」).
 */
export const STANDALONE_EVENT_TYPES = [
  "calendar.published", "capture.created", "dates.decided", "dates.extracted", "gate.judged", "git.commit_seen", "milestone.proposed",
  "milestone_gate.judged", "notification.sent", "op.applied", "op.undone", "work_order.transitioned"
] as const;

/** `<entity>.changed` → the values its `payload.change` may take. */
export const EVENT_CHANGES = {
  "agent.changed": ["approval_decided", "approval_requested", "blocked_acknowledged", "category_requested", "question_answered", "question_expired", "question_requested", "retry_requested", "task_blocked", "task_completed", "task_files_checked", "task_reopened", "task_requested", "task_reviewed", "task_settled"],
  "artifact.changed": ["handed_off", "plan_saved"],
  "ask.changed": ["answered", "auto_answered", "question_asked", "return_answered", "snoozed"],
  "automation.changed": ["created", "deleted", "design_attempted", "design_failed", "edited", "refused", "requested", "restored", "suggested"],
  "capture.changed": ["discarded"],
  "deliverable.changed": ["gap_answered", "judged", "settled", "withdrawn"],
  "energy.changed": ["advice_dismissed", "observed", "transition_outcome", "transition_predicted"],
  "execution.changed": ["confirmed", "paused", "resumed", "stopped_at"],
  "gate.changed": ["confirmed", "drill_answered", "drill_graded", "drill_issue_failed", "drill_issued", "overridden", "setback_reported"],
  "goal.changed": ["backplan_blocked", "backplan_declined", "backplan_input_resolved", "backplan_input_supplied", "backplan_input_waiting", "backplan_proposed", "backplan_rerun_requested", "datepair_created", "settings_confirmed"],
  "import.changed": ["closed_upstream", "item_captured", "item_merged"],
  "insight.changed": ["approved", "auto_approved", "found", "rejected", "revoked", "weekly_proposal"],
  "line.changed": ["candidates_split", "created", "goal_edit_adopted", "goal_edit_dismissed", "goal_split", "ranked", "redraft_requested", "set_up", "updated"],
  "mail.changed": ["reply_closed", "reply_drafted", "sent_seen"],
  "materials.changed": ["blocked", "manualbook_built", "questions", "retry_requested", "tutorial_blocked", "tutorial_requested"],
  "milestone_gate.changed": ["auto_acceptance_revoked", "auto_accepted", "blocked", "retry_requested"],
  "milestone_relation.changed": ["checked", "decided", "proposed", "refuted", "removed"],
  "milestone.changed": ["created", "kept_parked", "overdue", "overdue_resolved", "parked", "retrospective", "revised", "risk_accepted", "risk_reviewed", "unparked"],
  "model.changed": ["provider_changed", "provider_conformance"],
  "onboarding.changed": ["dates_unrecorded", "finish_requested", "round_edited", "unrecorded"],
  "opportunity.changed": ["apply_self", "confirmed", "form_blocked", "form_confirmed", "form_continued", "form_fallback", "form_opened", "form_page", "form_previewed", "form_queued", "form_ready_to_submit", "form_receipt_asked", "form_session_lost", "form_started", "form_stopped", "form_submit_clicked", "form_submitted", "milestone_written", "needs_derived", "outcome", "result", "watch_state"],
  "plan.changed": ["approved", "change_archived", "explained", "reality_changed", "version_archived", "week_committed"],
  "portrait.changed": ["blocked", "gap_rewritten", "requested", "written"],
  "profile.changed": ["confirmed", "design_note_set", "instructions_set"],
  "recording.changed": ["digested", "failed", "silent", "transcribed", "transcripts_deleted"],
  "remote.changed": ["approval", "command", "files", "folder_read", "form_submitted", "message", "refused", "session_ended", "session_interrupted", "session_started"],
  "report.changed": ["item_added", "item_dismissed"],
  "skill.changed": ["grown_attempted", "grown_consented", "grown_created", "grown_feedback", "grown_merged", "grown_rejected", "grown_removed", "grown_restored", "grown_reverted", "grown_revised", "grown_revision_rejected", "grown_unmerged", "grown_updated", "mine_blocked", "mine_rewritten", "public_installed", "public_lines_added", "public_rejected", "public_removed", "public_scouted", "public_search_requested", "public_updated", "public_wanted", "workflow_requested"],
  "source.changed": ["project_assigned", "project_cleared", "project_inferred", "refused"],
  "task.changed": ["criteria_assessed", "criterion_confirmed", "duplicate_prevented", "material_provided", "merged", "need_checked", "need_from_mail", "note", "overdue_resolved", "postponed", "progress_judged", "progress_reported", "renamed", "step_estimated", "step_focused", "step_progress", "step_resume_noted", "steps_blocked", "steps_planned", "steps_replan_requested"],
  "validation.changed": ["reviewed", "warned"],
  "waiting.changed": ["arrived", "arrived_by_file", "blocks_added", "cancelled", "created", "deferred", "mail_seen", "reopened"],
  "work_order.changed": ["archived", "assessment_answered", "assessment_deferred", "assessment_pending", "auto_approval_revoked", "auto_approved", "auto_closed", "block_confirmed", "block_snoozed", "byproduct_planned", "deferred", "drill_swept", "due_advanced", "due_changed", "due_confirmed", "missed_handled", "outcome_reported", "progress_answered", "reopened"]
} as const;

/** `job.ran`: each job and the states it reports. */
export const JOB_STATES = {
  "archetypes.curate": ["done"],
  "calendar.publish.google": ["done"],
  "collect": ["done", "handover", "started"],
  "date.advance": ["done"],
  "diligence": ["done"],
  "flywheel.nightly": ["done", "failed", "skipped"],
  "lessons.codex_memory_import": ["done"],
  "mail.known": ["done"],
  "mail.triage": ["done"],
  "method.research": ["blocked", "done"],
  "onboarding.citation_check": ["warned"],
  "onboarding.extract": ["done", "failed"],
  "opportunity.scout": ["done"],
  "opportunity.watches.migrate": ["done"],
  "profile.points.migrate": ["done"],
  "profile.scale.analyse": ["done"],
  "repair.frozen_race": ["done"],
  "repair.import_duplicates": ["done"],
  "repair.line_attributes": ["done"],
  "repair.own_completion": ["done"],
  "return.tidy": ["done"],
  "schedule.time_zone_detect": ["done"],
  "selfcheck": ["done"],
  "site.read": ["done", "resumed"],
  "skill.grown.absorb": ["dropped"],
  "skill.grown.improve": ["skipped", "started"],
  "skill.grown.revise": ["skipped"],
  "skill.grown.run": ["done", "result"],
  "tasks.title": ["done"],
  "weekly_review.insight": ["done"],
  "work_order.family_backfill": ["done"],
  "work_split.reorganize": ["done"]
} as const;

/** `person.decided`: what the decision was about. */
export const PERSON_SUBJECTS = [
  "apply.kit", "apply.profile", "availability", "calendar.write", "capture", "diligence", "estimate", "favourites", "import", "invite", "mail",
  "onboarding", "opportunity", "opportunity.watch", "permission", "portrait", "prep", "profile", "schedule", "skill", "skill.grown", "source",
  "sources", "step", "target"
] as const;

export type StandaloneEventType = (typeof STANDALONE_EVENT_TYPES)[number];
export type ChangedEventType = keyof typeof EVENT_CHANGES;
export type EventChange<T extends ChangedEventType = ChangedEventType> = (typeof EVENT_CHANGES)[T][number];
export type JobName = keyof typeof JOB_STATES;
export type JobState<J extends JobName = JobName> = (typeof JOB_STATES)[J][number];
export type PersonSubject = (typeof PERSON_SUBJECTS)[number];
export type EventType = StandaloneEventType | ChangedEventType | "job.ran" | "person.decided";

export const EVENT_TYPES: readonly EventType[] = [...STANDALONE_EVENT_TYPES, ...(Object.keys(EVENT_CHANGES) as ChangedEventType[]), "job.ran", "person.decided"];

/** The payload discriminator each family must carry. */
export type EventPayload<T extends EventType> =
  T extends ChangedEventType ? { change: EventChange<T> } & Record<string, unknown>
  : T extends "job.ran" ? { [J in JobName]: { job: J; state: JobState<J> } }[JobName] & Record<string, unknown>
  : T extends "person.decided" ? { subject: PersonSubject; decision: string } & Record<string, unknown>
  : unknown;

/** What changed in a `<entity>.changed` event, or undefined. */
export const changeOf = (event: { payload: unknown }): string | undefined => {
  const payload = event.payload as { change?: unknown } | null;
  return typeof payload?.change === "string" ? payload.change : undefined;
};
