import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const TEST_CTX = { principalId: "test-owner", workspaceId: "test-workspace", role: "owner" as const,
  identity: { provider: "credential" as const, issuer: "test", subject: "test-owner" },
  authMethod: "session" as const, requestId: "test-request" };
vi.mock("../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

const saved: Array<Record<string, unknown>> = [];
const events: Array<Record<string, unknown>> = [];

vi.mock("../../../lib/crossline", () => ({
  getStore: () => ({
    saveEnergyObservation: (observation: Record<string, unknown>) => { saved.push(observation); },
    appendEvent: (event: Record<string, unknown>) => { events.push(event); },
    listEvents: (_workspaceId: string, options: { type?: string | string[]; entityId?: string }) =>
      events.filter((event) => (!options.type || (Array.isArray(options.type)
        ? options.type.includes(String(event.type)) : options.type === event.type)) &&
        (!options.entityId || options.entityId === event.entityId)),
    listWorkOrders: () => [{ id: "work-1", payload: { humanCore: [{ energy: "high" }] } }],
    listExecutions: () => [{ workOrderId: "work-1", startedAt: "2026-09-18T10:00:00.000Z",
      endedAt: "2026-09-18T11:10:00.000Z", pauseMinutes: 10,
      durationObserved: true, interruptions: [{ reason: "call" }] }]
  })
}));

const post = async (body: unknown) => {
  const { POST } = await import("./route");
  return POST(new Request("http://127.0.0.1/api/energy-observations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
};

describe("energy observation route", () => {
  test("rejects the removed camera proxy source", async () => {
    const response = await post({ source: "camera_proxy", level: "unclassified", confidence: "low", aggregate: {} });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CAMERA_ENERGY_PATH_REMOVED" });
  });

  test("still rejects raw media or unknown top-level fields", async () => {
    const response = await post({ source: "self_report", level: "medium", confidence: "high", aggregate: {}, frame: "data:image/jpeg;base64,forbidden" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "RAW_MEDIA_OR_UNKNOWN_FIELD_FORBIDDEN" });
  });

  test("rejects camera-only aggregate keys", async () => {
    for (const key of ["meanBlinkProxy", "sampleCount", "faceDetectedSamples", "durationMs"]) {
      const response = await post({ source: "self_report", level: "medium", confidence: "high", aggregate: { [key]: 1 } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "AGGREGATE_FEATURES_ONLY" });
    }
  });

  test("stores a self report without any expiry branch", async () => {
    saved.length = 0;
    const response = await post({ source: "self_report", level: "high", confidence: "high", aggregate: { responseSeconds: 5 } });
    expect(response.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source: "self_report", level: "high" });
    expect(saved[0]).not.toHaveProperty("expiresAt");
  });

  test("records before, after and rest context with observed duration and optional actual load", async () => {
    saved.length = 0; events.length = 0;
    expect((await post({ source: "self_report", level: "low", confidence: "high",
      aggregate: {}, context: "before_task", workOrderId: "work-1" })).status).toBe(200);
    expect((await post({ source: "self_report", level: "medium", confidence: "high",
      aggregate: {}, context: "after_task", workOrderId: "work-1", actualLoad: "high" })).status).toBe(200);
    expect((await post({ source: "self_report", level: "high", confidence: "high",
      aggregate: {}, context: "after_rest" })).status).toBe(200);
    expect(saved[1]?.aggregate).toMatchObject({ durationMinutes: 60, interruptionCount: 1 });
    expect(events.find((event) => event.type === "energy.observed" &&
      (event.payload as { context?: string }).context === "after_task")?.payload)
      .toMatchObject({ context: "after_task", workOrderId: "work-1",
      actualLoad: "high" });
    expect(events.find((event) => event.type === "energy.transition_outcome")?.payload)
      .toMatchObject({ before: "low", taskEnergy: "high", actual: "medium" });
    expect(events.find((event) => event.type === "energy.observed" &&
      (event.payload as { context?: string }).context === "after_rest")?.payload)
      .toMatchObject({ context: "after_rest" });
  });
});
