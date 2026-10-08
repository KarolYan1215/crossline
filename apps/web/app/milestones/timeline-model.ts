/**
 * Where everything sits on the 主线 timeline. The horizontal axis is dates; each line is a row with its own axis; a milestone is a
 * marker at its deadline, with its label hung below in the first lane where it does not overlap the previous one; the ticks before it
 * (near-term results) are dots on the same axis. Chains inside a line run along the axis; relations between lines are curves from one
 * marker to the other. Milestones without a date sit after the last date, in an 「未定日期」 zone. Pure arithmetic, tested without a browser.
 */
export type TimelineNodeInput = { id: string; line: string; title: string; status: "draft" | "approved"; kind: "milestone" | "course";
  day?: string | undefined; dependsOn: string[] };
export type TimelineTickInput = { id: string; milestoneId: string; line: string; day: string | null; state: "done" | "planned" | "postponed"; plannedDay: string | null };
export type TimelineRelationInput = { id: string; from: string; to: string; pending: boolean; label?: string };

export const TL = { labelW: 96, nodeW: 176, laneH: 56, axisTop: 26, rowPad: 12, headH: 30, undatedGap: 48 } as const;

export type TimelineLayout = {
  width: number; height: number; start: string; pxPerDay: number; datedEnd: number;
  axis: Array<{ x: number; label: string; month: boolean }>; todayX: number;
  rows: Array<{ line: string; y: number; height: number; axisY: number }>;
  nodes: Array<TimelineNodeInput & { x: number; axisY: number; labelY: number; undated: boolean }>;
  ticks: Array<TimelineTickInput & { x: number; axisY: number; plannedX: number | null }>;
  /**
   * `from`/`to` are node ids (hover highlights both ends); `line` is the source's line, which colours the edge and its arrowhead;
   * relations carry their kind as `label` at (`labelX`, `labelY`), the curve's midpoint.
   */
  edges: Array<{ id: string; kind: "chain" | "relation"; pending: boolean; path: string; line?: string; from: string; to: string;
    label?: string; labelX?: number; labelY?: number }>;
};

const DAY_MS = 86_400_000;
const toTime = (day: string) => Date.parse(`${day}T12:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export function layoutTimeline(input: { nodes: TimelineNodeInput[]; ticks: TimelineTickInput[]; relations: TimelineRelationInput[]; lineOrder: string[]; today: string;
  maxWidth?: number }): TimelineLayout {
  const days = [input.today, ...input.nodes.flatMap((node) => node.day ? [node.day] : []), ...input.ticks.flatMap((tick) => [tick.day, tick.plannedDay].filter((day): day is string => Boolean(day)))];
  const start = toDay(Math.min(...days.map(toTime)) - 3 * DAY_MS);
  const end = toDay(Math.max(...days.map(toTime)) + 5 * DAY_MS);
  const span = Math.max(14, (toTime(end) - toTime(start)) / DAY_MS);
  const pxPerDay = Math.max(14, Math.min(48, (input.maxWidth ?? 1400) / span));
  const xOf = (day: string) => TL.labelW + ((toTime(day) - toTime(start)) / DAY_MS) * pxPerDay;
  const datedEnd = xOf(end);

  const axis: TimelineLayout["axis"] = [];
  for (let time = toTime(start); time <= toTime(end); time += DAY_MS) {
    const date = new Date(time);
    const monthStart = date.getUTCDate() === 1;
    if (date.getUTCDay() === 1 || monthStart) axis.push({ x: xOf(toDay(time)), label: monthStart ? `${date.getUTCMonth() + 1}月` : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`, month: monthStart });
  }
  // A Monday within three days of a month's first day would print on top of it; the month label wins.
  for (let index = axis.length - 1; index >= 0; index -= 1) {
    const mark = axis[index]!;
    if (!mark.month && axis.some((other) => other.month && Math.abs(other.x - mark.x) < 3 * pxPerDay)) axis.splice(index, 1);
  }

  const lines = [...new Set([...input.lineOrder.filter((line) => input.nodes.some((node) => node.line === line)), ...input.nodes.map((node) => node.line)])];
  const rows: TimelineLayout["rows"] = [];
  const nodes: TimelineLayout["nodes"] = [];
  let y = TL.headH;
  let undatedMax = 0;
  for (const line of lines) {
    const own = input.nodes.filter((node) => node.line === line);
    const dated = own.filter((node) => node.day).sort((a, b) => a.day!.localeCompare(b.day!));
    const undated = own.filter((node) => !node.day);
    const placed = [...dated.map((node) => ({ node, x: xOf(node.day!), undated: false })),
      ...undated.map((node, index) => ({ node, x: datedEnd + TL.undatedGap + index * (TL.nodeW + 16), undated: true }))];
    undatedMax = Math.max(undatedMax, undated.length);
    // Labels hang below the axis, each in the first lane where it clears the label before it.
    const laneEnds: number[] = [];
    const lanes = placed.map(({ x }) => {
      let lane = laneEnds.findIndex((endX) => x >= endX + 8);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = x + TL.nodeW;
      return lane;
    });
    const axisY = y + TL.axisTop;
    const height = TL.axisTop + Math.max(1, laneEnds.length) * TL.laneH + TL.rowPad;
    placed.forEach(({ node, x, undated: isUndated }, index) => nodes.push({ ...node, x, axisY, labelY: axisY + 12 + lanes[index]! * TL.laneH, undated: isUndated }));
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

  const edges: TimelineLayout["edges"] = [];
  // A step of a chain is an arc over the axis from the earlier marker to the later one, ending in an arrow just short of the marker,
  // so the order reads at a glance instead of disappearing into the axis line. A dependency that another path in the same line already
  // implies (A→C beside A→B→C) is not drawn — it only stacked arcs on top of each other — and an arc that passes over more markers
  // rises higher, so arcs of different lengths do not run along one height.
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
      // The arc peaks at y0 - lift, which stays inside the row (the axis sits `TL.axisTop` below its top).
      const lift = Math.min(TL.axisTop - 8, 7 + between * 4);
      const startX = forward ? a.x + 6 : b.x - 6, endX = forward ? b.x - 9 : a.x + 9;
      const y0 = node.axisY - 6;
      edges.push({ id: `chain:${parent}>${node.id}`, kind: "chain", pending: from.status === "draft" || node.status === "draft", line: node.line,
        from: parent, to: node.id, path: `M${startX},${y0} Q${(startX + endX) / 2},${y0 - lift * 2} ${endX},${y0}` });
    }
  }
  // A relation between lines leaves its source marker and enters the target's, bowing sideways when both sit on one date; its kind is
  // written at the curve's midpoint.
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
      from: relation.from, to: relation.to, ...(relation.label ? { label: relation.label } : {}), labelX, labelY: midY,
      path: `M${from.x},${y0} C${c1x},${midY} ${c2x},${midY} ${to.x},${y1}` });
  }
  const width = Math.max(datedEnd, undatedMax ? datedEnd + TL.undatedGap + undatedMax * (TL.nodeW + 16) : 0) + 24;
  return { width, height: y + 8, start, pxPerDay, datedEnd, axis, todayX: xOf(input.today), rows, nodes, ticks, edges };
}
