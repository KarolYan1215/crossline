"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Bot, CircleStop } from "lucide-react";
import type { HelperDay } from "../lib/helper";
import { pollWhileVisible } from "./ui/visible-poll";
import { ICON, IconButton } from "./ui/icon-button";
import { useT } from "./locale-context";
import { minuteInZone } from "./timeline/model";

const toMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The band's span: the day's blocks and now, widened to whole hours, never narrower than 08:00–20:00. Exported for its test. */
export function bandAxis(blocks: Array<{ start: string; end: string }>, now?: number): { from: number; to: number } {
  const starts = blocks.map((block) => toMinutes(block.start)), ends = blocks.map((block) => toMinutes(block.end) || 1440);
  const from = Math.min(8 * 60, ...starts, ...(now !== undefined ? [now] : []));
  const to = Math.max(20 * 60, ...ends, ...(now !== undefined ? [now + 30] : []));
  return { from: Math.floor(from / 60) * 60, to: Math.min(1440, Math.ceil(to / 60) * 60) };
}

/** Today for the narrow window, read once a minute while it is visible; undefined until the first answer. */
export function useHelperDay(): HelperDay | undefined {
  const [day, setDay] = useState<HelperDay | undefined>();
  useEffect(() => pollWhileVisible(async () => {
    const body = await fetch("/api/helper/day", { cache: "no-store" }).then((response) => response.ok ? response.json() : null).catch(() => null) as
      ({ ok?: boolean } & HelperDay) | null;
    if (body?.ok) setDay(body);
  }, 60_000), []);
  return day;
}

/**
 * Today as one band (docs/plans/page-drafts-1028/helper.html): work filled in its line's colour, fixed arrangements outlined, the hour now
 * as a line, and under it the time and the next block of work. It replaced the whole day panel the narrow window used to carry.
 */
export function HelperBand({ day }: { day: HelperDay }) {
  const t = useT();
  const [nowIso, setNowIso] = useState(day.nowIso);
  useEffect(() => {
    setNowIso(day.nowIso);
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 60_000);
    return () => clearInterval(timer);
  }, [day.nowIso]);
  const now = minuteInZone(nowIso, day.timeZone);
  const axis = bandAxis(day.blocks, now);
  const at = (minutes: number) => `${(minutes - axis.from) / (axis.to - axis.from) * 100}%`;
  // The two ends, and every third hour between them that has room (a label no closer than an hour to an end).
  const ticks: number[] = [axis.from];
  for (let minute = Math.ceil((axis.from + 60) / 180) * 180; minute <= axis.to - 60; minute += 180) ticks.push(minute);
  ticks.push(axis.to);
  const summary = day.blocks.length
    ? day.blocks.map((block) => `${block.start}–${block.end} ${block.title}`).join("; ")
    : t("今天没有排给工作的时段");
  return <div className="hw-band">
    <div className="hw-band-track" role="img" aria-label={t("今天的安排：{{summary}}", { summary })}>
      {day.blocks.map((block, index) => <span key={`${block.start}-${index}`} className="hw-band-block" data-kind={block.kind} data-line={block.line ?? "none"}
        data-missed={block.missed || undefined} title={`${block.start}–${block.end} ${block.title}`}
        style={{ left: at(toMinutes(block.start)), width: `max(3px, calc(${at(toMinutes(block.end) || 1440)} - ${at(toMinutes(block.start))}))` } as CSSProperties} />)}
      {now >= axis.from && now <= axis.to && <span className="hw-band-now" style={{ left: at(now) }} aria-hidden="true" />}
    </div>
    <div className="hw-band-axis" aria-hidden="true">{ticks.map((minute) => <span key={minute} style={{ left: at(minute) }}>{clock(minute).slice(0, 2)}</span>)}</div>
    <p className="hw-band-next">{day.next
      ? t("现在 {{now}} · 下一块 {{start}} {{title}}", { now: clock(now), start: day.next.start, title: day.next.step ? `${day.next.title} · ${day.next.step}` : day.next.title })
      : t("现在 {{now}} · 今天没有下一块工作", { now: clock(now) })}</p>
  </div>;
}

type Progress = { commands: unknown[]; files: string[]; searches: string[]; plan?: { steps: Array<{ step: string; status: string }> } } | null;

/**
 * One running assistant task as a chip (the Manus-style 「运行中」 chip; its home is here, scenarios.md conclusion 11): what it works on, how
 * far its own plan has got (else how many sources it read and files it wrote), and 停止. Polled every few seconds; a stopped task is
 * never run again by itself.
 */
export function RunningChip({ task }: { task: HelperDay["running"][number] }) {
  const t = useT();
  const [progress, setProgress] = useState<Progress>(null);
  const [state, setState] = useState<"running" | "stopping" | "ended">("running");
  useEffect(() => {
    if (state === "ended") return;
    let live = true;
    const read = async () => {
      const body = await fetch(`/api/agent/tasks/${encodeURIComponent(task.taskId)}/progress`).then((response) => response.json()).catch(() => undefined) as
        { ok?: boolean; progress?: Progress } | undefined;
      if (!live || !body?.ok) return;
      if (!body.progress) setState("ended"); else setProgress(body.progress);
    };
    void read();
    const timer = setInterval(() => void read(), 4_000);
    return () => { live = false; clearInterval(timer); };
  }, [task.taskId, state]);
  const stop = async () => {
    setState("stopping");
    const response = await fetch(`/api/agent/tasks/${encodeURIComponent(task.taskId)}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => undefined);
    setState(response?.ok ? "ended" : "running");
  };
  const steps = progress?.plan?.steps ?? [];
  const done = steps.filter((step) => step.status === "completed").length;
  const share = steps.length ? done / steps.length : undefined;
  const note = state === "ended" ? t("已结束") : state === "stopping" ? t("停止中…")
    : steps.length ? t("第 {{done}}/{{total}} 步", { done: Math.min(done + 1, steps.length), total: steps.length })
    : progress ? t("已读 {{read}} 份 · 写入 {{files}} 份", { read: progress.searches.length, files: progress.files.length }) : t("开始中");
  return <li className="hw-chip" data-state={state}>
    <Bot {...ICON} />
    <span className="hw-chip-title" title={task.title}>{t("助手 · {{title}}", { title: task.title })}</span>
    <span className="hw-chip-bar" data-indeterminate={share === undefined || undefined} aria-hidden="true"><i style={{ width: `${Math.round((share ?? 0.35) * 100)}%` }} /></span>
    <small className="hw-chip-note" role="status">{note}</small>
    {state === "running" && <IconButton label={t("停止「{{title}}」", { title: task.title })} icon={<CircleStop {...ICON} />} onClick={() => void stop()} />}
  </li>;
}
