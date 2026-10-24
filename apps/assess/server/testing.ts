import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QUIZ_ITEMS, type TypeAxisId } from "@crossline/core/assess";
import type { Appearance, SubmitRequest } from "../lib/contract";
import { closeDb } from "./db";

/** Test helpers: a throwaway data directory per test, and submissions that land on a chosen pole per axis. Never imported by the app. */

export function useTempDataDir(): { dir: () => string; cleanup: () => void } {
  let dir = "";
  return {
    dir: () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "assess-test-"));
      process.env.ASSESS_DATA_DIR = dir;
      return dir;
    },
    cleanup: () => {
      closeDb();
      delete process.env.ASSESS_DATA_DIR;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Answers that put each axis fully on its right pole when `right[axis]`, else its left. */
export function answersFor(right: Partial<Record<TypeAxisId, boolean>> = {}): Record<string, number> {
  return Object.fromEntries(QUIZ_ITEMS.map((item) => {
    const towardsRight = right[item.axis] ?? false;
    return [item.id, towardsRight === item.aRight ? 1 : 5];
  }));
}

export const appearance: Appearance = { presentation: "neutral", hair: "short", glasses: true, skin: "medium", style: "casual", note: "" };

export function submission(overrides: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    answers: answersFor({ lines: true, purpose: false, collab: false, build: true }), appearance, email: "Alice@Example.com", sendEmail: true,
    nickname: "小艾", startedAt: Date.now() - 5 * 60_000, website: "", ...overrides
  };
}

export const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://assess.test/api/results", {
  method: "POST", headers: { "content-type": "application/json", host: "assess.test", "x-forwarded-for": "203.0.113.7", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

export const get = (url: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`http://assess.test${url}`, { method, headers: { host: "assess.test", "x-forwarded-for": "203.0.113.7", ...headers } });

export const params = (token: string) => ({ params: Promise.resolve({ token }) });
