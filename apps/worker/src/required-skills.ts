/**
 * The Skills the supervisor requires before it reports ready. One missing name blocks every model call (CODEX_PLUGIN_SKILLS_MISSING),
 * so this list must name only Skills that exist: `required-skills.test.ts` checks it against the plugin's skill directories. The retired
 * `crossline-assistant` stayed here for two days after its directory was deleted, and the runtime went on starting only while its
 * plugin cache still held the old copy.
 */
export const REQUIRED_SKILLS = [
  "crossline:crossline-automation-stripper", "crossline:crossline-milestone-gate",
  "crossline:crossline-flywheel-scout", "crossline:crossline-manualbook-designer", "crossline:crossline-material-researcher", "crossline:crossline-material-writer", "crossline:crossline-milestone-architect", "crossline:crossline-artifact-planner",
  "crossline:crossline-goal-backplanner", "crossline:crossline-background-facts",
  "crossline:crossline-onboarding", "crossline:crossline-due-diligence", "crossline:crossline-plan-explainer", "crossline:crossline-weekly-insight",
  "crossline:crossline-agent", "crossline:crossline-step-planner", "crossline:crossline-validation-reviewer", "crossline:crossline-progress-judge", "crossline:crossline-concierge", "crossline:crossline-archetype-curator", "crossline:crossline-task-titler", "crossline:crossline-portrait-writer", "crossline:crossline-portrait-illustrator", "crossline:crossline-calendar-classifier", "crossline:crossline-folder-classifier", "crossline:crossline-goal-splitter", "crossline:crossline-insight-compiler", "crossline:crossline-skill-scout"
];
