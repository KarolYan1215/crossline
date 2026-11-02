import {
  APPLICATION_SLOTS, autoSubmitProblems, buttonAmong, confirmationOf, findTarget, injectionSigns, isField, isSensitiveSlot, judgeAction, looksLikeSubmit, maskedValue, namePart,
  pageErrors, pageStop, pageText, parseAriaSnapshot, redactSensitive, sourceOf, splitName, valueMatches,
  type ApplicationSlot, type FormChecklistItem, type FormAction, type FormCheckAnswer, type FormCheckContext, type FormFillAnswer, type FormFillContext,
  type FormPageRecord, type FormStop, type JudgeContext, type PageSignals, type SnapshotNode, type StoredFormRun
} from "@crossline/core";

/**
 * The page engine (docs/opportunity-agent.md §10.2–§10.6): read the page's accessibility snapshot, have `crossline-form-filler` propose
 * actions, judge every one by the rules (packages/core/src/form-fill.ts), do the allowed ones, read each field back, and move on or
 * stop. It is written against `FormDriver` so the same loop runs on Playwright, on a test page, or later on a compute node's browser.
 *
 * What it never does: run a script in the page, open a page the run did not start on (the driver's network guard refuses it), press a
 * submit button the rules did not clear, or put a sensitive value anywhere but the field it belongs to.
 */

/** A target as the driver acts on it: the snapshot's ref first, role + name as the second way to find it (§10.6: 换定位重试). */
export type DriverTarget = { ref?: string | undefined; role: string; name: string };
export type FormDriver = {
  open: (url: string) => Promise<void>;
  url: () => string;
  /** Playwright's `ariaSnapshot({ mode: "ai" })` of the page. */
  snapshot: () => Promise<string>;
  signals: () => Promise<Omit<PageSignals, "url">>;
  /** Accessible names of the page's multi-line text boxes. */
  multiline: () => Promise<string[]>;
  /** A text box's value as the page holds it, when the snapshot does not show it. */
  inputValue: (target: DriverTarget, attempt: number) => Promise<string | undefined>;
  fill: (target: DriverTarget, value: string, attempt: number) => Promise<void>;
  select: (target: DriverTarget, option: string, attempt: number) => Promise<void>;
  check: (target: DriverTarget, on: boolean, attempt: number) => Promise<void>;
  upload: (target: DriverTarget, file: string, attempt: number) => Promise<void>;
  click: (target: DriverTarget) => Promise<void>;
  settle: () => Promise<void>;
  /** A screenshot for the person, with the fields holding sensitive values masked. */
  screenshot: (file: string, mask: DriverTarget[]) => Promise<void>;
  front: () => Promise<void>;
  closed: () => boolean;
  close: () => Promise<void>;
  /** The page's DOM as HTML (this computer's browser only), for the browser-use fallback's static copy. */
  html?: () => Promise<string>;
};
/**
 * A fallback engine (§10.7) only proposes field actions for the current page, from the same redacted snapshot the filler saw; the engine
 * judges each one by the same rules and does it itself. So a fallback never turns a page, never submits, and never holds a sensitive
 * value: a `next`/`submit` it proposes is dropped, and a value it names is a profile slot the engine fills in.
 */
export type FormFallback = {
  name: "stagehand" | "browser-use";
  propose: (input: { nodes: SnapshotNode[]; context: FormFillContext; url: string;
    /** The page's DOM with every sensitive value redacted (this computer's browser only), for browser-use's static copy. */
    html?: () => Promise<string>;
    /** Takes every sensitive value out of a text before it leaves the engine. */
    redact: (text: string) => string }) => Promise<FormAction[] | undefined>;
};

/** The profile's values as the engine reads them: sensitive ones from the secret store, in memory only for this run. */
export type ProfileValues = {
  present: ReadonlySet<ApplicationSlot>;
  get: (slot: ApplicationSlot) => Promise<string | undefined>;
  /** Every sensitive value held, for redaction; loaded once per run, never written anywhere. */
  sensitive: () => Promise<Array<{ slot: ApplicationSlot; value: string }>>;
  /** A local file for an upload slot (the résumé). */
  file: (slot: ApplicationSlot) => Promise<string | undefined>;
};

export type EngineDeps = {
  driver: FormDriver;
  propose: (context: FormFillContext) => Promise<FormFillAnswer | undefined>;
  check: (context: FormCheckContext) => Promise<FormCheckAnswer | undefined>;
  values: ProfileValues;
  save: (run: StoredFormRun, event?: { type: string; payload?: Record<string, unknown> }) => StoredFormRun;
  /** The person is wanted (a stop, or a form ready for their submission): the window comes to the front and a message goes out. */
  notify: (run: StoredFormRun) => void;
  /** A security check met: the site is held for every reader and filler until the person goes on (§10.5, `siteHold`). */
  holdSite?: (detail: string) => void;
  shotFile: (run: StoredFormRun, pageNo: number, label: string) => string;
  hash: (value: string) => string;
  fallbacks?: FormFallback[];
  /** Pages before the run gives up and hands over, as a guard against a loop. */
  maxSteps?: number;
};

const MAX_STEPS = 24;
const pageKey = (url: string, nodes: SnapshotNode[]) => `${url.replace(/[#?].*$/, "")}|${nodes.filter(isField).map((node) => `${node.role}:${node.name}`).join(",")}`;
/** A button that only opens an application form (applications always ask for fields, so opening one is never the submission). */
// i18n-ignore: patterns matched against what a site shows
const OPENER = /^(apply|apply now|apply for this (job|position|role)|start (your )?application|立即申请|申请职位|开始申请)$/i;

export async function fillForm(start: StoredFormRun, deps: EngineDeps, options: { resume: boolean }): Promise<StoredFormRun> {
  const { driver } = deps;
  const { stoppedFor: _stop, stopDetail: _detail, missingSlot: _slot, ...rest } = start;
  let run = deps.save({ ...rest, state: "filling", sessionLost: false, pageNo: Math.max(1, start.pageNo) },
    { type: options.resume ? "opportunity.form.continued" : "opportunity.form.started" });
  const sensitive = await deps.values.sensitive();
  // Page text the engine keeps or hands on (errors, injected lines) may quote what was typed: sensitive values are replaced first.
  const clean = (texts: string[]) => texts.map((text) => redactSensitive(text, sensitive));
  const sensitiveTargets: DriverTarget[] = [];
  const present = deps.values.present;
  const drafts = Object.fromEntries(Object.entries(run.drafts ?? {}).map(([id, draft]) => [id, draft.text]));
  const refusedHere: string[] = [];
  let retries = 0;

  const page = (): FormPageRecord => {
    const found = run.pages.find((item) => item.pageNo === run.pageNo);
    if (found) return found;
    const fresh: FormPageRecord = { pageNo: run.pageNo, url: driver.url(), engine: "own", actions: [], errors: [], injections: [] };
    run = { ...run, pages: [...run.pages, fresh] };
    return fresh;
  };
  const updatePage = (change: (record: FormPageRecord) => FormPageRecord) => {
    const current = page();
    run = { ...run, pages: run.pages.map((item) => item.pageNo === current.pageNo ? change(item) : item) };
  };
  const shoot = async (label: string) => {
    const file = deps.shotFile(run, run.pageNo, label);
    try { await driver.screenshot(file, sensitiveTargets); run = { ...run, screenshots: [...run.screenshots, file].slice(-60) }; updatePage((record) => ({ ...record, screenshot: file })); }
    catch { /* a screenshot that fails costs the picture, never the run */ }
  };
  const hold = async (stop: FormStop, detail: string, slot?: ApplicationSlot) => {
    await shoot("stop");
    if (stop === "captcha") deps.holdSite?.(detail);
    run = deps.save({ ...run, state: "waiting_person", stoppedFor: stop, stopDetail: detail.slice(0, 300), ...(slot ? { missingSlot: slot } : {}) },
      { type: "opportunity.form.stopped", payload: { stop, detail: detail.slice(0, 300), ...(slot ? { slot } : {}) } });
    try { await driver.front(); } catch { /* the window may already be gone */ }
    deps.notify(run);
    return run;
  };
  const read = async () => {
    const yaml = await driver.snapshot();
    return { yaml, nodes: parseAriaSnapshot(yaml) };
  };
  /** The page once it stops changing: a form may render after the page loads, or a dialog open a moment after a click (at most 4 s). */
  const steady = async () => {
    const bare = (yaml: string) => yaml.replace(/ \[ref=[^\]]*\]/g, "");
    let yaml = await driver.snapshot();
    for (let tries = 0; tries < 10; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const now = await driver.snapshot();
      if (bare(now) === bare(yaml)) { yaml = now; break; }
      yaml = now;
    }
    return { yaml, nodes: parseAriaSnapshot(yaml) };
  };
  const shown = async (target: DriverTarget, attempt: number): Promise<{ value?: string; checked?: boolean; selected?: string; node?: SnapshotNode }> => {
    const { nodes } = await read();
    const node = findTarget(nodes, target)[0];
    if (!node) return {};
    const value = node.value ?? (/^(textbox|searchbox|spinbutton|combobox)$/.test(node.role) ? await driver.inputValue({ ...target, ref: node.ref }, attempt) : undefined);
    return { node, ...(value !== undefined ? { value } : {}), ...(node.checked !== undefined ? { checked: node.checked } : {}), ...(node.selected ? { selected: node.selected } : {}) };
  };
  const slotValue = async (slot: ApplicationSlot, label: string) => {
    const value = await deps.values.get(slot);
    if (value === undefined) return undefined;
    const part = slot === "full_name" ? namePart(label) : undefined;
    return part ? splitName(value, part) : value;
  };

  /** Does one allowed field action and reads it back; a mismatch is retried once with the other way of finding the field. */
  const perform = async (action: FormAction, node: SnapshotNode): Promise<{ verified: boolean; slot?: ApplicationSlot }> => {
    const slot = action.value && "slot" in action.value ? action.value.slot : undefined;
    const target: DriverTarget = { ref: node.ref, role: node.role, name: node.name };
    if (action.op === "check") {
      if (node.checked) return { verified: true };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { await driver.check(attempt ? { role: node.role, name: node.name } : target, true, attempt); } catch { continue; }
        if ((await shown(target, attempt)).checked) return { verified: true };
      }
      return { verified: false };
    }
    if (action.op === "upload") {
      const file = await deps.values.file("resume");
      if (!file) return { verified: false };
      try { await driver.upload(target, file, 0); return { verified: true, slot: "resume" }; } catch { return { verified: false, slot: "resume" }; }
    }
    const value = slot ? await slotValue(slot, node.name) : action.value && "draft" in action.value ? drafts[action.value.draft] : action.value && "text" in action.value ? action.value.text : undefined;
    if (value === undefined) return { verified: false, ...(slot ? { slot } : {}) };
    if (slot && isSensitiveSlot(slot)) sensitiveTargets.push({ role: node.role, name: node.name });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const where = attempt ? { role: node.role, name: node.name } : target;
      try {
        if (action.op === "select") await driver.select(where, value, attempt);
        else await driver.fill(where, value, attempt);
      } catch { continue; }
      const now = await shown(target, attempt);
      const seen = action.op === "select" ? now.selected ?? now.value : now.value;
      const ok = slot && isSensitiveSlot(slot) ? seen !== undefined && (deps.hash(seen) === deps.hash(value) || valueMatches(value, seen, slot))
        : valueMatches(value, seen, slot);
      if (ok) return { verified: true, ...(slot ? { slot } : {}) };
    }
    return { verified: false, ...(slot ? { slot } : {}) };
  };

  const context = (nodes: SnapshotNode[], yaml: string, errors: string[]): FormFillContext => ({
    version: "crossline.form-fill.v1",
    intent: { title: run.opportunity.title, organizer: run.opportunity.organizer, kind: run.opportunity.kind, host: run.host },
    profile: (Object.keys(APPLICATION_SLOTS) as ApplicationSlot[]).map((slot) => ({ slot, present: present.has(slot), sensitive: isSensitiveSlot(slot) })),
    consents: run.opportunity.consents, drafts: Object.entries(run.drafts ?? {}).map(([id, draft]) => ({ id, title: `${id} (${draft.version})` })),
    pageNo: run.pageNo, snapshot: redactSensitive(yaml, sensitive).slice(0, 60_000),
    filledHere: page().actions.filter((item) => item.verdict === "allow").map((item) => `${item.op} ${item.target} ← ${item.source}`),
    errors, refused: refusedHere.slice(-12)
  });
  const judgeContext = async (nodes: SnapshotNode[]): Promise<JudgeContext> => {
    const slotValues = new Map<ApplicationSlot, string | undefined>();
    for (const slot of present) if (!isSensitiveSlot(slot)) slotValues.set(slot, await deps.values.get(slot));
    return { nodes, present, consents: run.opportunity.consents, drafts, multiline: new Set(await driver.multiline()), slotValue: (slot) => slotValues.get(slot) };
  };
  const record = (action: FormAction, verdict: ReturnType<typeof judgeAction>, verified?: boolean) => updatePage((item) => ({ ...item,
    actions: [...item.actions, { op: action.op, target: `${action.target.role} "${action.target.name.slice(0, 120)}"`, source: sourceOf(action.value),
      verdict: verdict.verdict, ...("reason" in verdict ? { reason: verdict.reason } : {}), ...(verified !== undefined ? { verified } : {}) }] }));

  for (let step = 0; step < (deps.maxSteps ?? MAX_STEPS); step += 1) {
    if (driver.closed()) return deps.save({ ...run, state: "waiting_person", stoppedFor: "engine_failed", stopDetail: "window closed", sessionLost: true }, { type: "opportunity.form.stopped", payload: { stop: "engine_failed" } }); // i18n-ignore: a code
    let { yaml, nodes } = await steady();
    const before = pageKey(driver.url(), nodes);
    const confirmed = confirmationOf(nodes);
    if (confirmed && run.state === "filling" && step > 0 && run.pages.some((item) => item.actions.some((action) => action.verdict === "submit"))) return submitted(confirmed, "system");
    const stop = pageStop(nodes, { ...(await driver.signals()), url: driver.url() });
    if (stop) return hold(stop.stop, stop.detail);
    const errorsBefore = clean(pageErrors(nodes));
    page();
    const injections = clean(injectionSigns(pageText(nodes)));
    if (injections.length) updatePage((item) => ({ ...item, injections: [...new Set([...item.injections, ...injections])].slice(0, 10) }));
    const answer = await deps.propose(context(nodes, yaml, errorsBefore));
    if (!answer) return hold("engine_failed", "form filler did not answer"); // i18n-ignore: a code
    // The model is trusted to stop, never to allow: a page it calls a login, a check or a payment is the person's.
    if (answer.pageKind === "login" || answer.pageKind === "captcha" || answer.pageKind === "payment") return hold(answer.pageKind, answer.note || answer.pageKind);
    if (answer.pageKind === "closed") return deps.save({ ...run, state: "stopped", stoppedFor: "not_allowed", stopDetail: answer.note.slice(0, 300) }, { type: "opportunity.form.stopped", payload: { stop: "closed" } });
    const actions = answer.actions.map((action) => ({ ...action, value: action.value ?? undefined })) as FormAction[];
    const move = actions.length && /^(next|submit)$/.test(actions[actions.length - 1]!.op) ? actions[actions.length - 1] : undefined;
    const fields = move ? actions.slice(0, -1) : actions;
    let done = 0;
    for (const action of fields) {
      ({ yaml, nodes } = await read());
      const already = findTarget(nodes, action.target)[0];
      if (action.op === "check" && already?.checked) continue;
      const verdict = judgeAction(action, await judgeContext(nodes));
      if (verdict.verdict === "stop") { record(action, verdict); return hold(verdict.stop, verdict.reason, verdict.slot); }
      if (verdict.verdict === "refuse" || verdict.verdict === "submit") {
        record(action, verdict.verdict === "submit" ? { verdict: "refuse", reason: "submit inside field actions" } : verdict); // i18n-ignore: a reason in the record
        refusedHere.push(`${action.op} ${action.target.name}: ${"reason" in verdict ? verdict.reason : "submit"}`);
        continue;
      }
      const outcome = await perform(action, verdict.node);
      record(action, verdict, outcome.verified);
      run = { ...run, filled: [...run.filled, { pageNo: run.pageNo, target: `${action.target.role} "${action.target.name.slice(0, 120)}"`, ...(outcome.slot ? { slot: outcome.slot } : {}), verified: outcome.verified }] };
      if (!outcome.verified) return hold("verify_failed", `${action.target.name}`);
      done += 1;
    }
    run = deps.save(run);
    if (!done && !move) {
      const filled = await tryFallbacks(nodes, yaml, errorsBefore);
      if (filled === "stop") return run;
      if (filled > 0) continue;
      if (retries++ < 1) continue;
      return hold("layout_changed", answer.note || "no mapping for this page"); // i18n-ignore: a code
    }
    if (!move) { if (retries++ < 2) continue; return hold("engine_failed", "no next or submit"); } // i18n-ignore: a code
    ({ yaml, nodes } = await read());
    let verdict = judgeAction(move, await judgeContext(nodes));
    if (verdict.verdict === "stop") { record(move, verdict); return hold(verdict.stop, verdict.reason, verdict.slot); }
    if (verdict.verdict === "refuse") {
      record(move, verdict); refusedHere.push(`${move.op} ${move.target.name}: ${verdict.reason}`);
      if (retries++ < 2) continue;
      return hold("not_allowed", verdict.reason);
    }
    // Opening an application's form is a step, not the submission (applications always ask for fields).
    if (verdict.verdict === "submit" && run.opportunity.kind === "application" && OPENER.test(verdict.node.name.trim()) && !nodes.some((node) => isField(node)))
      verdict = { verdict: "allow", node: verdict.node };
    const fieldsBefore = nodes.some(isField);
    if (verdict.verdict === "submit") {
      record(move, verdict);
      const gated = await gate(nodes, verdict.node);
      if (gated === "changed") { if (retries++ < 2) continue; return hold("layout_changed", "page changed before submit"); } // i18n-ignore: a code
      if (gated !== "clicked") return gated;
    } else {
      record(move, verdict);
      await shoot("page");
      try { await driver.click({ ref: verdict.node.ref, role: verdict.node.role, name: verdict.node.name }); } catch { return hold("verify_failed", `click ${verdict.node.name}`); }
    }
    await driver.settle();
    ({ yaml, nodes } = await steady());
    // What a click brings may come late (a dialog after an animation, a page after a slow request): wait for it before calling the page
    // unchanged, up to 6 s.
    for (const end = Date.now() + 6_000; Date.now() < end && pageKey(driver.url(), nodes) === before && !confirmationOf(nodes)
      && !clean(pageErrors(nodes)).some((error) => !errorsBefore.includes(error));) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      ({ yaml, nodes } = await steady());
    }
    const after = pageKey(driver.url(), nodes);
    const fresh = clean(pageErrors(nodes)).filter((error) => !errorsBefore.includes(error));
    const confirmedNow = confirmationOf(nodes);
    if (confirmedNow && verdict.verdict === "submit") return submitted(confirmedNow, "system");
    // A submit-like button on a page with no fields that brings up fields only opened the form (an event's 「Register」, a job's 「Apply」):
    // the run goes on to fill it, and that page's own button is the submission.
    if (verdict.verdict === "submit" && !fieldsBefore && nodes.some(isField) && !fresh.length) {
      updatePage((item) => ({ ...item, actions: item.actions.map((action, index) => index === item.actions.length - 1 && action.verdict === "submit"
        ? { ...action, verdict: "allow" as const, reason: "opened the form" } : action) })); // i18n-ignore: a reason in the record
      const { submittedBy: _by, ...open } = run;
      run = deps.save(open, { type: "opportunity.form.opened", payload: { button: verdict.node.name.slice(0, 80) } });
    }
    if (fresh.length || after === before) {
      updatePage((item) => ({ ...item, errors: [...new Set([...item.errors, ...fresh])].slice(0, 12) }));
      if (retries++ < 1) { refusedHere.push(...fresh.map((error) => `page error: ${error}`)); continue; } // i18n-ignore: model-facing
      return hold("verify_failed", fresh[0] ?? "page did not change"); // i18n-ignore: a code
    }
    retries = 0;
    refusedHere.length = 0;
    run = deps.save({ ...run, pageNo: run.pageNo + 1 }, { type: "opportunity.form.page", payload: { pageNo: run.pageNo + 1 } });
  }
  return hold("engine_failed", "too many pages"); // i18n-ignore: a code

  async function tryFallbacks(nodes: SnapshotNode[], yaml: string, errors: string[]): Promise<number | "stop"> {
    for (const fallback of deps.fallbacks ?? []) {
      // Once per page each: a fallback run is slow (browser-use takes a minute), and a second run on the same page proposes the same fields.
      if (run.engines.some((item) => item.pageNo === run.pageNo && item.engine === fallback.name)) continue;
      const redact = (text: string) => redactSensitive(text, sensitive);
      const html = driver.html;
      const proposed = await fallback.propose({ nodes, context: context(nodes, yaml, errors), url: driver.url(), redact,
        ...(html ? { html: async () => redact(await html()) } : {}) }).catch(() => undefined) ?? [];
      run = { ...run, engines: [...run.engines, { pageNo: run.pageNo, engine: fallback.name }] };
      updatePage((item) => ({ ...item, engine: fallback.name }));
      let done = 0;
      const refused: string[] = [];
      for (const action of proposed.slice(0, 30)) {
        if (action.op === "next" || action.op === "submit") { refused.push(`${action.op} ${action.target.name}`); continue; }
        const fresh = parseAriaSnapshot(await driver.snapshot());
        const verdict = judgeAction(action, await judgeContext(fresh));
        if (verdict.verdict !== "allow") { record(action, verdict.verdict === "submit" ? { verdict: "refuse", reason: "submit from a fallback" } : verdict); refused.push(`${action.op} ${action.target.name}`); continue; } // i18n-ignore: a reason in the record
        const outcome = await perform(action, verdict.node);
        record(action, verdict, outcome.verified);
        run = { ...run, filled: [...run.filled, { pageNo: run.pageNo, target: `${action.target.role} "${action.target.name.slice(0, 120)}"`, ...(outcome.slot ? { slot: outcome.slot } : {}), verified: outcome.verified }] };
        if (outcome.verified) done += 1;
      }
      run = deps.save(run, { type: "opportunity.form.fallback", payload: { engine: fallback.name, done, refused: refused.length } });
      if (done) return done;
    }
    return 0;
  }

  async function gate(nodes: SnapshotNode[], submit: SnapshotNode): Promise<StoredFormRun | "clicked" | "changed"> {
    const checklist = await checklistOf();
    const answer = await deps.check({ version: "crossline.form-check.v1", intent: { title: run.opportunity.title, organizer: run.opportunity.organizer,
      kind: run.opportunity.kind, consents: run.opportunity.consents }, items: checklist });
    run = { ...run, checklist, check: answer ? { ...answer, by: "model" } : { ok: false, problems: [{ field: "", problem: "check did not run" }], by: "rules" } }; // i18n-ignore: a reason in the record
    // The check takes seconds, and a page may open a dialog meanwhile (Luma's sign-up form): what is clicked must be what was checked.
    const now = parseAriaSnapshot(await driver.snapshot());
    const named = findTarget(now, submit);
    const still = (submit.ref ? named.find((node) => node.ref === submit.ref) : undefined) ?? (named.length ? buttonAmong(now, named) : undefined);
    if (pageKey(driver.url(), now) !== pageKey(driver.url(), nodes) || !still) return "changed";
    submit = still;
    // A snapshot may not show what a text box holds (Luma's do not): ask the page, and count one it cannot read as empty.
    nodes = await Promise.all(now.map(async (node) => /^(textbox|searchbox|spinbutton)$/.test(node.role) && !node.value?.trim()
      ? { ...node, value: await driver.inputValue({ role: node.role, name: node.name, ...(node.ref ? { ref: node.ref } : {}) }, 0) ?? "" } : node));
    const required = (await driver.signals()).required ?? [];
    const problems = autoSubmitProblems(run, { nodes, submit, required });
    await shoot("before-submit");
    if (problems.length) {
      run = deps.save({ ...run, state: "ready_to_submit", heldBecause: problems }, { type: "opportunity.form.ready_to_submit", payload: { heldBecause: problems } });
      try { await driver.front(); } catch { /* gone */ }
      deps.notify(run);
      return run;
    }
    try { await driver.click({ ref: submit.ref, role: submit.role, name: submit.name }); } catch { return hold("verify_failed", `click ${submit.name}`); }
    run = deps.save({ ...run, submittedBy: "system" }, { type: "opportunity.form.submit_clicked", payload: { button: submit.name.slice(0, 80) } });
    return "clicked";
  }

  async function checklistOf(): Promise<FormChecklistItem[]> {
    const items: FormChecklistItem[] = [];
    for (const record of run.pages) for (const action of record.actions) {
      if (action.verdict !== "allow" || action.op === "next" || action.op === "submit") continue;
      const field = action.target;
      if (action.op === "check") { items.push({ pageNo: record.pageNo, field, source: "check", shown: "✓" }); continue; }
      if (action.source.startsWith("profile:")) {
        const slot = action.source.slice(8) as ApplicationSlot;
        const label = field.replace(/^\w+ "|"$/g, "");
        const value = isSensitiveSlot(slot) ? "" : await slotValue(slot, label) ?? "";
        items.push({ pageNo: record.pageNo, field, source: action.op === "select" ? "select" : "profile", slot, shown: maskedValue(slot, value) });
      } else if (action.source.startsWith("draft:")) items.push({ pageNo: record.pageNo, field, source: "draft", shown: (drafts[action.source.slice(6)] ?? "").slice(0, 120) });
      else items.push({ pageNo: record.pageNo, field, source: action.op === "select" ? "select" : "text", shown: action.source.replace(/^text:/, "") });
    }
    return items;
  }

  async function submitted(confirmation: NonNullable<ReturnType<typeof confirmationOf>>, by: "system" | "person"): Promise<StoredFormRun> {
    await shoot("confirmation");
    run = deps.save({ ...run, state: "submitted", submittedBy: run.submittedBy ?? by, confirmation: { quote: confirmation.quote.slice(0, 300), kind: confirmation.kind, at: new Date().toISOString() } },
      { type: "opportunity.form.submitted", payload: { by: run.submittedBy ?? by, quote: confirmation.quote.slice(0, 300), kind: confirmation.kind } });
    deps.notify(run);
    return run;
  }
}

/** While a run waits for the person to submit it in the window: their submission is seen by the confirmation page appearing. */
export async function watchForPersonSubmit(run: StoredFormRun, driver: FormDriver): Promise<ReturnType<typeof confirmationOf> | "closed" | undefined> {
  if (driver.closed()) return "closed";
  try {
    const nodes = parseAriaSnapshot(await driver.snapshot());
    const confirmation = confirmationOf(nodes);
    if (confirmation && (run.state === "ready_to_submit" || run.state === "waiting_person")) return confirmation;
    return undefined;
  } catch { return driver.closed() ? "closed" : undefined; }
}

/** Whether a page's submit-looking button is there at all (the person's own submission is watched only on such pages). */
export const hasSubmit = (nodes: SnapshotNode[]) => nodes.some((node) => node.role === "button" && looksLikeSubmit(node.name));
