import "server-only";
import { checkGoalParts, composeGoal, plainComposeGoal, type AccessContext } from "@crossline/core";
import { DOMAIN_PACKS, LINE_PALETTE, LINE_SETTING, MAX_HARD_LINES, defaultIdentityPacks, domainLineId, freeLineColor, identityPacksFor, isLineDomain, lineForDomain, newLineId,
  readLineSpecs, type IdentityPack, type LineDomain, type LineSpec } from "@crossline/identity-packs";
import { getStore } from "./crossline";

/** Every pack this workspace works with: its lines (built-in or its own) and the capacity pack. */
export function linePacks(ctx: AccessContext, options: { includeArchived?: boolean } = {}): IdentityPack[] {
  return identityPacksFor((key) => getStore().getSetting(ctx.workspaceId, key), options);
}
/** The lines alone (no capacity pack). */
export const identityLines = (ctx: AccessContext) => linePacks(ctx).filter((pack) => pack.kind === "identity");
/** Line id → name, archived lines included so old work still reads with its line's name. */
export const lineLabels = (ctx: AccessContext): Record<string, string> =>
  Object.fromEntries(linePacks(ctx, { includeArchived: true }).map((pack) => [pack.id, pack.label]));

/** The stored list, or the built-in four written out as the person's own (the first time an account edits its lines). */
function currentSpecs(ctx: AccessContext): LineSpec[] {
  const stored = readLineSpecs((key) => getStore().getSetting(ctx.workspaceId, key));
  if (stored) return stored;
  // Written out with the clock the account had: the built-in lines kept research first.
  return defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label, color: pack.id, goal: "", createdAt: "",
    ...(pack.masterClock ? { rank: 1 } : {}) }));
}
function saveSpecs(ctx: AccessContext, specs: LineSpec[], event: { type: string; entityId: string; payload: Record<string, unknown> }): void {
  const store = getStore();
  store.setSetting(ctx.workspaceId, LINE_SETTING, JSON.stringify(specs));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${event.type}:${event.entityId}:${Date.now()}`, ...event });
}

/** A new line: its name, its long-term goal and a free colour. Its interview (`/onboarding?line=<id>`) comes next. */
export function addLine(ctx: AccessContext, input: { label: string; goal: string; color?: string; goals?: string[]; hard?: boolean; rank?: number; domain?: LineDomain }): { ok: true; id: string } | { ok: false; code: string; lineId?: string } {
  const domain = isLineDomain(input.domain) ? input.domain : undefined;
  const label = (input.label.trim() || (domain ? DOMAIN_PACKS[domain].noun : "")).slice(0, 20);
  if (!label) return { ok: false, code: "LINE_LABEL_REQUIRED" };
  const specs = currentSpecs(ctx);
  if (specs.some((line) => !line.archived && line.label === label)) return { ok: false, code: "LINE_LABEL_TAKEN" };
  // One live line per domain: a second one is refused with the line that has it, so the page can offer to tag that one instead.
  const holder = domain ? lineForDomain(specs, domain) : undefined;
  if (holder) return { ok: false, code: "LINE_DOMAIN_TAKEN", lineId: holder.id };
  const id = domain ? domainLineId(domain, label, specs.map((line) => line.id)) : newLineId(label, specs.map((line) => line.id));
  const color = input.color && LINE_PALETTE[input.color] ? input.color : domainColor(domain, specs);
  if (input.hard && specs.filter((line) => line.hard && !line.archived).length >= MAX_HARD_LINES) return { ok: false, code: "LINE_HARD_LIMIT" };
  const goals = cleanGoals(input.goals ?? (input.goal ? [input.goal] : []));
  saveSpecs(ctx, [...specs, { id, label, color, goal: goals[0] ?? "", goals, createdAt: new Date().toISOString(),
    ...(input.hard ? { hard: true } : {}), ...(input.rank ? { rank: input.rank } : {}), ...(domain ? { domain } : {}) }],
    { type: "line.created", entityId: id, payload: { label, color, ...(domain ? { domain } : {}) } });
  return { ok: true, id };
}

/**
 * Renames a line, sets its goal or colour, or archives it (its work stays, filed under it). `goalParts` adopts a goal built from
 * attributes (§4.1): the parts are kept in the order given and `goals[0]` becomes the sentence composed from them; a goal changed as a
 * whole sentence drops parts that no longer compose it (the split pass splits it again).
 */
export function updateLine(ctx: AccessContext, id: string, change: { label?: string; goal?: string; goals?: string[]; goalParts?: string[]; color?: string; archived?: boolean; hard?: boolean; rank?: number | null; domain?: LineDomain | null }): { ok: true } | { ok: false; code: string; message?: string; lineId?: string } {
  const specs = currentSpecs(ctx);
  const line = specs.find((item) => item.id === id);
  if (!line) return { ok: false, code: "LINE_NOT_FOUND" };
  // Tagging a line with a domain (投资者 → 财富) is refused while another live line has it; restoring an archived one is checked too.
  const domainAfter = change.domain === null ? undefined : change.domain ?? line.domain;
  const archivedAfter = change.archived ?? line.archived;
  const holder = domainAfter && !archivedAfter ? lineForDomain(specs.filter((item) => item.id !== id), domainAfter) : undefined;
  if (holder) return { ok: false, code: "LINE_DOMAIN_TAKEN", lineId: holder.id };
  if (change.hard && !line.hard && specs.filter((item) => item.hard && !item.archived).length >= MAX_HARD_LINES) return { ok: false, code: "LINE_HARD_LIMIT" };
  const label = change.label !== undefined && change.label.trim() ? change.label.trim().slice(0, 20) : line.label;
  const oldGoals = line.goals?.length ? line.goals : line.goal ? [line.goal] : [];
  let goals = change.goals !== undefined ? cleanGoals(change.goals) : change.goal !== undefined ? cleanGoals([change.goal, ...oldGoals.slice(1)]) : undefined;
  let goalParts = line.goalParts;
  if (change.goalParts !== undefined) {
    const checked = checkGoalParts(change.goalParts);
    if (!checked.ok) return { ok: false, code: checked.code, message: checked.message };
    const composed = composeGoal(checked.parts, label);
    goals = cleanGoals([composed, ...(goals ?? oldGoals).slice(1).filter((goal) => goal !== composed)]);
    goalParts = checked.parts;
  } else if (goals && goals[0] !== oldGoals[0]) {
    goalParts = undefined;
  } else if (goalParts?.length && label !== line.label && (oldGoals[0] === composeGoal(goalParts, line.label) || oldGoals[0] === plainComposeGoal(goalParts, line.label))) {
    // A renamed line's composed goal follows its new name.
    goals = cleanGoals([composeGoal(goalParts, label), ...oldGoals.slice(1)]);
  }
  const { goalParts: _parts, ...rest } = line;
  const next: LineSpec = { ...rest, label,
    ...(goals ? { goals, goal: goals[0] ?? "" } : {}),
    ...(goalParts?.length ? { goalParts } : {}),
    ...(change.color && LINE_PALETTE[change.color] ? { color: change.color } : {}),
    ...(change.archived !== undefined ? { archived: change.archived } : {}) };
  if (change.hard === true) next.hard = true;
  if (change.hard === false) delete next.hard;
  if (change.rank === null) delete next.rank;
  if (typeof change.rank === "number" && change.rank >= 1) next.rank = Math.round(change.rank);
  if (change.domain === null) delete next.domain;
  if (isLineDomain(change.domain)) next.domain = change.domain;
  saveSpecs(ctx, specs.map((item) => item.id === id ? next : item), { type: "line.updated", entityId: id, payload: change });
  return { ok: true };
}

/** Long-term goals as kept: trimmed, de-duplicated, at most eight of at most 300 characters (a goal composed of many attributes is long). */
function cleanGoals(goals: string[]): string[] {
  return [...new Set(goals.map((goal) => goal.trim().slice(0, 300)).filter(Boolean))].slice(0, 8);
}

/** Sets the 12–24 month order: the listed lines ranked 1, 2, …; every other line runs in parallel (no rank). */
export function rankLines(ctx: AccessContext, order: string[]): { ok: true } | { ok: false; code: string } {
  const specs = currentSpecs(ctx);
  const ranked = order.filter((id) => specs.some((line) => line.id === id));
  saveSpecs(ctx, specs.map((line) => { const index = ranked.indexOf(line.id); const { rank: _rank, ...rest } = line; return index >= 0 ? { ...rest, rank: index + 1 } : rest; }),
    { type: "line.ranked", entityId: ctx.workspaceId, payload: { order: ranked } });
  return { ok: true };
}

/** Whether this workspace still has to set its lines: a new account (no lines stored, and nothing planned yet). */
export function needsLineSetup(ctx: AccessContext): boolean {
  const store = getStore();
  if (readLineSpecs((key) => store.getSetting(ctx.workspaceId, key)) !== undefined) return false;
  return !store.listMilestones(ctx.workspaceId).length && !store.listWorkOrders(ctx.workspaceId).length;
}

/**
 * The opening screen's answer: the person's lines in their order — each an identity noun, ranked or in parallel, at most two hard
 * constraints — written as the workspace's lines (replacing the built-in four a new account would otherwise see).
 */
export function setupLines(ctx: AccessContext, lines: Array<{ label: string; ranked: boolean; hard: boolean; domain?: LineDomain }>): { ok: true; ids: string[] } | { ok: false; code: string } {
  const clean = lines.map((line) => ({ ...line, domain: isLineDomain(line.domain) ? line.domain : undefined }))
    .map((line) => ({ ...line, label: (line.label.trim() || (line.domain ? DOMAIN_PACKS[line.domain].noun : "")).slice(0, 20) })).filter((line) => line.label);
  if (!clean.length) return { ok: false, code: "LINE_LABEL_REQUIRED" };
  if (new Set(clean.map((line) => line.label)).size !== clean.length) return { ok: false, code: "LINE_LABEL_TAKEN" };
  if (clean.filter((line) => line.hard).length > MAX_HARD_LINES) return { ok: false, code: "LINE_HARD_LIMIT" };
  const domains = clean.flatMap((line) => line.domain ? [line.domain] : []);
  if (new Set(domains).size !== domains.length) return { ok: false, code: "LINE_DOMAIN_TAKEN" };
  const specs: LineSpec[] = [];
  let rank = 0;
  for (const line of clean) {
    const taken = specs.map((item) => item.id);
    specs.push({ id: line.domain ? domainLineId(line.domain, line.label, taken) : newLineId(line.label, taken), label: line.label,
      color: domainColor(line.domain, specs), goal: "", goals: [], createdAt: new Date().toISOString(),
      ...(line.hard ? { hard: true } : {}), ...(line.ranked ? { rank: ++rank } : {}), ...(line.domain ? { domain: line.domain } : {}) });
  }
  saveSpecs(ctx, specs, { type: "lines.set_up", entityId: ctx.workspaceId, payload: { lines: specs.map((line) => line.label) } });
  return { ok: true, ids: specs.map((line) => line.id) };
}

/** A domain line's own colour while no live line uses it, else the first free one. */
function domainColor(domain: LineDomain | undefined, specs: LineSpec[]): string {
  const own = domain ? DOMAIN_PACKS[domain].color : undefined;
  return own && !specs.some((line) => !line.archived && line.color === own) ? own : freeLineColor(specs);
}
