"use client";

import { useState } from "react";
import { ONBOARDING_TONE_LABEL, ONBOARDING_TONES, type OnboardingTone } from "@crossline/core";
import { MATERIALS_FIRST_REPLY, NO_MATERIALS_REPLY } from "./onboarding-types";

/**
 * The interview's first message (docs/onboarding-v3.md, decided 2026-10-14): the premise in plain words, how it runs and what it gives,
 * then one card of fact questions answered together — how to be spoken to, the lines, the one that cannot move, and the ones with a fixed
 * schedule. It replaces the old line-setup screen and the six-level lecture; the structure is shown at the end, drawn from what was said.
 * Its answers are written in code (tone, lines) and sent as the first reply, so the interview quotes them like anything else said.
 */
const COMMON_LINES = ["研究者", "学生", "工程师", "创业者", "创作者", "投资者", "设计师", "教师", "职员", "自由职业者"];
const ALL_EQUAL = "几条并重";
const NO_FIXED = "都没有";

export type OpeningAnswer = { tone: OnboardingTone; lines: string[]; base: string; fixed: string[] };

/** The first reply as the person "says" it, in the screen's own words, so every answer is a verbatim span to quote. */
export function openingReply(answer: OpeningAnswer, withMaterials: boolean): string {
  return [`【语气】${ONBOARDING_TONE_LABEL[answer.tone].label}`, `【我的主线】${answer.lines.join("、")}`,
    `【未来 12–24 个月的底座】${answer.base || ALL_EQUAL}`, `【有固定日程的主线】${answer.fixed.length ? answer.fixed.join("、") : NO_FIXED}`,
    withMaterials ? MATERIALS_FIRST_REPLY : NO_MATERIALS_REPLY].join("\n");
}

export function OpeningCard({ linesKnown, knownLines, initialTone, busy, hasMaterials, needsConnection = false, onStart }: {
  /** The lines are already set (an account from before this card): only the tone is asked. */
  linesKnown: boolean; knownLines: string[]; initialTone: OnboardingTone; busy: boolean; hasMaterials: boolean;
  /** No model connection yet: the card can be filled in, but the first round cannot run until the step above it is done. */
  needsConnection?: boolean;
  onStart: (answer: OpeningAnswer) => void;
}) {
  const [tone, setTone] = useState<OnboardingTone>(initialTone);
  const [lines, setLines] = useState<string[]>(linesKnown ? knownLines : []);
  const [custom, setCustom] = useState("");
  const [base, setBase] = useState("");
  const [fixed, setFixed] = useState<string[]>([]);
  const toggle = (label: string) => setLines((list) => list.includes(label) ? list.filter((item) => item !== label) : list.length >= 5 ? list : [...list, label]);
  const addCustom = () => {
    const label = custom.trim().slice(0, 20);
    if (label && !lines.includes(label) && lines.length < 5) setLines((list) => [...list, label]);
    setCustom("");
  };
  const chosenBase = lines.includes(base) ? base : "";
  const chosenFixed = fixed.filter((label) => lines.includes(label));
  const offered = [...COMMON_LINES, ...lines.filter((label) => !COMMON_LINES.includes(label))];

  return <section className="ob-opening ob-voice" aria-label="开始访谈">
    <div className="ob-opening-intro">
      <p>人生更像一件可以反复修改、低成本试错的作品，而不是一道有标准答案的题。所有设计都从一件事开始：先看清你现在真实站在哪里，不回避。</p>
      <ol className="ob-opening-plan">
        <li><b>认识你</b><span>几条主线和手上的材料，事实题一次答一组</span></li>
        <li><b>聊深一点</b><span>现状、你为什么工作、什么让你投入；一次一个问题</span></li>
        <li><b>补齐细节</b><span>每个项目的截止日和要交付的东西</span></li>
      </ol>
      <p className="ob-opening-time">大约 30 分钟后拿到一份全面的 AI 时代超级个体跨人生主线报告和跨主线排程计划。左侧可以先放入简历、课表、课程大纲，访谈会先读材料，只问材料里没有的。</p>
    </div>

    <fieldset className="ob-question">
      <legend>你希望我怎么跟你说话？</legend>
      <div className="ob-chips" role="radiogroup">
        {ONBOARDING_TONES.map((id) => <button key={id} type="button" role="radio" aria-checked={tone === id} data-picked={tone === id}
          onClick={() => setTone(id)}>{ONBOARDING_TONE_LABEL[id].label}<small>{ONBOARDING_TONE_LABEL[id].detail}</small></button>)}
      </div>
    </fieldset>

    {!linesKnown && <>
      <fieldset className="ob-question">
        <legend>你正在投入的身份有哪些？<small>写成身份名词，2–5 个</small></legend>
        <div className="ob-chips" role="group">
          {offered.map((label) => <button key={label} type="button" role="checkbox" aria-checked={lines.includes(label)} data-picked={lines.includes(label)}
            onClick={() => toggle(label)}>{label}</button>)}
        </div>
        <form className="ob-add" onSubmit={(event) => { event.preventDefault(); addCustom(); }}>
          <input value={custom} maxLength={20} onChange={(event) => setCustom(event.target.value)} placeholder="其他身份，例如：播客主" aria-label="其他身份" />
          <button type="submit" className="ob-btn ob-quiet" disabled={!custom.trim()}>添加</button>
        </form>
      </fieldset>
      {lines.length > 1 && <fieldset className="ob-question">
        <legend>未来 12–24 个月，哪一条是不能动摇的底座？</legend>
        <div className="ob-chips" role="radiogroup">
          {[...lines, ALL_EQUAL].map((label) => <button key={label} type="button" role="radio" aria-checked={(chosenBase || ALL_EQUAL) === label}
            data-picked={(chosenBase || ALL_EQUAL) === label} onClick={() => setBase(label === ALL_EQUAL ? "" : label)}>{label}</button>)}
        </div>
      </fieldset>}
      {lines.length > 0 && <fieldset className="ob-question">
        <legend>哪些有固定日程，比如课表或坐班？<small>最多两条；固定日程是一周的骨架，其余时间围绕它安排</small></legend>
        <div className="ob-chips" role="group">
          {lines.map((label) => <button key={label} type="button" role="checkbox" aria-checked={chosenFixed.includes(label)} data-picked={chosenFixed.includes(label)}
            onClick={() => setFixed((list) => list.includes(label) ? list.filter((item) => item !== label) : list.length >= 2 ? list : [...list, label])}>{label}</button>)}
          <button type="button" role="checkbox" aria-checked={chosenFixed.length === 0} data-picked={chosenFixed.length === 0} onClick={() => setFixed([])}>{NO_FIXED}</button>
        </div>
      </fieldset>}
    </>}

    <div className="ob-opening-go">
      <button type="button" className="ob-btn ob-primary" disabled={busy || !lines.length || needsConnection} onClick={() => onStart({ tone, lines, base: chosenBase, fixed: chosenFixed })}>
        {hasMaterials ? "读完材料，开始访谈" : "开始访谈"}</button>
      {!lines.length ? <small className="ob-muted">先选至少一个身份</small>
        : needsConnection && <small className="ob-muted">先<a href="/connect?next=/onboarding">连接本人的 ChatGPT</a></small>}
    </div>
  </section>;
}
