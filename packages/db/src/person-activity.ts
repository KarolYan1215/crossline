/**
 * The person's own actions — what they said in the input box or the interview, timing or confirming work, an answered question, a
 * capture or discard, a milestone or line edit, a step's progress, an energy self-report — never anything the system did. One row per
 * action, as `at`, for workspace `@ws` from `@since`.
 */
const PERSON_EVENTS: Record<string, string[]> = {
  "ask.changed": ["answered", "snoozed", "return_answered"], "work_order.changed": ["block_confirmed"],
  "execution.changed": ["confirmed", "paused", "resumed"], "capture.changed": ["discarded"],
  "milestone.changed": ["revised", "retrospective", "risk_accepted"],
  // Setting up: a line or its goal changed, a batch of dates decided, a file filed. Missing these, someone in the middle of the interview
  // read as days away, and the engagement tier held back the planning their answers were for.
  "line.changed": ["created", "updated", "ranked", "set_up"], "source.changed": ["project_assigned"],
  // Decisions about skills the person makes on Skill 库 (2026-10-20): a workflow's risks accepted, its feedback, a version taken back.
  "skill.changed": ["grown_consented", "grown_feedback", "grown_reverted", "grown_unmerged"]
};
/** Events that are the person's whole: no discriminator to check. */
const PERSON_TYPES = ["capture.created", "dates.decided"];
/** The person's decisions on Skill 库 kept as audit: a script's leave, a site logged in. */
const PERSON_DECISIONS = [["skill", "scripts_allowed"], ["skill", "scripts_revoked"], ["skill.grown", "logged_in"]];
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(",");
export const PERSON_ACTIVITY_SQL = `
  SELECT created_at AS at FROM conversation_messages WHERE workspace_id = @ws AND role = 'person' AND created_at >= @since
  UNION ALL SELECT created_at FROM onboarding_messages WHERE workspace_id = @ws AND role = 'user' AND created_at >= @since
  UNION ALL SELECT started_at FROM executions WHERE workspace_id = @ws AND started_at >= @since
  UNION ALL SELECT ended_at FROM executions WHERE workspace_id = @ws AND ended_at IS NOT NULL AND ended_at >= @since
  UNION ALL SELECT observed_at FROM energy_observations WHERE workspace_id = @ws AND source = 'self_report' AND observed_at >= @since
  UNION ALL SELECT created_at FROM events WHERE workspace_id = @ws AND created_at >= @since
    AND (type IN (${list(PERSON_TYPES)})
      OR ${Object.entries(PERSON_EVENTS).map(([type, changes]) => `(type = '${type}' AND json_extract(payload_json, '$.change') IN (${list(changes)}))`).join(" OR ")}
      OR ${PERSON_DECISIONS.map(([subject, decision]) => `(type = 'person.decided' AND json_extract(payload_json, '$.subject') = '${subject}' AND json_extract(payload_json, '$.decision') = '${decision}')`).join(" OR ")}
      OR (type = 'task.changed' AND json_extract(payload_json, '$.change') = 'step_progress' AND json_extract(payload_json, '$.source') IN ('user', 'person', 'confirm'))
      -- An undoable change made on a page (availability, shares, weights, a lock, a due day…) and an undo (2026-10-20: these were not
      -- counted, so a plan edit on one side read as no activity and the ledger sync could copy the other side over it). Ops the worker
      -- writes for itself carry bySystem; the daily merge's older ones are known by their inverse.
      OR (type = 'op.applied' AND json_extract(payload_json, '$.bySystem') IS NULL
        AND COALESCE(json_extract(payload_json, '$.inverse.kind'), '') <> 'task.unmerge')
      OR type = 'op.undone'
      -- A public skill the person added by its link (the scout's own finds carry no via).
      OR (type = 'skill.changed' AND substr(json_extract(payload_json, '$.change'), 1, 7) = 'public_' AND json_extract(payload_json, '$.via') = 'link'))`;
