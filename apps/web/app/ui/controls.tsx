"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { EDIT_MINUTES } from "@crossline/core";

/** A row of mutually exclusive choices that take effect at once — the standard settings control, in place of a select or a fold. */
export function SegmentedControl<T extends string>({ value, options, onChange, label, disabled }: {
  value: T; options: ReadonlyArray<{ value: T; label: string; title?: string }>; onChange: (value: T) => void; label: string; disabled?: boolean;
}) {
  return <div className="ui-segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
      title={option.title} disabled={disabled} onClick={() => option.value !== value && onChange(option.value)}>{option.label}</button>)}
  </div>;
}

/**
 * A continuous 0–100 slider. `preset` draws the system's suggested value as a tick, so a person who moved away from it can see where
 * it was. `onCommit` fires once on release (keyboard or pointer) — that is what callers use to preview or save.
 */
export function Slider({ value, onChange, onCommit, preset, label, min = 0, max = 100, step = 1, format = (v: number) => String(v) }: {
  value: number; onChange: (value: number) => void; onCommit?: (value: number) => void; preset?: number; label: string;
  min?: number; max?: number; step?: number; format?: (value: number) => string;
}) {
  const pct = (v: number) => `${((v - min) / (max - min)) * 100}%`;
  return <div className="ui-slider" style={{ ["--fill" as string]: pct(value) }}>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      onPointerUp={(event) => onCommit?.(Number((event.target as HTMLInputElement).value))}
      onKeyUp={(event) => onCommit?.(Number((event.target as HTMLInputElement).value))} />
    {preset !== undefined && <i className="ui-slider-preset" style={{ left: pct(preset) }} title={`系统预设 ${format(preset)}`} />}
    <output className="mono">{format(value)}</output>
  </div>;
}

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** A date that is edited where it is shown: the chip opens the platform's own date picker. */
/** A day as the app writes it everywhere: 「10/19 周一」. */
export const dayLabel = (value: string) => { const day = new Date(`${value.slice(0, 10)}T12:00:00`); return `${day.getMonth() + 1}/${day.getDate()} ${WEEKDAY[day.getDay()]}`; };

export function DateChip({ value, onChange, label, empty = "未定" }: { value: string | undefined; onChange: (value: string) => void; label: string; empty?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const day = value ? new Date(`${value}T12:00:00`) : undefined;
  return <span className="ui-date-chip">
    <button type="button" aria-label={`${label}：${value ?? empty}`} onClick={() => {
      const element = input.current;
      if (!element) return;
      try { element.showPicker(); } catch { element.focus(); }
    }}>{value && day ? dayLabel(value) : empty}</button>
    <input ref={input} type="date" tabIndex={-1} aria-hidden="true" value={value ?? ""} onChange={(event) => event.target.value && onChange(event.target.value)} />
  </span>;
}

/**
 * The estimate as a range, not a sentence: optimistic (p25) to cautious (p85) with the usual value (p50) as a handle. Dragging the
 * handle moves the usual value and the range follows in proportion; the number shows above the bar while dragging. `samples` is how
 * many measured runs the range rests on — a narrow range with samples behind it is what used to be called 「高置信」.
 */
export { EDIT_MINUTES };

export function DurationBar({ p25, p50, p85, samples = 0, bounds = EDIT_MINUTES, onCommit, label = "时长" }: {
  p25: number; p50: number; p85: number; samples?: number; bounds?: { min: number; max: number }; onCommit?: (p50: number) => void; label?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const usual = draft ?? p50;
  const ratio = usual / Math.max(1, p50);
  const low = Math.round(p25 * ratio), high = Math.round(p85 * ratio);
  // The axis is fixed to the allowed range, never derived from the value being dragged: deriving it from the cautious end made the
  // axis grow under the pointer, so a drag to the right ran away to an arbitrarily large value.
  const max = bounds.max;
  const clamp = (minutes: number) => Math.min(bounds.max, Math.max(bounds.min, minutes));
  const at = (minutes: number) => `${Math.min(100, (minutes / max) * 100)}%`;
  const minutesAt = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return clamp(Math.round((((clientX - box.left) / box.width) * max) / 5) * 5);
  };
  const editable = Boolean(onCommit);
  const commit = (minutes: number) => { setDraft(null); if (minutes !== p50) onCommit?.(minutes); };
  return <div className="ui-duration" data-editable={editable || undefined}>
    {draft !== null && <span className="ui-duration-live mono" style={{ left: at(usual) }}>{formatMinutes(usual)}</span>}
    <div ref={track} className="ui-duration-track" title={`乐观 ${formatMinutes(low)} · 通常 ${formatMinutes(usual)} · 保守 ${formatMinutes(high)}${samples ? ` · ${samples} 次实测` : " · 尚无实测"}`}>
      <i className="ui-duration-range" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
      <button type="button" className="ui-duration-handle" style={{ left: at(usual) }} disabled={!editable}
        aria-label={`${label}：通常 ${formatMinutes(usual)}`} role="slider" aria-valuenow={usual} aria-valuemin={bounds.min} aria-valuemax={bounds.max}
        onPointerDown={(event) => { if (!editable) return; event.currentTarget.setPointerCapture(event.pointerId); setDraft(minutesAt(event.clientX)); }}
        onPointerMove={(event) => { if (draft !== null) setDraft(minutesAt(event.clientX)); }}
        onPointerUp={() => draft !== null && commit(draft)}
        onKeyDown={(event) => {
          if (!editable) return;
          const step = event.key === "ArrowRight" ? 5 : event.key === "ArrowLeft" ? -5 : 0;
          if (step) { event.preventDefault(); commit(clamp(p50 + step)); }
        }} />
    </div>
    <span className="ui-duration-text mono"><span>{formatMinutes(usual)}</span><small><span>{formatMinutes(low)}–</span><span>{formatMinutes(high)}</span></small></span>
  </div>;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} 时 ${rest} 分` : `${hours} 小时`;
}

/**
 * Progress of one criterion or step in quarters, red at a quarter to green when full. Clicking it (when `onConfirm` is given) marks it
 * complete: the person saying the standard is met with nothing to hand in.
 */
export function ProgressRing({ quarters, label, onConfirm, size = 22 }: { quarters: number; label: string; onConfirm?: () => void; size?: number }) {
  const q = Math.max(0, Math.min(4, Math.round(quarters)));
  const r = size / 2 - 3, c = size / 2;
  const arc = (index: number) => {
    const start = (index / 4) * 2 * Math.PI - Math.PI / 2 + 0.12, end = ((index + 1) / 4) * 2 * Math.PI - Math.PI / 2 - 0.12;
    return `M ${c + r * Math.cos(start)} ${c + r * Math.sin(start)} A ${r} ${r} 0 0 1 ${c + r * Math.cos(end)} ${c + r * Math.sin(end)}`;
  };
  const svg = <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    {[0, 1, 2, 3].map((index) => <path key={index} d={arc(index)} className="ui-ring-seg" data-on={index < q || undefined} />)}
  </svg>;
  const text = `${label}：${q === 4 ? "已达成" : `${q}/4`}`;
  return onConfirm && q < 4
    ? <button type="button" className="ui-ring" data-level={q} title={`${text} · 点击确认已达成`} aria-label={`${text}，点击确认已达成`} onClick={onConfirm}>{svg}</button>
    : <span className="ui-ring" data-level={q} title={text} role="img" aria-label={text}>{svg}</span>;
}

/** A small menu anchored to a button, built on the platform popover (light dismiss and Esc for free). */
export function MenuButton({ label, icon, items }: { label: string; icon: ReactNode; items: ReadonlyArray<{ label: string; hint?: string; onSelect: () => void }> }) {
  const id = useId().replace(/:/g, "");
  return <>
    <button type="button" className="ui-menu-trigger" aria-label={label} title={label} popoverTarget={`menu-${id}`}>{icon}</button>
    <div id={`menu-${id}`} popover="auto" className="ui-menu" role="menu">
      {items.map((item) => <button key={item.label} type="button" role="menuitem" onClick={(event) => {
        (event.currentTarget.parentElement as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
        item.onSelect();
      }}>{item.label}{item.hint && <small>{item.hint}</small>}</button>)}
    </div>
  </>;
}
