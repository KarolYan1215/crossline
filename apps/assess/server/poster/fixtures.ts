import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { pairRelation, publicType } from "../../lib/public-type";
import type { PairCardInput, PosterInput } from "./index";

/**
 * Test support: two contrasting results (a planning specialist with one two-way letter, an adapting generalist), their pair, and a
 * stand-in figure drawn here so the tests need neither a template nor an image model.
 */

export const PLANNER = { scope: 18, basis: 22, output: 41, rhythm: 12 } as const; // SEMP, output ambiguous
export const ROAMER = { scope: 91, basis: 84, output: 72, rhythm: 88 } as const; // GIRA

/** A plain cartoon bust on a transparent square, written to `dir`. */
export function writeFigure(dir: string, name: string, shirt: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <path d="M96 512C96 400 168 344 256 344S416 400 416 512Z" fill="${shirt}"/>
    <rect x="228" y="290" width="56" height="70" rx="20" fill="#E8B996"/>
    <circle cx="256" cy="216" r="104" fill="#F2C9A5"/>
    <path d="M152 210C150 130 200 96 258 96S362 132 360 206C330 170 300 158 256 160S180 176 152 210Z" fill="#2B2420"/>
    <circle cx="218" cy="226" r="9" fill="#2B2420"/><circle cx="294" cy="226" r="9" fill="#2B2420"/>
    <path d="M226 270Q256 292 286 270" fill="none" stroke="#2B2420" stroke-width="6" stroke-linecap="round"/>
  </svg>`;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  writeFileSync(file, new Resvg(svg).render().asPng());
  return file;
}

const INVITE = "https://assess.example.com/t/9f2c4a1d0b7e4e1f8a3c5d6e7f809a1b";

export function samplePoster(dir: string, scores: Record<"scope" | "basis" | "output" | "rhythm", number>, nickname: string, shirt: string): PosterInput {
  const type = publicType(scores);
  return { type, nickname, avatarPath: writeFigure(dir, type.code, shirt), inviteUrl: INVITE };
}

export function samplePair(dir: string): PairCardInput {
  const a = samplePoster(dir, PLANNER, "小林", "#085E3A");
  const b = samplePoster(dir, ROAMER, "阿乔🙂", "#8C3709");
  return { a: { type: a.type, nickname: a.nickname, avatarPath: a.avatarPath }, b: { type: b.type, nickname: b.nickname, avatarPath: b.avatarPath },
    ...pairRelation(a.type.code, b.type.code), inviteUrl: INVITE };
}
