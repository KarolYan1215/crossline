/**
 * Where everything sits on the 主线 timeline: one shared date axis across the page's width, a row per line, so lines can be compared at a
 * glance. A milestone is a marker at its deadline with a short label hung below it, in one of at most `TL.maxLanes` lanes; a label that
 * finds no room is cut short, then left out (the marker stays, named on hover and on focus). The ticks before a milestone (near-term
 * results) are dots on the same axis. Chains inside a line arc above the axis; relations between lines are curves from one marker to the
 * other. Milestones without a date sit in an 「未定日期」 zone at the right. The scale fits the whole span into the width it is given (a
 * phone gets `TL.minWidth` and scrolls inside its frame), and the axis says the year: on the first mark, and at every 1 January as a
 * separator line. A relation's kind is its dash pattern; its label is drawn only while it is hovered, and only where it covers nothing
 * (`placeEdgeLabels`). Pure arithmetic, tested without a browser.
 */
export type TimelineNodeInput = { id: string; line: string; title: string; status: "draft" | "approved"; kind: "milestone" | "course";
  day?: string | undefined; dependsOn: string[] };
export type TimelineTickInput = { id: string; milestoneId: string; line: string; day: string | null; state: "done" | "planned" | "postponed"; plannedDay: string | null };
/**
 * `broken`: the relation's upstream milestone is now due too late for the downstream one; it is drawn as a red broken line. `kind`
 * (enables, reuses, …) picks the curve's dash pattern, so the kind reads without a label on the curve.
 */
export type TimelineRelationInput = { id: string; from: string; to: string; pending: boolean; label?: string; kind?: string; broken?: boolean };

export const TL = {
  /** The row label column (line name, drafts waiting). */
  labelW: 92,
  /** Header: the year line above the month or week line. */
  headH: 34,
  /** Axis distance from a row's top: room for the chain arcs and the risk glyph above it. */
  axisTop: 22,
  laneH: 18, maxLanes: 2, rowPad: 6,
  /** The longest a label may be, and the shortest worth showing. */
  labelMax: 150, labelMin: 40,
  undatedW: 132,
  /** Below this the canvas keeps this width and its frame scrolls sideways, so a phone does not crush a year into 300px. */
  minWidth: 600,
  /** A row with more chain steps than this draws them faint, and only the hovered or focused milestone's at full strength. */
  chainMax: 6
} as const;

/** A cubic Bézier: start, first control, second control, end. */
export type Curve = [number, number, number, number, number, number, number, number];

export type AxisMark = { x: number; label: string; kind: "week" | "month" };
export type TimelineLayout = {
  width: number; height: number; start: string; pxPerDay: number; datedEnd: number;
  axis: AxisMark[];
  /** Years: the first one at the left edge (`boundary: false`), then each 1 January inside the span, drawn as a separator. */
  years: Array<{ x: number; label: string; boundary: boolean }>;
  todayX: number;
  rows: Array<{ line: string; y: number; height: number; axisY: number }>;
  /** `labelW` 0 = no room for a label; the marker stands alone. */
  nodes: Array<TimelineNodeInput & { x: number; axisY: number; labelX: number; labelY: number; labelW: number; undated: boolean }>;
  ticks: Array<TimelineTickInput & { x: number; axisY: number; plannedX: number | null }>;
  /**
   * `from`/`to` are node ids (hover highlights both ends); `line` is the source's line, which colours the edge and its arrowhead.
   * A relation carries its kind (`relationKind`, and `label` to name it), its curve (`curve`) and the curve's midpoint (`labelX`,
   * `labelY`); whether and where its label is drawn is `placeEdgeLabels`'s to decide. A chain step in a crowded row is `faint`.
   */
  edges: Array<{ id: string; kind: "chain" | "relation"; pending: boolean; path: string; line?: string; from: string; to: string;
    label?: string; labelX?: number; labelY?: number; broken?: boolean; relationKind?: string; curve?: Curve; faint?: boolean }>;
};

const DAY_MS = 86_400_000;
const toTime = (day: string) => Date.parse(`${day}T12:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** About how wide a label is drawn at 12px: a CJK character is 12px, anything else about 6.5px, plus the label's padding. */
export function labelWidth(text: string): number {
  let width = 10;
  for (const char of text) width += /[⺀-鿿豈-﫿＀-￯]/.test(char) ? 12 : 6.5;
  return Math.ceil(width);
}

export function layoutTimeline(input: { nodes: TimelineNodeInput[]; ticks: TimelineTickInput[]; relations: TimelineRelationInput[]; lineOrder: string[]; today: string;
  /** The width of the frame the canvas is drawn in. */
  width?: number }): TimelineLayout {
  const days = [input.today, ...input.nodes.flatMap((node) => node.day ? [node.day] : []), ...input.ticks.flatMap((tick) => [tick.day, tick.plannedDay].filter((day): day is string => Boolean(day)))];
  const start = toDay(Math.min(...days.map(toTime)) - 3 * DAY_MS);
  const end = toDay(Math.max(...days.map(toTime)) + 5 * DAY_MS);
  const span = Math.max(14, (toTime(end) - toTime(start)) / DAY_MS);
  const hasUndated = input.nodes.some((node) => !node.day);
  const width = Math.max(TL.minWidth, Math.round(input.width ?? 1100));
  // The last label hangs right of its marker; keep room for a short one.
  const room = width - TL.labelW - (hasUndated ? TL.undatedW : 0) - TL.labelMin - 8;
  const pxPerDay = Math.max(0.2, Math.min(40, room / span));
  const xOf = (day: string) => TL.labelW + ((toTime(day) - toTime(start)) / DAY_MS) * pxPerDay;
  const datedEnd = xOf(end);

  // Weeks while a week is wide enough for 「10/12」, months while a month fits 「12月」, else every quarter's first month.
  const step = pxPerDay * 7 >= 36 ? "week" : pxPerDay * 30 >= 30 ? "month" : "quarter";
  const axis: AxisMark[] = [];
  const years: TimelineLayout["years"] = [{ x: TL.labelW + 2, label: start.slice(0, 4), boundary: false }];
  for (let time = toTime(start); time <= toTime(end); time += DAY_MS) {
    const date = new Date(time);
    const monthStart = date.getUTCDate() === 1, month = date.getUTCMonth();
    const x = xOf(toDay(time));
    if (monthStart && month === 0 && time > toTime(start)) years.push({ x, label: String(date.getUTCFullYear()), boundary: true });
    if (monthStart && (step !== "quarter" || month % 3 === 0)) axis.push({ x, label: `${month + 1}月`, kind: "month" });
    else if (step === "week" && date.getUTCDay() === 1) axis.push({ x, label: `${month + 1}/${date.getUTCDate()}`, kind: "week" });
  }
  // A Monday within three days of a month's first day would print on top of it; the month label wins.
  for (let index = axis.length - 1; index >= 0; index -= 1) {
    const mark = axis[index]!;
    if (mark.kind === "week" && axis.some((other) => other.kind === "month" && Math.abs(other.x - mark.x) < 3 * pxPerDay)) axis.splice(index, 1);
  }
  // The starting year's label gives way to a 1 January close to it.
  if (years.length > 1 && years[1]!.x - years[0]!.x < 44) years.shift();

  const lines = [...new Set([...input.lineOrder.filter((line) => input.nodes.some((node) => node.line === line)), ...input.nodes.map((node) => node.line)])];
  const rows: TimelineLayout["rows"] = [];
  const nodes: TimelineLayout["nodes"] = [];
  let y = TL.headH;
  for (const line of lines) {
    const own = input.nodes.filter((node) => node.line === line);
    const dated = own.filter((node) => node.day).sort((a, b) => a.day!.localeCompare(b.day!));
    const undated = own.filter((node) => !node.day);
    const zone = datedEnd + 12;
    const placed = [...dated.map((node) => ({ node, x: xOf(node.day!), undated: false })),
      ...undated.map((node, index) => ({ node, x: zone + 10 + index * 18, undated: true }))];
    // Each label starts just left of its marker and wants its full width; it takes the first lane that is clear, else the lane where cutting
    // the label before it leaves both at least `labelMin`; else it is left out.
    const lanes: Array<Array<{ index: number; start: number; want: number }>> = Array.from({ length: TL.maxLanes }, () => []);
    const assigned = placed.map(({ node, x }, index) => {
      const startX = x - 6;
      const want = Math.min(TL.labelMax, labelWidth(node.title));
      const clear = lanes.findIndex((lane) => { const last = lane.at(-1); return !last || last.start + last.want + 4 <= startX; });
      const squeeze = clear >= 0 ? clear : lanes.findIndex((lane) => { const last = lane.at(-1)!; return startX - last.start - 4 >= TL.labelMin; });
      if (squeeze < 0) return { lane: -1, start: startX, want };
      lanes[squeeze]!.push({ index, start: startX, want });
      return { lane: squeeze, start: startX, want };
    });
    const rowRight = (undatedNode: boolean) => undatedNode ? width - 4 : zone - 4;
    const widths = assigned.map((item, index) => {
      if (item.lane < 0) return 0;
      const lane = lanes[item.lane]!;
      const next = lane[lane.findIndex((entry) => entry.index === index) + 1];
      const limit = Math.min(next ? next.start - 4 : Infinity, rowRight(placed[index]!.undated)) - item.start;
      const labelW = Math.min(item.want, limit);
      return labelW >= TL.labelMin || labelW >= item.want ? Math.floor(labelW) : 0;
    });
    const used = Math.max(1, ...assigned.map((item, index) => widths[index] ? item.lane + 1 : 0));
    const axisY = y + TL.axisTop;
    const height = TL.axisTop + 8 + used * TL.laneH + TL.rowPad;
    placed.forEach(({ node, x, undated: isUndated }, index) => nodes.push({ ...node, x, axisY, undated: isUndated,
      labelX: assigned[index]!.start, labelY: axisY + 8 + Math.max(0, assigned[index]!.lane) * TL.laneH, labelW: widths[index]! }));
    rows.push({ line, y, height, axisY });
    y += height;
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rowOf = new Map(rows.map((row) => [row.line, row]));
  const ticks = input.ticks.flatMap((tick) => {
    const row = rowOf.get(tick.line);
    const milestone = byId.get(tick.milestoneId);
    if (!row || !milestone) return [];
    const x = tick.day ? xOf(tick.day) : milestone.x - 12;
    return [{ ...tick, x, axisY: row.axisY, plannedX: tick.plannedDay && tick.state === "postponed" ? xOf(tick.plannedDay) : null }];
  });
  // Ticks on one day of one row sat on the same spot, and the one underneath could not be clicked (2026-10-18 walkthrough): each is
  // nudged right of the one before it on its row, by one dot's width.
  const lastX = new Map<number, number>();
  for (const tick of [...ticks].sort((a, b) => a.axisY - b.axisY || a.x - b.x)) {
    const before = lastX.get(tick.axisY);
    if (before !== undefined && tick.x < before + TICK_GAP) tick.x = before + TICK_GAP;
    lastX.set(tick.axisY, tick.x);
  }

  const edges: TimelineLayout["edges"] = [];
  // A step of a chain is an arc over the axis from the earlier marker to the later one, ending in an arrow just short of the marker. A
  // dependency that another path in the same line already implies (A→C beside A→B→C) is not drawn, and an arc that passes over more
  // markers rises higher, so arcs of different lengths do not run along one height.
  const sameLineParents = (node: TimelineLayout["nodes"][number]) => node.dependsOn.filter((id) => byId.get(id)?.line === node.line);
  const reaches = (from: string, target: string, skip: string, seen = new Set<string>()): boolean => {
    const node = byId.get(from);
    if (!node || seen.has(from)) return false;
    seen.add(from);
    return sameLineParents(node).some((parent) => parent !== skip && (parent === target || reaches(parent, target, "", seen)));
  };
  for (const node of nodes) {
    for (const parent of sameLineParents(node)) {
      const from = byId.get(parent)!;
      if (reaches(node.id, parent, parent)) continue;
      const [a, b] = from.x <= node.x ? [from, node] : [node, from];
      const forward = a === from;
      const between = nodes.filter((other) => other.line === node.line && other.x > a.x + 1 && other.x < b.x - 1).length;
      // The arc peaks at y0 - lift, inside the row (the axis sits `TL.axisTop` below its top).
      const lift = Math.min(TL.axisTop - 10, 5 + between * 3);
      const startX = forward ? a.x + 6 : b.x - 6, endX = forward ? b.x - 9 : a.x + 9;
      const y0 = node.axisY - 6;
      edges.push({ id: `chain:${parent}>${node.id}`, kind: "chain", pending: from.status === "draft" || node.status === "draft", line: node.line,
        from: parent, to: node.id, path: `M${startX},${y0} Q${(startX + endX) / 2},${y0 - lift * 2} ${endX},${y0}` });
    }
  }
  // A row with many chain steps is a tangle of arcs; there they are drawn faint until one of their milestones is hovered or focused.
  for (const row of rows) {
    const own = edges.filter((edge) => edge.kind === "chain" && edge.line === row.line);
    if (own.length > TL.chainMax) for (const edge of own) edge.faint = true;
  }
  // A relation between lines leaves its source marker and enters the target's, bowing sideways when both sit on one date.
  const lineOf = new Map(nodes.map((node) => [node.id, node.line]));
  for (const relation of input.relations) {
    const from = byId.get(relation.from), to = byId.get(relation.to);
    if (!from || !to) continue;
    const down = to.axisY >= from.axisY ? 1 : -1;
    const y0 = from.axisY + 8 * down, y1 = to.axisY - 9 * down;
    const bow = Math.abs(to.x - from.x) < 40 ? 60 : 0;
    const c1x = from.x + bow, c2x = to.x + bow, midY = (y0 + y1) / 2;
    const labelX = 0.125 * from.x + 0.375 * c1x + 0.375 * c2x + 0.125 * to.x;
    edges.push({ id: `relation:${relation.id}`, kind: "relation", pending: relation.pending, line: lineOf.get(relation.from)!,
      from: relation.from, to: relation.to, ...(relation.label ? { label: relation.label } : {}), labelX, labelY: midY, ...(relation.broken ? { broken: true } : {}),
      ...(relation.kind ? { relationKind: relation.kind } : {}), curve: [from.x, y0, c1x, midY, c2x, midY, to.x, y1],
      path: `M${from.x},${y0} C${c1x},${midY} ${c2x},${midY} ${to.x},${y1}` });
  }
  return { width, height: y + 6, start, pxPerDay, datedEnd, axis, years, todayX: xOf(input.today), rows, nodes, ticks, edges };
}

/**
 * What may not be drawn over, and where a label may go instead. Each box is what the timeline actually draws: a marker's 22px square, a
 * milestone label's strip, a tick's dot, a risk glyph above and right of its marker.
 */
export type Box = { x: number; y: number; w: number; h: number };
type LaidNode = TimelineLayout["nodes"][number];
export const markerBox = (node: LaidNode): Box => ({ x: node.x - 11, y: node.axisY - 11, w: 22, h: 22 });
export const nodeLabelBox = (node: LaidNode): Box | null => node.labelW > 0 ? { x: node.labelX, y: node.labelY, w: node.labelW, h: 17 } : null;
/** The least distance between two ticks on one row: a dot (12px) and a hair. */
const TICK_GAP = 13;
export const tickBox = (tick: TimelineLayout["ticks"][number]): Box => ({ x: tick.x - 6, y: tick.axisY - 6, w: 12, h: 12 });
export const riskBox = (node: LaidNode): Box => ({ x: node.x + 7, y: node.axisY - 21, w: 14, h: 14 });
/** A relation's label: its kind as plain text, or as a chip (1px border, 6px padding) when the relation hands over an artifact. */
export const edgeLabelSize = (label: string, chip: boolean): { w: number; h: number } => chip ? { w: labelWidth(label) + 4, h: 24 } : { w: labelWidth(label), h: 16 };

export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * Which milestones' risk glyphs fit. A glyph sits just right of its marker; where another marker, a tick or a glyph already drawn is
 * closer than that, it is left out — the risk stays in the marker's name and in the drawer. Row by row, left to right.
 */
export function riskGlyphsShown(layout: TimelineLayout, withRisk: ReadonlySet<string>): Set<string> {
  const shown = new Set<string>();
  const drawn: Box[] = [];
  const candidates = layout.nodes.filter((node) => withRisk.has(node.id)).sort((a, b) => a.axisY - b.axisY || a.x - b.x);
  for (const node of candidates) {
    const box = riskBox(node);
    if (layout.nodes.some((other) => other.id !== node.id && boxesOverlap(box, markerBox(other), 1))
      || layout.ticks.some((tick) => boxesOverlap(box, tickBox(tick), 1)) || drawn.some((other) => boxesOverlap(box, other, 1))) continue;
    shown.add(node.id);
    drawn.push(box);
  }
  return shown;
}

/** Everything a relation's label must stay clear of: markers, shown milestone labels, ticks and the risk glyphs drawn (`risks`). */
export function labelObstacles(layout: TimelineLayout, risks: ReadonlySet<string>): Box[] {
  return [...layout.nodes.map(markerBox), ...layout.nodes.flatMap((node) => nodeLabelBox(node) ?? []), ...layout.ticks.map(tickBox),
    ...layout.nodes.filter((node) => risks.has(node.id)).map(riskBox)];
}

const bezier = (curve: Curve, t: number): [number, number] => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = curve;
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3];
};
/** Where along its curve a label is tried: the middle first, then outwards. */
const ALONG = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];

/**
 * Where each requested relation label goes: the first spot along its own curve (each point on the curve, then just above and just below
 * it, then a little further off) that stays inside the canvas below the header and 2px clear of every obstacle and of the labels placed
 * before it. A label with no such spot is `null` and is not drawn; its curve names it on hover instead. Requests are placed in order.
 */
export function placeEdgeLabels(layout: TimelineLayout, requests: Array<{ id: string; w: number; h: number }>, obstacles: Box[]): Map<string, Box | null> {
  const placed = new Map<string, Box | null>();
  const taken: Box[] = [];
  const curves = new Map(layout.edges.flatMap((edge) => edge.curve ? [[edge.id, edge.curve] as const] : []));
  for (const request of requests) {
    const curve = curves.get(request.id);
    let found: Box | null = null;
    for (const t of curve ? ALONG : []) {
      const [px, py] = bezier(curve!, t);
      for (const dy of [0, -(request.h / 2 + 5), request.h / 2 + 5, -(request.h + 8), request.h + 8]) {
        const box = { x: px - request.w / 2, y: py + dy - request.h / 2, w: request.w, h: request.h };
        if (box.x < TL.labelW || box.x + box.w > layout.width || box.y < TL.headH || box.y + box.h > layout.height) continue;
        if (obstacles.some((other) => boxesOverlap(box, other, 2)) || taken.some((other) => boxesOverlap(box, other, 2))) continue;
        found = box;
        break;
      }
      if (found) break;
    }
    placed.set(request.id, found);
    if (found) taken.push(found);
  }
  return placed;
}

/**
 * Where a tick can be clicked. A dot is 12px and dense rows put one every 13px, so the dot alone was hard to hit, and a postponed tick's
 * dashed ghost (its original day) could not be clicked at all. Every dot and every ghost gets an area along its row: up to
 * `TICK_HIT.reach` either side, split halfway with its neighbours so no two areas overlap, stopped at a milestone marker's edge, and from
 * `TICK_HIT.up` above the axis to `TICK_HIT.down` below it, clear of the labels hung below the axis. Points on one spot (a ghost under
 * another tick's dot) share one area naming all their ticks. `over`: the point sits under a marker, so its area is the dot alone, drawn
 * above the marker. `ghostOnly`: an area holding only ghosts, which the keyboard skips (the tick's own dot has an area of its own).
 */
export const TICK_HIT = { reach: 12, up: 10, down: 7 } as const;
export type TickTarget = { key: string; line: string; ticks: string[]; points: Array<{ id: string; x: number; ghost: boolean }>;
  x: number; y: number; w: number; h: number; over: boolean; ghostOnly: boolean };

export function tickTargets(layout: TimelineLayout): TickTarget[] {
  const targets: TickTarget[] = [];
  for (const row of layout.rows) {
    const points = layout.ticks.filter((tick) => tick.line === row.line).flatMap((tick) => [{ id: tick.id, x: tick.x, ghost: false },
      ...(tick.plannedX !== null ? [{ id: tick.id, x: tick.plannedX, ghost: true }] : [])]).sort((a, b) => a.x - b.x || Number(a.ghost) - Number(b.ghost));
    const groups: Array<typeof points> = [];
    for (const point of points) {
      const last = groups.at(-1);
      if (last && point.x - last[0]!.x < 2) last.push(point); else groups.push([point]);
    }
    const markers = layout.nodes.filter((node) => node.line === row.line).map((node) => node.x);
    groups.forEach((group, index) => {
      const x = group[0]!.x;
      const prev = groups[index - 1]?.[0]!.x, next = groups[index + 1]?.[0]!.x;
      let left = Math.max(x - TICK_HIT.reach, prev === undefined ? -Infinity : (prev + x) / 2, TL.labelW);
      let right = Math.min(x + TICK_HIT.reach, next === undefined ? Infinity : (x + next) / 2);
      let over = false;
      for (const marker of markers) {
        if (marker + 11 <= left || marker - 11 >= right) continue;
        if (x <= marker - 11) right = Math.min(right, marker - 11);
        else if (x >= marker + 11) left = Math.max(left, marker + 11);
        else { left = x - 6; right = x + 6; over = true; break; }
      }
      targets.push({ key: `${row.line}:${index}:${group.map((point) => `${point.id}${point.ghost ? "~" : ""}`).join("|")}`, line: row.line,
        ticks: [...new Set(group.map((point) => point.id))], points: group, x: left, y: row.axisY - TICK_HIT.up, w: Math.max(1, right - left),
        h: TICK_HIT.up + TICK_HIT.down, over, ghostOnly: group.every((point) => point.ghost) });
    });
  }
  return targets;
}

/**
 * Where the full names of the milestones in focus go while one is hovered, focused or has a tick picked: a label cut short (「ECE …」) or
 * left out reads in full there, drawn over the timeline. `ids` in order of importance (the one in focus first, which keeps its own label's
 * spot whenever it has one). Each other tries its own label's
 * spot, then the label lanes below its marker, then just above the axis, each started at the marker or ended at it: first where it covers
 * no other label or marker, else where it covers only what is not in focus; never another focused marker, a full name already placed or
 * anything in `keep` (what is under the pointer). One with nowhere to go is left out; the strip above the timeline names it anyway.
 */
export function focusLabels(layout: TimelineLayout, ids: string[], keep: Box[] = []): Map<string, Box> {
  const placed = new Map<string, Box>();
  const taken: Box[] = [...keep];
  const nodes = ids.flatMap((id) => layout.nodes.find((node) => node.id === id) ?? []);
  const inFocus = new Set(nodes.map((node) => node.id));
  const rest = layout.nodes.filter((node) => !inFocus.has(node.id)).flatMap((node) => [markerBox(node), ...(nodeLabelBox(node) ? [nodeLabelBox(node)!] : [])]);
  for (const [index, node] of nodes.entries()) {
    const w = Math.max(TL.labelMin, Math.min(labelWidth(node.title), layout.width - TL.labelW - 8));
    const fit = (x: number) => Math.max(TL.labelW, Math.min(x, layout.width - 4 - w));
    const own = nodeLabelBox(node);
    const ys = [...Array.from({ length: TL.maxLanes }, (_, lane) => node.axisY + 8 + lane * TL.laneH), node.axisY - 30];
    const spots: Box[] = [...(own ? [{ x: fit(own.x), y: own.y, w, h: 17 }] : []),
      ...ys.flatMap((y) => [{ x: fit(node.x - 6), y, w, h: 17 }, { x: fit(node.x + 6 - w), y, w, h: 17 }])];
    const blocked = (box: Box) => box.y < TL.headH || box.y + box.h > layout.height || taken.some((other) => boxesOverlap(box, other, 1))
      || nodes.some((other) => other.id !== node.id && boxesOverlap(box, markerBox(other)));
    // The first one keeps its own spot whatever it covers: the pointer may be on its label, and a name that jumped away from under the
    // pointer would end the hover that drew it.
    const found = (index === 0 && own && !blocked(spots[0]!) ? spots[0] : undefined)
      ?? spots.find((box) => !blocked(box) && !rest.some((other) => boxesOverlap(box, other))) ?? spots.find((box) => !blocked(box));
    if (!found) continue;
    placed.set(node.id, found);
    taken.push(found);
  }
  return placed;
}

/** What a milestone is joined to on the timeline: the steps of its chain before and after it, and its relations to other lines with their kind. */
export function connectionsOf(layout: TimelineLayout, id: string): { before: string[]; after: string[];
  relations: Array<{ other: string; direction: "out" | "in"; label?: string; pending: boolean }> } {
  const edges = layout.edges.filter((edge) => edge.from === id || edge.to === id);
  return {
    before: edges.filter((edge) => edge.kind === "chain" && edge.to === id).map((edge) => edge.from),
    after: edges.filter((edge) => edge.kind === "chain" && edge.from === id).map((edge) => edge.to),
    relations: edges.filter((edge) => edge.kind === "relation").map((edge) => ({ other: edge.from === id ? edge.to : edge.from,
      direction: edge.from === id ? "out" as const : "in" as const, ...(edge.label ? { label: edge.label } : {}), pending: edge.pending }))
  };
}

const monthDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
/**
 * A tick in words: its state and day and, for one postponed, the day it was due, the day it is on now and why it moved: the planned day
 * passed without the step done, and the scheduler either placed it again (`scheduledDay`) or has not yet (it is drawn on today).
 */
export function tickStory(tick: { state: "done" | "planned" | "postponed"; day: string | null; plannedDay: string | null; scheduledDay: string | null }):
  { status: string; when: string; why?: string } {
  if (tick.state === "done") return { status: "已达成", when: tick.day ? `完成于 ${monthDay(tick.day)}` : "已完成" };
  if (tick.state === "planned") return { status: "计划中", when: tick.day ? `排在 ${monthDay(tick.day)}` : "还没有排上日程" };
  const was = tick.plannedDay ? monthDay(tick.plannedDay) : "原定日";
  return tick.scheduledDay
    ? { status: "已顺延", when: `原定 ${was} → 现排 ${monthDay(tick.scheduledDay)}`, why: `原定 ${was} 已过，这一步还没完成，排程把它挪到了 ${monthDay(tick.scheduledDay)} 的时间块。` }
    : { status: "已顺延", when: `原定 ${was} → 尚未重排`, why: `原定 ${was} 已过，这一步还没完成，排程还没给它新的时间，暂画在今天。` };
}
