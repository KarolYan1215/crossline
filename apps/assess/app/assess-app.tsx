"use client";

import { useState } from "react";
import { LIKERT, QUIZ_ITEMS, mctqLite, type MctqLiteInput, type MctqLiteResult, type PvtSummary } from "@crossline/core/assess";
import { Pvt } from "./pvt";
import { Result } from "./result";

type Step = "intro" | "quiz" | "sleep" | "pvt" | "result";

/**
 * The quick test's flow: what it is → sixteen statements → four clock times → an optional three-minute reaction test → the result.
 * The answers never leave the page: the only requests after load are the site's own script chunks (images, QR code).
 */
export function AssessApp({ waitlistUrl }: { waitlistUrl: string }) {
  const [step, setStep] = useState<Step>("intro");
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [sleep, setSleep] = useState<MctqLiteInput>({ workdays: 5, work: { sleep: "23:30", wake: "07:30" }, free: { sleep: "00:30", wake: "09:00", alarm: false } });
  const [sleepError, setSleepError] = useState("");
  const [pvt, setPvt] = useState<{ summary: PvtSummary; rts: number[] } | null>(null);
  const answered = QUIZ_ITEMS.filter((item) => answers[item.id]).length;

  const go = (next: Step) => { setStep(next); window.scrollTo({ top: 0 }); };
  const checkSleep = () => {
    try { mctqLite(sleep); setSleepError(""); go("pvt"); } catch { setSleepError("请把四个时间都填成「时:分」"); }
  };
  let chrono: MctqLiteResult | null = null;
  try { chrono = mctqLite(sleep); } catch { chrono = null; }

  return <main className="as-main">
    {step === "intro" && <section className="as-sheet as-intro">
      <p className="as-kicker">Crossline 速测</p>
      <h1>思维模式与精力节律</h1>
      <p>三部分，约 8 分钟：</p>
      <ol>
        <li><b>16 道题</b>：在四条轴上看你偏向哪一端，落到 16 种思维模式类型之一。</li>
        <li><b>4 个时间</b>：工作日和休息日几点睡、几点醒，算出早晚型和社会时差（精简版慕尼黑时型问卷）。</li>
        <li><b>3 分钟反应测试</b>（可跳过）：屏幕上数字一出现就点，测此刻的警觉度（PVT-B）。</li>
      </ol>
      <p className="as-note">全部在你的浏览器里计算，不上传、不保存任何答案。结果可以存成图片或打印成 PDF。</p>
      <button type="button" className="as-primary" onClick={() => go("quiz")}>开始</button>
    </section>}

    {step === "quiz" && <section className="as-sheet">
      <p className="as-kicker">第 1 部分 · {answered} / {QUIZ_ITEMS.length}</p>
      <h2>这些说法有多符合你？</h2>
      <ol className="as-quiz">{QUIZ_ITEMS.map((item, index) => <li key={item.id}>
        <p><span className="as-num">{index + 1}</span>{item.text}</p>
        <div className="as-likert" role="radiogroup" aria-label={item.text}>{LIKERT.map((label, value) =>
          <button key={label} type="button" role="radio" aria-checked={answers[item.id] === value + 1} data-on={answers[item.id] === value + 1 || undefined}
            onClick={() => setAnswers((current) => ({ ...current, [item.id]: value + 1 }))}>{label}</button>)}</div>
      </li>)}</ol>
      <button type="button" className="as-primary" disabled={answered < QUIZ_ITEMS.length} onClick={() => go("sleep")}>
        {answered < QUIZ_ITEMS.length ? `还有 ${QUIZ_ITEMS.length - answered} 题` : "下一步"}</button>
    </section>}

    {step === "sleep" && <section className="as-sheet">
      <p className="as-kicker">第 2 部分</p>
      <h2>平时几点睡着、几点醒？</h2>
      <p className="as-note">填最近几周的通常情况。「睡着」指真正入睡的时间，不是上床的时间。</p>
      <label className="as-field">每周工作（上学）几天
        <select value={sleep.workdays} onChange={(event) => setSleep({ ...sleep, workdays: Number(event.target.value) })}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((days) => <option key={days} value={days}>{days} 天</option>)}</select></label>
      <fieldset className="as-times"><legend>工作日</legend>
        <label>睡着<input type="time" value={sleep.work.sleep} onChange={(event) => setSleep({ ...sleep, work: { ...sleep.work, sleep: event.target.value } })} /></label>
        <label>醒来<input type="time" value={sleep.work.wake} onChange={(event) => setSleep({ ...sleep, work: { ...sleep.work, wake: event.target.value } })} /></label>
      </fieldset>
      <fieldset className="as-times"><legend>休息日</legend>
        <label>睡着<input type="time" value={sleep.free.sleep} onChange={(event) => setSleep({ ...sleep, free: { ...sleep.free, sleep: event.target.value } })} /></label>
        <label>醒来<input type="time" value={sleep.free.wake} onChange={(event) => setSleep({ ...sleep, free: { ...sleep.free, wake: event.target.value } })} /></label>
        <label className="as-check"><input type="checkbox" checked={Boolean(sleep.free.alarm)} onChange={(event) => setSleep({ ...sleep, free: { ...sleep.free, alarm: event.target.checked } })} />休息日也用闹钟叫醒</label>
      </fieldset>
      {sleepError && <p className="as-error" role="alert">{sleepError}</p>}
      <button type="button" className="as-primary" onClick={checkSleep}>下一步</button>
    </section>}

    {step === "pvt" && <Pvt onDone={(result) => { setPvt(result); go("result"); }} onSkip={() => { setPvt(null); go("result"); }} />}

    {step === "result" && chrono && <Result answers={answers} sleep={sleep} chrono={chrono} pvt={pvt} waitlistUrl={waitlistUrl}
      onRestart={() => { setAnswers({}); setPvt(null); go("intro"); }} />}
  </main>;
}
