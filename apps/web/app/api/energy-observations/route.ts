import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getStore, WORKSPACE_ID } from "../../../lib/crossline";

const numericAggregateKeys = new Set(["responseSeconds"]);

export async function POST(request: Request) {
  const body = await request.json() as Record<string, unknown>;
  const allowedTopLevel = new Set(["source", "level", "confidence", "aggregate"]);
  if (Object.keys(body).some((key) => !allowedTopLevel.has(key))) {
    return NextResponse.json({ ok: false, code: "RAW_MEDIA_OR_UNKNOWN_FIELD_FORBIDDEN" }, { status: 400 });
  }
  const source = body.source;
  const level = body.level;
  const confidence = body.confidence;
  const rawAggregate = body.aggregate;
  if (source === "camera_proxy") {
    return NextResponse.json({ ok: false, code: "CAMERA_ENERGY_PATH_REMOVED" }, { status: 400 });
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

  const observedAt = new Date();
  const id = randomUUID();
  const store = getStore();
  store.saveEnergyObservation({
    id, ownerId: "local-owner", workspaceId: WORKSPACE_ID,
    source, level: level as "low" | "medium" | "high",
    confidence: confidence as "low" | "medium" | "high",
    aggregate: Object.fromEntries(aggregateEntries) as Record<string, number>,
    observedAt: observedAt.toISOString()
  });
  store.appendEvent({
    ownerId: "local-owner", workspaceId: WORKSPACE_ID,
    idempotencyKey: `energy-observed:${id}`, type: "energy.observed", entityId: id,
    payload: { source, level, confidence }
  });
  return NextResponse.json({ ok: true, id });
}
