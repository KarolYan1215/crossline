import { describe, expect, test } from "vitest";
import { MAIL_PRESETS } from "@crossline/connectors";
import { healthRecordsFromPhone, SUBSCRIPTION_GUIDES } from "@crossline/core";
import {
  CALENDAR_APPS_GUIDE, CALENDAR_WRITER_GUIDE, captureShortcutGuide, LOCAL_RECORDING_GUIDE, MAIL_GUIDE, mailGuideId, modelProviderGuide, phoneHealthGuide,
  phonePushGuide, recordingUploadGuide, recordsGuide, SKILL_LINK_GUIDE, SOURCE_FOLDER_GUIDE, subscriptionGuide, type SetupGuideSpec
} from "./setup-guides";

const hosted = { base: "https://app.crossline.lol", privateNetwork: false };
const local = { base: "https://box.tailnet.ts.net", privateNetwork: true };
const ALL: SetupGuideSpec[] = [MAIL_GUIDE, phoneHealthGuide(hosted), phoneHealthGuide(local), captureShortcutGuide(hosted), recordsGuide(hosted),
  recordingUploadGuide("https://app.crossline.lol/api/recordings/upload?name="), LOCAL_RECORDING_GUIDE, phonePushGuide(true), phonePushGuide(false),
  CALENDAR_WRITER_GUIDE, CALENDAR_APPS_GUIDE, SOURCE_FOLDER_GUIDE, modelProviderGuide(true), modelProviderGuide(false), SKILL_LINK_GUIDE,
  subscriptionGuide(SUBSCRIPTION_GUIDES)];
const textOf = (guide: SetupGuideSpec) => [guide.title, guide.intro ?? "", ...guide.providers.flatMap((provider) => [provider.label, ...provider.steps,
  ...(provider.facts ?? []).flatMap((fact) => [fact.label, fact.value]), provider.note ?? ""]),
  ...(guide.problems ?? []).flatMap((problem) => [problem.symptom, problem.fix])].join("\n");

describe("setup guides", () => {
  test("every guide has steps for every provider, unique tabs, official pages over https, and no second person (docs/copy-style.md)", () => {
    for (const guide of ALL) {
      expect(guide.providers.length, guide.title).toBeGreaterThan(0);
      expect(new Set(guide.providers.map((provider) => provider.id)).size, guide.title).toBe(guide.providers.length);
      for (const provider of guide.providers) {
        expect(provider.steps.length, `${guide.title} · ${provider.label}`).toBeGreaterThan(0);
        for (const link of provider.links ?? []) expect(link.url, link.label).toMatch(/^https:\/\/[^\s<>]+$/);
      }
      // A provider's own menu names are quoted as they appear (Google's 「我的日历的设置」); everything else is third person.
      expect(textOf(guide).replace(/「[^」]*」/g, ""), guide.title).not.toMatch(/[你我]/);
    }
  });

  test("every mailbox the connector knows has its provider's tab, and that tab names the server the connector uses", () => {
    for (const [domain, preset] of Object.entries(MAIL_PRESETS)) {
      const id = mailGuideId(`someone@${domain}`);
      const provider = MAIL_GUIDE.providers.find((item) => item.id === id);
      expect(provider, domain).toBeDefined();
      expect(provider!.facts?.map((fact) => fact.value).join(" "), domain).toContain(preset.host);
    }
  });

  test("Microsoft addresses land on the tab that says they are not supported; a company domain on the corporate tab; half an address on none", () => {
    for (const address of ["a@outlook.com", "a@hotmail.com", "a@live.com", "a@contoso.office365.com"]) expect(mailGuideId(address)).toBe("outlook");
    expect(MAIL_GUIDE.providers.find((item) => item.id === "outlook")?.unsupported).toBe(true);
    expect(mailGuideId("someone@wisc.edu")).toBe("other");
    expect(mailGuideId("someone@")).toBeUndefined();
    expect(mailGuideId("someone@gmail")).toBeUndefined();
    expect(mailGuideId(" Someone@QQ.com ")).toBe("qq");
  });

  test("the phone health guide names the fields /api/health/sleep reads, at the address the phone posts to", () => {
    const guide = phoneHealthGuide(hosted);
    const fields = guide.providers.find((item) => item.id === "iphone")!.facts!.map((fact) => fact.label).join(" ");
    for (const field of ["events", "sleep", "day", "restingHr", "hrvMs", "steps", "daylightMin", "wristTempDeltaC", "weightKg", "kcal", "workouts"]) expect(fields).toContain(field);
    expect(textOf(guide)).toContain("https://app.crossline.lol/api/health/sleep");
    expect(guide.providers.find((item) => item.id === "android")!.facts!.some((fact) => fact.label === "source" && fact.value === "android-health")).toBe(true);
    // The private-network reminder only where the phone has to reach this computer.
    expect(textOf(guide)).not.toContain("Tailscale");
    expect(textOf(phoneHealthGuide(local))).toContain("Tailscale");
  });

  test("the health-line fields the guide documents are the ones the records reader takes", () => {
    const records = healthRecordsFromPhone({ day: "2026-10-20", weightKg: 70.4, kcal: 2100,
      workouts: [{ id: "w1", start: "2026-10-20T07:00:00Z", minutes: 30, type: "跑步" }] }, "2026-10-20");
    expect(records.map((item) => item.record.kind).sort()).toEqual(["meal", "weight", "workout"]);
  });

  test("Ollama is offered only where Crossline runs on the person's own computer", () => {
    expect(modelProviderGuide(true).providers.find((item) => item.id === "ollama")?.unsupported).toBeUndefined();
    expect(modelProviderGuide(false).providers.find((item) => item.id === "ollama")?.unsupported).toBe(true);
  });
});
