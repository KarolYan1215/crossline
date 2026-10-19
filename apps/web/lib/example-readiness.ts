import { DEFAULT_AVAILABILITY, LINE_PROFILES_SETTING, START_CONFIRMED_SETTING, type AccessContext, type StoredLineProfile } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { LINE_SETTING, defaultIdentityPacks, type LineSpec } from "@crossline/identity-packs";

const EXAMPLE_AT = "2026-09-01T00:00:00.000Z";

/**
 * What the start standard asks for (`readyToStart`), written for the example board: each built-in line with a description, two
 * candidates and an adopted goal, the default weekly hours as the interview's proposal (the same windows the scheduler uses when none
 * is stored, so the schedule does not change), one current project per line that the person said has no deadline, and the person's
 * confirmation of all of it (`START_CONFIRMED_SETTING`). Only what is not
 * there yet is written, so it is safe to run on every load. Used by `ensureSeeded` with example data on, and by tests.
 */
export function seedExampleReadiness(store: CrosslineStore, ctx: AccessContext): void {
  const ws = ctx.workspaceId;
  const lines = defaultIdentityPacks().filter((pack) => pack.kind === "identity");
  if (!store.getSetting(ws, LINE_SETTING)) {
    const specs: LineSpec[] = lines.map((pack) => {
      const goal = `成为能交出可验收成果的${pack.label}`;
      // Written with the clock the account had, as `currentSpecs` does: the built-in lines kept research first.
      return { id: pack.id, label: pack.label, color: pack.id, goal, goals: [goal], createdAt: EXAMPLE_AT, ...(pack.masterClock ? { rank: 1 } : {}) };
    });
    store.setSetting(ws, LINE_SETTING, JSON.stringify(specs));
  }
  if (!store.getSetting(ws, LINE_PROFILES_SETTING)) {
    const profiles: Record<string, StoredLineProfile> = Object.fromEntries(lines.map((pack) => [pack.id, {
      description: `「${pack.label}」这条线的示例描述`,
      attributes: [{ text: "可验收成果", kind: "ability", sourceRef: "reply-1" }, { text: "稳定节奏", kind: "state", sourceRef: "reply-1" }]
    }]));
    store.setSetting(ws, LINE_PROFILES_SETTING, JSON.stringify(profiles));
  }
  if (!store.getSetting(ws, "schedule.availability.proposed") && !store.getSetting(ws, "schedule.availability"))
    store.setSetting(ws, "schedule.availability.proposed", JSON.stringify({ windows: DEFAULT_AVAILABILITY, why: "示例账号的作息" }));
  const projects = new Set(store.listProjects(ws).map((project) => project.id));
  for (const pack of lines) {
    const id = `${pack.id}-example`;
    if (!projects.has(id))
      store.saveProject({ id, ownerId: ctx.principalId, workspaceId: ws, identityId: pack.id, name: `${pack.label}示例项目`, summary: "", status: "active",
        createdAt: EXAMPLE_AT, updatedAt: EXAMPLE_AT });
    if (!store.listProfileFacts(ws).some((fact) => fact.projectId === id && fact.slot === "no_deadline"))
      store.upsertProfileFact({ workspaceId: ws, identityId: pack.id, projectId: id, slot: "no_deadline", value: "没有截止", status: "confirmed",
        sourceRef: "reply-1", sourceQuote: "没有截止", updatedAt: EXAMPLE_AT });
  }
  if (!store.getSetting(ws, START_CONFIRMED_SETTING)) store.setSetting(ws, START_CONFIRMED_SETTING, JSON.stringify({ at: EXAMPLE_AT, via: "person" }));
}
