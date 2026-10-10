/**
 * Setting keys read by both the web app and the worker. A key spelled in two places drifts: the plan
 * explainer read `goal.<id>` while the web app wrote `goal.settings:<id>`, so the explainer never saw a
 * goal marked important or a confirmed deadline. One builder, imported by both sides.
 */
export const goalSettingKey = (milestoneId: string) => `goal.settings:${milestoneId}`;

/** The weekly availability pattern (`AvailabilityWindow[]`); the step planner sizes a task's window from it. */
export const AVAILABILITY_SETTING = "schedule.availability";
/** What the interview proposed from the rhythm the person described (`{windows, why}`); used until a pattern is saved. */
export const AVAILABILITY_PROPOSED_SETTING = "schedule.availability.proposed";
/** `"1"` on the one workspace whose account owns this machine's Codex runtime and the shell assistant (decided once by the worker). */
export const RUNTIME_OWNER_SETTING = "deployment.runtimeOwner";

/** The last calendar read that failed (`{code, message, sources, at}`), written by the worker, cleared by a clean read. */
export const CALENDAR_SYNC_FAILURE = "calendar.sync.failure";
/** The last automatic publish to the Crossline calendar that failed, written by the web's timer, cleared by a success. */
export const CALENDAR_PUBLISH_FAILURE = "calendar.publish.failure";
/**
 * What is waiting for the person, as the web last saw it (`{at, pending, asks:[{id,title,urgency,dueDay,path}]}`): the
 * worker's notifications read this so the brief, the badge and the urgent messages count the same things.
 */
export const ATTENTION_SNAPSHOT = "attention.snapshot";
/** The person's devices that receive push notifications (`PushSubscriptionRecord[]`, see packages/connectors/src/web-push.ts). */
export const PUSH_SUBSCRIPTIONS = "push.subscriptions";

/**
 * The cross-line artifact plan (`StoredArtifactPlan`, packages/core/src/artifact-plan.ts): what each line produces this period and the
 * supply pairs between lines. In the ledger, not memory, so redoing one line keeps the others' part and a backup carries it.
 */
export const ARTIFACT_PLAN_SETTING = "flywheel.artifacts";
