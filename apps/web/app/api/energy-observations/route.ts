import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getStore } from "../../../lib/crossline";
import { resolveAccessContext } from "../../../lib/access-guard";
import { predictEnergyTransition, readTransitionOutcomes, type EnergyLevel } from "../../../lib/energy-learning";
import { isCrossSiteWrite } from "../../../lib/same-origin";
import { CAMERA_AGGREGATE_RANGES, CAMERA_ENERGY_CONSENT } from "@crossline/core";

const numericAggregateKeys = new Set(["responseSeconds"]);

export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return NextResponse.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const { ctx } = access;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const allowedTopLevel = new Set(["source", "level", "confidence", "aggregate",
    "context", "workOrderId", "actualLoad"]);
  if (Object.keys(body).some((key) => !allowedTopLevel.has(key))) {
    return NextResponse.json({ ok: false, code: "RAW_MEDIA_OR_UNKNOWN_FIELD_FORBIDDEN" }, { status: 400 });
  }
  const source = body.source;
  const level = body.level;
  const confidence = body.confidence;
  const rawAggregate = body.aggregate;
  const context = body.context ?? "general";
  const workOrderId = body.workOrderId;
  const actualLoad = body.actualLoad;
  if (source === "camera_proxy") {
    return NextResponse.json({ ok: false, code: "CAMERA_ENERGY_PATH_REMOVED" }, { status: 400 });
  }
  // The camera's window aggregate (docs/energy-and-ecosystem.md §8): only with its own consent, only the five numbers, each in range;
  // never a frame or anything else. It carries no level — it is a covariate the energy model must earn the use of.
  if (source === "camera_aggregate") {
    if (getStore().getSetting(ctx.workspaceId, CAMERA_ENERGY_CONSENT) !== "granted")
      return NextResponse.json({ ok: false, code: "CAMERA_NOT_ENABLED" }, { status: 403 });
    const aggregate = rawAggregate as Record<string, unknown> | undefined;
    const keys = Object.keys(CAMERA_AGGREGATE_RANGES) as Array<keyof typeof CAMERA_AGGREGATE_RANGES>;
    if (!aggregate || typeof aggregate !== "object" || Array.isArray(aggregate) || Object.keys(aggregate).some((key) => !(key in CAMERA_AGGREGATE_RANGES))
      || keys.some((key) => { const value = aggregate[key]; const [low, high] = CAMERA_AGGREGATE_RANGES[key];
        return typeof value !== "number" || !Number.isFinite(value) || value < low || value > high; })
      || context !== "general" || workOrderId !== undefined || actualLoad !== undefined)
      return NextResponse.json({ ok: false, code: "AGGREGATE_FEATURES_ONLY" }, { status: 400 });
    const id = randomUUID();
    getStore().saveEnergyObservation({ id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId, source: "camera_aggregate", level: "uncalibrated",
      confidence: "low", aggregate: Object.fromEntries(keys.map((key) => [key, aggregate[key] as number])), observedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, id });
  }
  if (source !== "self_report" ||
      !["low", "medium", "high"].includes(String(level)) ||
      !["low", "medium", "high"].includes(String(confidence)) ||
      !rawAggregate || typeof rawAggregate !== "object" || Array.isArray(rawAggregate)) {
    return NextResponse.json({ ok: false, code: "INVALID_ENERGY_OBSERVATION" }, { status: 400 });
  }
  const aggregateEntries = Object.entries(rawAggregate as Record<string, unknown>);
  if (aggregateEntries.some(([key, value]) => !numericAggregateKeys.has(key) || typeof value !== "number" || !Number.isFinite(value))) {
    return NextResponse.json({ ok: false, code: "AGGREGATE_FEATURES_ONLY" }, { status: 400 });
  }
  if (!["general", "before_task", "after_task", "after_rest", "correction"].includes(String(context)) ||
    (context === "before_task" || context === "after_task") !== (typeof workOrderId === "string") ||
    (actualLoad !== undefined && (context !== "after_task" || !["low", "medium", "high"].includes(String(actualLoad))))) {
    return NextResponse.json({ ok: false, code: "ENERGY_CONTEXT_INVALID" }, { status: 400 });
  }

  const observedAt = new Date();
  const id = randomUUID();
  const store = getStore();
  const order = workOrderId ? store.listWorkOrders(ctx.workspaceId).find((item) => item.id === workOrderId) : undefined;
  if (workOrderId && !order)
    return NextResponse.json({ ok: false, code: "WORK_ORDER_NOT_FOUND" }, { status: 404 });
  const execution = context === "after_task" ? store.listExecutions(ctx.workspaceId)
    .filter((run) => run.workOrderId === workOrderId).at(-1) : undefined;
  const executionFacts = execution?.endedAt && execution.durationObserved
    ? { durationMinutes: Math.max(0, Math.round((Date.parse(execution.endedAt) -
      Date.parse(execution.startedAt)) / 60_000) - execution.pauseMinutes),
      interruptionCount: execution.interruptions.length } : {};
  store.saveEnergyObservation({
    id, ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    source, level: level as "low" | "medium" | "high",
    confidence: confidence as "low" | "medium" | "high",
    aggregate: { ...Object.fromEntries(aggregateEntries) as Record<string, number>, ...executionFacts },
    observedAt: observedAt.toISOString()
  });
  store.appendEvent({
    ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `energy-observed:${id}`, type: "energy.observed", entityId: id,
    payload: { source, level, confidence, context,
      ...(workOrderId ? { workOrderId } : {}), ...(actualLoad ? { actualLoad } : {}),
      ...executionFacts }
  });
  if (context === "before_task" && order) {
    const taskEnergy = ((order.payload as { humanCore?: Array<{ energy?: string }> }).humanCore ?? [])[0]?.energy;
    if (taskEnergy === "low" || taskEnergy === "medium" || taskEnergy === "high") {
      const outcomes = readTransitionOutcomes(store.listEvents(ctx.workspaceId, { type: "energy.transition_outcome" }));
      const prediction = predictEnergyTransition(level as EnergyLevel, taskEnergy, outcomes);
      store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
        idempotencyKey: `energy-predicted:${id}`, type: "energy.transition_predicted", entityId: order.id,
        payload: { observationId: id, before: level, taskEnergy, ...prediction } });
    }
  }
  if (context === "after_task" && order) {
    const events = store.listEvents(ctx.workspaceId, { type: ["energy.transition_predicted",
      "energy.transition_outcome"], entityId: order.id });
    const used = new Set(events.filter((event) => event.type === "energy.transition_outcome")
      .map((event) => (event.payload as { observationId?: string }).observationId));
    const prediction = [...events].reverse().find((event) => event.type === "energy.transition_predicted" &&
      !used.has((event.payload as { observationId?: string }).observationId));
    if (prediction) store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      idempotencyKey: `energy-outcome:${id}`, type: "energy.transition_outcome", entityId: order.id,
      payload: { ...(prediction.payload as Record<string, unknown>), actual: level,
        recordedAt: observedAt } });
  }
  return NextResponse.json({ ok: true, id });
}
