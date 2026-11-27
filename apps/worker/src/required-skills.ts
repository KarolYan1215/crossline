/**
 * The Skills the supervisor requires before it reports ready. One missing name blocks every model call (CODEX_PLUGIN_SKILLS_MISSING),
 * so this list must name only Skills that exist: `required-skills.test.ts` checks it against the plugin's skill directories. The retired
 * `crossline-assistant` stayed here for two days after its directory was deleted, and the runtime went on starting only while its
 * plugin cache still held the old copy.
 *
 * Since 2026-11-27 (docs/plans/condense-1127.md §B) one Skill per scenario, each run naming a mode; these are the Skills themselves.
 * Every Skill with a production caller is here (the opportunity agent's, the deliverable check, the energy review, the method research
 * and the quote reader were missing before). The weekly drill is the owner's own plugin's (`crossline-personal`), not required.
 */
export const REQUIRED_SKILLS = [
  "crossline:crossline-onboarding", "crossline:crossline-onboarding-extract", "crossline:crossline-portrait",
  "crossline:crossline-line-method", "crossline:crossline-milestone-architect", "crossline:crossline-goal-backplanner",
  "crossline:crossline-cross-line-planner", "crossline:crossline-milestone-review", "crossline:crossline-task-planner",
  "crossline:crossline-schedule-advisor", "crossline:crossline-evidence-judge", "crossline:crossline-focus", "crossline:crossline-weekly-review",
  "crossline:crossline-form-page", "crossline:crossline-outward-check", "crossline:crossline-research", "crossline:crossline-page-reader",
  "crossline:crossline-line-filer", "crossline:crossline-capture-digest", "crossline:crossline-inbox-triage", "crossline:crossline-agent",
  "crossline:crossline-automation-stripper", "crossline:crossline-material-writer", "crossline:crossline-validation-reviewer",
  "crossline:crossline-web-scout", "crossline:crossline-query-review", "crossline:crossline-quote-reader", "crossline:crossline-concierge",
  "crossline:crossline-mail-reply-drafter", "crossline:crossline-media-describer", "crossline:crossline-favourite-topics",
  "crossline:crossline-dictation-corrector", "crossline:crossline-automation-designer"
];

/** The owner's own plugin in the same local marketplace (the weekly drill, J7), installed beside `crossline` and never required. */
export const PERSONAL_PLUGIN = "crossline-personal";
