/**
 * The Skills merged on 2026-11-27 (docs/plans/condense-1127.md §B): 66 became 35, one Skill per scenario, each old Skill now a mode
 * of the merged one. A run names its Skill with the mode as a third part (`crossline:crossline-portrait:report`): the runner switches on
 * and mentions `crossline:crossline-portrait` and puts the mode into the input (`modeField`), and everything keyed by Skill — tiers,
 * routing, the model gate, usage, provider records — is keyed `crossline-portrait:report`, so each old Skill keeps what it had.
 *
 * Records written before the merge (usage rows, a provider's conformance results, a person's model choice) carry the old names; they
 * are read through `currentSkillKeys`, never rewritten.
 */
export const MERGED_SKILLS: Readonly<Record<string, readonly string[]>> = {
  "crossline-portrait-writer": ["crossline-portrait:report", "crossline-portrait:gap"],
  "crossline-portrait-narrative": ["crossline-portrait:narrative"],
  "crossline-portrait-illustrator": ["crossline-portrait:figure"],
  "crossline-method-research": ["crossline-line-method:research"],
  "crossline-insight-compiler": ["crossline-line-method:rules"],
  "crossline-milestone-architect": ["crossline-milestone-architect:design"],
  "crossline-goal-splitter": ["crossline-milestone-architect:split"],
  "crossline-goal-backplanner": ["crossline-goal-backplanner:backplan"],
  "crossline-task-titler": ["crossline-goal-backplanner:title"],
  "crossline-artifact-planner": ["crossline-cross-line-planner:artifacts"],
  "crossline-flywheel-scout": ["crossline-cross-line-planner:flywheel"],
  "crossline-milestone-risk-reviewer": ["crossline-milestone-review:risk"],
  "crossline-gate-admission": ["crossline-milestone-review:admission"],
  "crossline-step-planner": ["crossline-task-planner:steps"],
  "crossline-manualbook-designer": ["crossline-task-planner:manual"],
  "crossline-archetype-curator": ["crossline-task-planner:archetype"],
  "crossline-plan-explainer": ["crossline-schedule-advisor:explain"],
  "crossline-energy-advisor": ["crossline-schedule-advisor:energy"],
  "crossline-milestone-gate": ["crossline-evidence-judge:milestone"],
  "crossline-gate-completion": ["crossline-evidence-judge:completion"],
  "crossline-progress-judge": ["crossline-evidence-judge:progress"],
  "crossline-deliverable-check": ["crossline-evidence-judge:deliverable"],
  "crossline-gate-priority": ["crossline-focus:priority"],
  "crossline-gate-front": ["crossline-focus:front"],
  "crossline-gate-attention": ["crossline-weekly-review:attention"],
  "crossline-gate-setback": ["crossline-weekly-review:setback"],
  "crossline-weekly-insight": ["crossline-weekly-review:insight"],
  "crossline-form-filler": ["crossline-form-page:fill"],
  "crossline-form-observer": ["crossline-form-page:observe"],
  "crossline-form-browser-agent": ["crossline-form-page:browser"],
  "crossline-form-checker": ["crossline-outward-check:form"],
  "crossline-gate-night": ["crossline-outward-check:pending", "crossline-outward-check:week"],
  "crossline-due-diligence": ["crossline-research:diligence"],
  "crossline-onboarding-research": ["crossline-research:onboarding"],
  "crossline-material-researcher": ["crossline-research:material"],
  "crossline-skill-scout": ["crossline-research:skills"],
  "crossline-opportunity-needs": ["crossline-research:needs"],
  "crossline-opportunity-reader": ["crossline-page-reader:opportunity"],
  "crossline-visa-finder": ["crossline-page-reader:visa"],
  "crossline-calendar-classifier": ["crossline-line-filer:calendar"],
  "crossline-folder-classifier": ["crossline-line-filer:folder"],
  "crossline-time-attributor": ["crossline-line-filer:time"],
  "crossline-recording-digest": ["crossline-capture-digest:recording"],
  "crossline-source-digest": ["crossline-capture-digest:source"],
  "crossline-background-facts": ["crossline-capture-digest:background"],
  "crossline-mail-triage": ["crossline-inbox-triage:mail"],
  "crossline-import-triage": ["crossline-inbox-triage:import"],
  "crossline-agent": ["crossline-agent:shell"],
  "crossline-agent-tools": ["crossline-agent:functions"]
};

/** The input field a merged Skill's mode goes in, where the owner named one other than `mode`. */
const MODE_FIELDS: Readonly<Record<string, string>> = { "crossline-agent": "toolset", "crossline-form-page": "engine", "crossline-research": "purpose" };

/** The plugins Crossline's own Skills come from; the weekly drill moved to the owner's own plugin on 2026-11-27. */
const PLUGIN_PREFIX = /^crossline(-personal)?:/;

/** A run's Skill name without its plugin: `crossline:crossline-portrait:report` → `crossline-portrait:report`. */
export const skillKey = (name: string): string => name.replace(PLUGIN_PREFIX, "");

/** The mode a Skill name carries, if any: `crossline:crossline-portrait:report` → `report`. */
export function skillModeOf(name: string): string | undefined {
  const key = skillKey(name);
  const at = key.indexOf(":");
  return at < 0 ? undefined : key.slice(at + 1);
}

/** The Skill itself, the name the runtime knows: `crossline:crossline-portrait:report` → `crossline:crossline-portrait`. */
export function skillBase(name: string): string {
  const mode = skillModeOf(name);
  return mode === undefined ? name : name.slice(0, name.length - mode.length - 1);
}

/** Which input field carries a merged Skill's mode (`mode` unless the Skill names another). */
export const modeField = (name: string): string => MODE_FIELDS[skillKey(skillBase(name))] ?? "mode";

/** What a Skill key stored before the merge stands for now (one old Skill may be two modes); any other key stands for itself. */
export const currentSkillKeys = (name: string): readonly string[] => MERGED_SKILLS[skillKey(name)] ?? [skillKey(name)];

/** The Skill (no mode) a stored name belongs to now, for showing usage per Skill: `crossline:crossline-step-planner` → `crossline-task-planner`. */
export const currentSkillOf = (name: string): string => skillBase(currentSkillKeys(name)[0]!);
