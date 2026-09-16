import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const saved: Array<Record<string, unknown>> = [];

vi.mock("../../../lib/crossline", () => ({
  WORKSPACE_ID: "test-workspace",
  getStore: () => ({
    saveEnergyObservation: (observation: Record<string, unknown>) => { saved.push(observation); },
    appendEvent: () => undefined
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
});
