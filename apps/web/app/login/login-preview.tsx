/**
 * The sign-in page's picture of what Crossline does (docs/onboarding-v3.md): four lines draw in one after another and their work lands
 * as blocks on one week. Example lines only — nobody is signed in yet. Static under `prefers-reduced-motion` (login.css).
 */
import { tFor, weekdayShort, type Locale } from "../../lib/i18n";

const LINES = [
  { id: "research", label: "研究者", y: 34 },
  { id: "startup", label: "创业者", y: 82 },
  { id: "media", label: "创作者", y: 130 },
  { id: "investment", label: "投资者", y: 178 }
] as const;
/** Monday first; the weekday numbers `weekdayShort` reads (1 … 6, then 0). */
const DAYS = [1, 2, 3, 4, 5, 6, 0];
/** [day, start row, rows, line]: a week a person with these four lines might have. */
const BLOCKS: Array<[number, number, number, (typeof LINES)[number]["id"]]> = [
  [0, 0, 3, "research"], [0, 4, 2, "startup"], [1, 1, 2, "media"], [1, 4, 3, "research"], [2, 0, 2, "startup"], [2, 3, 3, "research"],
  [3, 0, 3, "research"], [3, 4, 1, "investment"], [4, 1, 2, "startup"], [4, 4, 2, "media"], [5, 2, 2, "media"], [6, 1, 1, "investment"]
];
const GRID = { x: 210, y: 18, column: 38, row: 24 };

export function LoginPreview({ locale }: { locale?: Locale | undefined }) {
  const t = tFor(locale);
  // English role names are longer than 「研究者」: the flows start further right so they never cross the label.
  const from = locale === "en" ? 112 : 84;
  return <svg className="login-preview" viewBox="0 0 480 220" role="img" aria-labelledby="login-preview-title">
    <title id="login-preview-title">{t("研究者、创业者、创作者、投资者四条主线的工作排进同一周的日历")}</title>
    {/* 「一 二 三」 in Chinese (the weekday alone, without 周), "Mon Tue Wed" in English. */}
    {DAYS.map((day, index) => <text key={day} className="login-day" x={GRID.x + index * GRID.column + GRID.column / 2} y={12} textAnchor="middle">
      {locale === "en" ? weekdayShort(locale, day) : weekdayShort(locale, day).slice(1)}</text>)}
    <rect className="login-week" x={GRID.x} y={GRID.y} width={GRID.column * 7} height={GRID.row * 8} />
    {DAYS.slice(1).map((day, index) => <line key={day} className="login-rule" x1={GRID.x + (index + 1) * GRID.column} x2={GRID.x + (index + 1) * GRID.column}
      y1={GRID.y} y2={GRID.y + GRID.row * 8} />)}
    {LINES.map((line, index) => <g key={line.id} data-line={line.id} style={{ ["--i" as string]: index }}>
      <circle className="login-node" cx={14} cy={line.y} r={7} />
      <text className="login-label" x={28} y={line.y + 5}>{t(line.label)}</text>
      <path className="login-flow" pathLength={1} d={`M ${from} ${line.y} C 150 ${line.y} 150 ${GRID.y + 30 + index * 40} ${GRID.x} ${GRID.y + 30 + index * 40}`} />
    </g>)}
    {BLOCKS.map(([day, start, rows, line], index) => <rect key={index} className="login-block" data-line={line} style={{ ["--b" as string]: index }}
      x={GRID.x + day * GRID.column + 3} y={GRID.y + start * GRID.row + 3} width={GRID.column - 6} height={rows * GRID.row - 6} />)}
  </svg>;
}
