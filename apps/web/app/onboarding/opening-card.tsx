"use client";

import { useState } from "react";
import { ONBOARDING_TONE_LABEL, ONBOARDING_TONES, type OnboardingTone } from "@crossline/core";
import { DOMAIN_PACKS, LINE_DOMAINS, type LineDomain } from "@crossline/identity-packs";
import { MATERIALS_FIRST_REPLY, NO_MATERIALS_REPLY } from "./onboarding-types";

/**
 * The interview's first message (docs/onboarding-v3.md, decided 2026-10-14): the premise in plain words, how it runs and what it gives,
 * then one card of fact questions answered together — how to be spoken to, the lines, the one that cannot move, and the ones with a fixed
 * schedule. It replaces the old line-setup screen and the six-level lecture; the structure is shown at the end, drawn from what was said.
 * Its answers are written in code (tone, lines) and sent as the first reply, so the interview quotes them like anything else said.
 *
 * The lite edition (decided 2026-10-19, docs/domain-lines.md) is asked first: 健康 and 财富 as domain lines plus, when there is one, the one
 * thing with a fixed schedule. It is not a mode: the answer only pre-fills the lines, and more can be added on the 主线 page at any time.
 */
const COMMON_LINES = ["研究者", "学生", "工程师", "创业者", "创作者", "投资者", "设计师", "教师", "职员", "自由职业者"];
const DOMAIN_NOUNS = LINE_DOMAINS.map((domain) => DOMAIN_PACKS[domain].noun);
const ALL_EQUAL = "几条并重";
const NO_FIXED = "都没有";

export type Edition = "lite" | "full";
export type OpeningAnswer = { tone: OnboardingTone; edition: Edition; lines: string[]; domains: Record<string, LineDomain>; base: string; fixed: string[] };

const EDITION_LABEL: Record<Edition, { label: string; detail: string }> = {
  lite: { label: "极简", detail: "健康、财富，加一件有固定日程的事" },
  full: { label: "完整", detail: "自己选几条正在投入的身份" }
};

/** The domain a label on the card stands for: the domain lines' own nouns (健康管理者, 理财者). */
const domainOf = (label: string): LineDomain | undefined => LINE_DOMAINS.find((domain) => DOMAIN_PACKS[domain].noun === label);
const domainsOf = (labels: string[]) => Object.fromEntries(labels.flatMap((label) => { const domain = domainOf(label); return domain ? [[label, domain]] : []; }));
const shown = (label: string) => { const domain = domainOf(label); return domain ? `${label}（${DOMAIN_PACKS[domain].label}领域）` : label; };

/** The first reply as the person "says" it, in the screen's own words, so every answer is a verbatim span to quote. */
export function openingReply(answer: OpeningAnswer, withMaterials: boolean): string {
  return [`【语气】${ONBOARDING_TONE_LABEL[answer.tone].label}`, `【版本】${EDITION_LABEL[answer.edition].label}`,
    `【我的主线】${answer.lines.map(shown).join("、")}`,
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
  const [edition, setEdition] = useState<Edition>("full");
  const [lines, setLines] = useState<string[]>(linesKnown ? knownLines : []);
  const [liteDomains, setLiteDomains] = useState<string[]>(DOMAIN_NOUNS);
  const [hardName, setHardName] = useState("");
  const [custom, setCustom] = useState("");
  const [base, setBase] = useState("");
  const [fixed, setFixed] = useState<string[]>([]);
  const toggle = (label: string) => setLines((list) => list.includes(label) ? list.filter((item) => item !== label) : list.length >= 5 ? list : [...list, label]);
  const addCustom = () => {
    const label = custom.trim().slice(0, 20);
    if (label && !lines.includes(label) && lines.length < 5) setLines((list) => [...list, label]);
    setCustom("");
  };
  // Lite: the named fixed-schedule line first (it is the hard constraint), then the domain lines kept ticked.
  const hard = hardName.trim().slice(0, 20);
  const chosen = linesKnown || edition === "full" ? lines : [...(hard && !DOMAIN_NOUNS.includes(hard) ? [hard] : []), ...liteDomains];
  const chosenBase = chosen.includes(base) ? base : edition === "lite" && hard && chosen.includes(hard) ? hard : "";
  const chosenFixed = edition === "lite" ? (hard && chosen.includes(hard) ? [hard] : []) : fixed.filter((label) => chosen.includes(label));
  const offered = [...COMMON_LINES, ...DOMAIN_NOUNS, ...lines.filter((label) => !COMMON_LINES.includes(label) && !DOMAIN_NOUNS.includes(label))];

  return <section className="ob-opening ob-voice" aria-label="开始访谈">
    <div className="ob-opening-intro">
      {/* The owner's own note, word for word (2026-10-16); the only signed text in the app. */}
      <section className="ob-opening-note" aria-label="开发者的话">
        <h3>开发者的话</h3>
        <p>AI把一个人能做的事放大了好几倍。查资料、写代码、做内容、跑分析，都不再需要一整个团队。在这个时代，一个人同时做研究、创业、写东西、投资，第一次变得现实。</p>
        <p>但精力没有随着能力放大。一天里真正清醒的时间还是有限的，想做的许多事南辕北辙，哪怕交给AI也只是完成任务，却无法替你成长：读懂一篇论文、想清楚一个产品、练成一门手艺，都需要人类活动的参与。</p>
        <p>现在的personal agent专注于解放劳动力，告诉你哪些事Agent可以代劳，解构后却没有建构，不告诉你什么时候做什么比较好，怎么做才能提升自我，怎样让不同成果相辅相成。界面也不是照着人的注意力设计的。Crossline 则更关注人类该关注什么：基于你的精力节律和每条主线真实进度，再决定哪些交给 AI、哪些留给你，并把留给你的事放进你状态最好的时段。</p>
        <p>同时推进几条线的人，缺的往往不是计划，而是一张能同时看见所有主线和自己精力的图：哪条线在消耗你，哪条线的产出能喂给另一条，一天里哪几个小时适合深度工作。这次访谈就是来画这张图的。画好之后，AI 按它把各条线实时排进同一张日历。</p>
        <p>做完之后，开始任务之前，你会得到一份独属于你的报告，欢迎诸君，在AI时代夺回属于人类的部分。</p>
        <p className="ob-opening-sign">——Y.K.</p>
      </section>
      <ol className="ob-opening-plan">
        <li><b>认识你</b><span>你有哪些想成为的身份，各自正在做什么、大概什么时候截止；时间说个大概就行，材料里有的不再问。</span></li>
        <li><b>聊深一点</b><span>你现在的处境、为什么做这些、日常的精力情况。每一轮都会给你一条关于你自己的观察。</span></li>
        <li><b>拿到结果</b><span>一周的骨架草稿和画像报告。具体项目的细节，到拆任务时再补。</span></li>
      </ol>
      <p className="ob-opening-time">大约 30 分钟后拿到一份你的画像报告（几条主线各是什么、精力怎么分），以及把各条主线的事排进同一张日历的计划。左侧可以先放入简历、课表、课程大纲，访谈会先读材料，只问材料里没有的。</p>
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
        <legend>从哪一版开始？<small>之后随时可以在主线页加主线</small></legend>
        <div className="ob-chips" role="radiogroup">
          {(["lite", "full"] as const).map((id) => <button key={id} type="button" role="radio" aria-checked={edition === id} data-picked={edition === id}
            onClick={() => setEdition(id)}>{EDITION_LABEL[id].label}<small>{EDITION_LABEL[id].detail}</small></button>)}
        </div>
      </fieldset>
      {edition === "lite" ? <>
        <fieldset className="ob-question">
          <legend>要规划的方面<small>至少留一个</small></legend>
          <div className="ob-chips" role="group">
            {DOMAIN_NOUNS.map((label) => <button key={label} type="button" role="checkbox" aria-checked={liteDomains.includes(label)} data-picked={liteDomains.includes(label)}
              onClick={() => setLiteDomains((list) => list.includes(label) ? (list.length > 1 ? list.filter((item) => item !== label) : list) : [...list, label])}>{shown(label)}</button>)}
          </div>
        </fieldset>
        <fieldset className="ob-question">
          <legend>有没有固定日程、不能挪的事？<small>例如上班、上学、带娃；写成一个词，没有就留空</small></legend>
          <div className="ob-add">
            <input value={hardName} maxLength={20} onChange={(event) => setHardName(event.target.value)} placeholder="例如：上班" aria-label="有固定日程的事" />
          </div>
        </fieldset>
      </> : <fieldset className="ob-question">
        <legend>你正在投入的身份有哪些？<small>写成身份名词，2–5 个</small></legend>
        <div className="ob-chips" role="group">
          {offered.map((label) => <button key={label} type="button" role="checkbox" aria-checked={lines.includes(label)} data-picked={lines.includes(label)}
            onClick={() => toggle(label)}>{shown(label)}</button>)}
        </div>
        <form className="ob-add" onSubmit={(event) => { event.preventDefault(); addCustom(); }}>
          <input value={custom} maxLength={20} onChange={(event) => setCustom(event.target.value)} placeholder="其他身份，例如：播客主" aria-label="其他身份" />
          <button type="submit" className="ob-btn ob-quiet" disabled={!custom.trim()}>添加</button>
        </form>
      </fieldset>}
      {chosen.length > 1 && <fieldset className="ob-question">
        <legend>未来 12–24 个月，哪一条是不能动摇的底座？</legend>
        <div className="ob-chips" role="radiogroup">
          {[...chosen, ALL_EQUAL].map((label) => <button key={label} type="button" role="radio" aria-checked={(chosenBase || ALL_EQUAL) === label}
            data-picked={(chosenBase || ALL_EQUAL) === label} onClick={() => setBase(label === ALL_EQUAL ? "" : label)}>{label}</button>)}
        </div>
      </fieldset>}
      {edition === "full" && lines.length > 0 && <fieldset className="ob-question">
        <legend>哪些有固定日程，比如课表或坐班？<small>最多两条；固定日程是一周的骨架，其余时间围绕它安排</small></legend>
        <div className="ob-chips" role="group">
          {lines.map((label) => <button key={label} type="button" role="checkbox" aria-checked={chosenFixed.includes(label)} data-picked={chosenFixed.includes(label)}
            onClick={() => setFixed((list) => list.includes(label) ? list.filter((item) => item !== label) : list.length >= 2 ? list : [...list, label])}>{label}</button>)}
          <button type="button" role="checkbox" aria-checked={chosenFixed.length === 0} data-picked={chosenFixed.length === 0} onClick={() => setFixed([])}>{NO_FIXED}</button>
        </div>
      </fieldset>}
    </>}

    <div className="ob-opening-go">
      <button type="button" className="ob-btn ob-primary" disabled={busy || !chosen.length || needsConnection}
        onClick={() => onStart({ tone, edition: linesKnown ? "full" : edition, lines: chosen, domains: domainsOf(chosen), base: chosenBase, fixed: chosenFixed })}>
        {hasMaterials ? "读完材料，开始访谈" : "开始访谈"}</button>
      {!chosen.length ? <small className="ob-muted">先选至少一个身份</small>
        : needsConnection && <small className="ob-muted">先<a href="/connect?next=/onboarding">连接模型（ChatGPT 或 API）</a></small>}
    </div>
  </section>;
}
