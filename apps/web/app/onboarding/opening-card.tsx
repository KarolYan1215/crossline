"use client";

import { useState } from "react";
import { ONBOARDING_TONE_LABEL, ONBOARDING_TONES, type OnboardingTone } from "@crossline/core";
import { tFor, type Locale } from "../../lib/i18n";
import { useLocale } from "../locale-context";
import { withLink } from "./rich-text";
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

/**
 * The first reply as the person "says" it, in the screen's own words, so every answer is a verbatim span to quote — in the language the
 * screen was in (the lines chosen on an English screen are already English words).
 */
export function openingReply(answer: OpeningAnswer, withMaterials: boolean, locale?: Locale): string {
  const t = tFor(locale);
  const list = (items: string[]) => items.join(locale === "en" ? ", " : "、");
  return [t("【语气】{{tone}}", { tone: t(ONBOARDING_TONE_LABEL[answer.tone].label) }), t("【我的主线】{{lines}}", { lines: list(answer.lines) }),
    t("【未来 12–24 个月的底座】{{base}}", { base: answer.base || t(ALL_EQUAL) }),
    t("【有固定日程的主线】{{fixed}}", { fixed: answer.fixed.length ? list(answer.fixed) : t(NO_FIXED) }),
    t(withMaterials ? MATERIALS_FIRST_REPLY : NO_MATERIALS_REPLY)].join("\n");
}

export function OpeningCard({ linesKnown, knownLines, initialTone, busy, hasMaterials, needsConnection = false, onStart }: {
  /** The lines are already set (an account from before this card): only the tone is asked. */
  linesKnown: boolean; knownLines: string[]; initialTone: OnboardingTone; busy: boolean; hasMaterials: boolean;
  /** No model connection yet: the card can be filled in, but the first round cannot run until the step above it is done. */
  needsConnection?: boolean;
  onStart: (answer: OpeningAnswer) => void;
}) {
  const locale = useLocale();
  const t = tFor(locale);
  // On an English screen the common lines are offered, and saved, as English words: the person chose them in that language.
  const common = COMMON_LINES.map((label) => t(label));
  const allEqual = t(ALL_EQUAL), noFixed = t(NO_FIXED);
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
  const offered = [...common, ...lines.filter((label) => !common.includes(label))];

  return <section className="ob-opening ob-voice" aria-label={t("开始访谈")}>
    <div className="ob-opening-intro">
      {/* The owner's own note, word for word (2026-10-16); the only signed text in the app. */}
      <section className="ob-opening-note" aria-label={t("开发者的话")}>
        <h3>{t("开发者的话")}</h3>
        <p>{t("AI把一个人能做的事放大了好几倍。查资料、写代码、做内容、跑分析，都不再需要一整个团队。在这个时代，一个人同时做研究、创业、写东西、投资，第一次变得现实。")}</p>
        <p>{t("但精力没有随着能力放大。一天里真正清醒的时间还是有限的，想做的许多事南辕北辙，哪怕交给AI也只是完成任务，却无法替你成长：读懂一篇论文、想清楚一个产品、练成一门手艺，都需要人类活动的参与。")}</p>
        <p>{t("现在的personal agent专注于解放劳动力，告诉你哪些事Agent可以代劳，解构后却没有建构，不告诉你什么时候做什么比较好，怎么做才能提升自我，怎样让不同成果相辅相成。")}{t("界面也不是照着人的注意力设计的。")}{t("Crossline 则更关注人类该关注什么：基于你的精力节律和每条主线真实进度，再决定哪些交给 AI、哪些留给你，并把留给你的事放进你状态最好的时段。")}</p>
        <p>{t("同时推进几条线的人，缺的往往不是计划，而是一张能同时看见所有主线和自己精力的图：哪条线在消耗你，哪条线的产出能喂给另一条，一天里哪几个小时适合深度工作。")}{t("这次访谈就是来画这张图的。")}{t("画好之后，AI 按它把各条线实时排进同一张日历。")}</p>
        <p>{t("做完之后，开始任务之前，你会得到一份独属于你的报告，欢迎诸君，在AI时代夺回属于人类的部分。")}</p>
        <p className="ob-opening-sign">——Y.K.</p>
      </section>
      <ol className="ob-opening-plan">
        <li><b>{t("认识你")}</b><span>{t("你有哪些想成为的身份，手上有哪些材料支持你。")}</span></li>
        <li><b>{t("聊深一点")}</b><span>{t("你现在的处境、为什么做这些，动机和愿景是什么、你日常的精力情况。")}</span></li>
        <li><b>{t("补齐细节")}</b><span>{t("每个具体项目哪天截止、要交出什么，你用什么来验收具体项目的成果。")}</span></li>
      </ol>
      <p className="ob-opening-time">{t("大约 30 分钟后拿到一份全面的 AI 时代超级个体跨人生主线报告和跨主线排程计划。左侧可以先放入简历、课表、课程大纲，访谈会先读材料，只问材料里没有的。")}</p>
    </div>

    <fieldset className="ob-question">
      <legend>{t("你希望我怎么跟你说话？")}</legend>
      <div className="ob-chips" role="radiogroup">
        {ONBOARDING_TONES.map((id) => <button key={id} type="button" role="radio" aria-checked={tone === id} data-picked={tone === id}
          onClick={() => setTone(id)}>{t(ONBOARDING_TONE_LABEL[id].label)}<small>{t(ONBOARDING_TONE_LABEL[id].detail)}</small></button>)}
      </div>
    </fieldset>

    {!linesKnown && <>
      <fieldset className="ob-question">
        <legend>{t("你正在投入的身份有哪些？")}<small>{t("写成身份名词，2–5 个")}</small></legend>
        <div className="ob-chips" role="group">
          {offered.map((label) => <button key={label} type="button" role="checkbox" aria-checked={lines.includes(label)} data-picked={lines.includes(label)}
            onClick={() => toggle(label)}>{label}</button>)}
        </div>
        <form className="ob-add" onSubmit={(event) => { event.preventDefault(); addCustom(); }}>
          <input value={custom} maxLength={20} onChange={(event) => setCustom(event.target.value)} placeholder={t("其他身份，例如：播客主")} aria-label={t("其他身份")} />
          <button type="submit" className="ob-btn ob-quiet" disabled={!custom.trim()}>{t("添加")}</button>
        </form>
      </fieldset>
      {lines.length > 1 && <fieldset className="ob-question">
        <legend>{t("未来 12–24 个月，哪一条是不能动摇的底座？")}</legend>
        <div className="ob-chips" role="radiogroup">
          {[...lines, allEqual].map((label) => <button key={label} type="button" role="radio" aria-checked={(chosenBase || allEqual) === label}
            data-picked={(chosenBase || allEqual) === label} onClick={() => setBase(label === allEqual ? "" : label)}>{label}</button>)}
        </div>
      </fieldset>}
      {lines.length > 0 && <fieldset className="ob-question">
        <legend>{t("哪些有固定日程，比如课表或坐班？")}<small>{t("最多两条；固定日程是一周的骨架，其余时间围绕它安排")}</small></legend>
        <div className="ob-chips" role="group">
          {lines.map((label) => <button key={label} type="button" role="checkbox" aria-checked={chosenFixed.includes(label)} data-picked={chosenFixed.includes(label)}
            onClick={() => setFixed((list) => list.includes(label) ? list.filter((item) => item !== label) : list.length >= 2 ? list : [...list, label])}>{label}</button>)}
          <button type="button" role="checkbox" aria-checked={chosenFixed.length === 0} data-picked={chosenFixed.length === 0} onClick={() => setFixed([])}>{noFixed}</button>
        </div>
      </fieldset>}
    </>}

    <div className="ob-opening-go">
      <button type="button" className="ob-btn ob-primary" disabled={busy || !lines.length || needsConnection} onClick={() => onStart({ tone, lines, base: chosenBase, fixed: chosenFixed })}>
        {hasMaterials ? t("读完材料，开始访谈") : t("开始访谈")}</button>
      {!lines.length ? <small className="ob-muted">{t("先选至少一个身份")}</small>
        : needsConnection && <small className="ob-muted">{withLink(t("先<a>连接本人的 ChatGPT</a>"), (inner) => <a href="/connect?next=/onboarding">{inner}</a>)}</small>}
    </div>
  </section>;
}
