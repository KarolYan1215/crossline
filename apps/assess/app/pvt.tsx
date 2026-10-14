"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PVT_DURATION_MS, PVT_TIMEOUT_MS, pvtIsi, pvtSummary, type PvtSummary, type PvtTrial } from "@crossline/core/assess";

type Phase = "ready" | "waiting" | "stimulus" | "done";

/**
 * The three-minute PVT-B: after a random 2–5 s a millisecond counter starts; a tap, click or the space bar stops it. A tap with no counter
 * running is a false start and restarts the wait. Timing uses `performance.now()` at the input event; the counter on screen is only
 * feedback, so a slow frame never changes a measured time.
 */
export function Pvt({ onDone, onSkip }: { onDone: (result: { summary: PvtSummary; rts: number[] }) => void; onSkip: () => void }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [shown, setShown] = useState<string>("");
  const [left, setLeft] = useState(PVT_DURATION_MS);
  const trials = useRef<PvtTrial[]>([]);
  const premature = useRef(0);
  const started = useRef(0);
  const stimulusAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const phaseRef = useRef<Phase>("ready");
  const set = (next: Phase) => { phaseRef.current = next; setPhase(next); };

  const finish = useCallback(() => {
    window.clearTimeout(timer.current);
    if (frame.current) cancelAnimationFrame(frame.current);
    set("done");
    onDone({ summary: pvtSummary(trials.current, premature.current), rts: trials.current.map((trial) => trial.rtMs ?? PVT_TIMEOUT_MS) });
  }, [onDone]);

  const scheduleNext = useCallback(() => {
    if (performance.now() - started.current >= PVT_DURATION_MS) { finish(); return; }
    set("waiting");
    timer.current = window.setTimeout(() => {
      set("stimulus");
      stimulusAt.current = performance.now();
      const tick = () => { setShown(String(Math.round(performance.now() - stimulusAt.current))); frame.current = requestAnimationFrame(tick); };
      tick();
      timer.current = window.setTimeout(() => { // nobody answered
        if (frame.current) cancelAnimationFrame(frame.current);
        trials.current.push({ rtMs: null });
        setShown("超时");
        scheduleNext();
      }, PVT_TIMEOUT_MS);
    }, pvtIsi(Math.random()));
  }, [finish]);

  const respond = useCallback((at: number) => {
    if (phaseRef.current === "stimulus") {
      window.clearTimeout(timer.current);
      if (frame.current) cancelAnimationFrame(frame.current);
      const rt = Math.round(at - stimulusAt.current);
      trials.current.push({ rtMs: rt });
      setShown(String(rt));
      scheduleNext();
    } else if (phaseRef.current === "waiting") {
      premature.current += 1;
      window.clearTimeout(timer.current);
      setShown("太早了");
      scheduleNext();
    }
  }, [scheduleNext]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.code === "Space" && phaseRef.current !== "ready") { event.preventDefault(); respond(event.timeStamp || performance.now()); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [respond]);
  useEffect(() => {
    if (phase === "ready" || phase === "done") return;
    const clock = window.setInterval(() => setLeft(Math.max(0, PVT_DURATION_MS - (performance.now() - started.current))), 500);
    return () => window.clearInterval(clock);
  }, [phase]);
  useEffect(() => () => { window.clearTimeout(timer.current); if (frame.current) cancelAnimationFrame(frame.current); }, []);

  const start = () => { trials.current = []; premature.current = 0; started.current = performance.now(); setShown(""); scheduleNext(); };

  if (phase === "ready") return <section className="as-sheet">
    <p className="as-kicker">第 3 部分 · 可跳过</p>
    <h2>3 分钟反应测试</h2>
    <p>开始后，框里会不定时出现一个跳动的数字。数字一出现就<b>点框</b>（电脑上也可以按空格键），越快越好。数字出现之前不要点。</p>
    <p className="as-note">找一个 3 分钟不被打断的时候做。结果只反映此刻的警觉度，会随睡眠和时段变化。</p>
    <div className="as-row"><button type="button" className="as-primary" onClick={start}>开始测试</button><button type="button" onClick={onSkip}>跳过这部分</button></div>
  </section>;

  return <section className="as-sheet">
    <p className="as-kicker">第 3 部分 · 剩余 {Math.ceil(left / 1000)} 秒</p>
    <button type="button" className="as-pvt" data-phase={phase} aria-label="反应框：数字出现就点"
      onPointerDown={(event) => { event.preventDefault(); respond(event.timeStamp || performance.now()); }}>
      <span className="as-pvt-count">{phase === "stimulus" ? shown : shown || "　"}</span>
    </button>
    <button type="button" onClick={finish}>提前结束</button>
  </section>;
}
