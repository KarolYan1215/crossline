"use client";

import { useEffect, useState } from "react";
import { useT } from "../locale-context";
import type { DrillView } from "../../lib/drill";

type Row = { line: string; description: string };
const EMPTY: Row = { line: "", description: "" };
const fileHref = (text: string) => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
const percent = (found: number, total: number) => total ? Math.round((found / total) * 100) : 0;

/**
 * J7, the weekly bug-finding drill (docs/plans/execution-gates-1124.md §四 J7): this week's exercise to download and solve without AI,
 * the answer form (line + one sentence each, optionally the fixed design), the graded result and the detection-rate trend.
 */
export function DrillBlock({ initial }: { initial?: DrillView }) {
  const t = useT();
  const [view, setView] = useState<DrillView | undefined>(initial);
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY }]);
  const [fixedFile, setFixedFile] = useState<{ name: string; text: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = async () => {
    const response = await fetch("/api/drill", { cache: "no-store" }).catch(() => undefined);
    const body = response?.ok ? await response.json().catch(() => undefined) as { drill?: DrillView } | undefined : undefined;
    if (body?.drill) setView(body.drill);
  };
  useEffect(() => { if (!initial) void reload(); }, [initial]);

  if (!view) return null;
  const current = view.current;
  const trend = [...view.history].filter((item) => item.found !== null).reverse().slice(-8);

  const submit = async () => {
    if (!current) return;
    const answers = rows.filter((row) => row.line.trim() || row.description.trim()).map((row) => ({ line: Number(row.line), description: row.description.trim() }));
    if (!answers.length || answers.some((answer) => !Number.isInteger(answer.line) || answer.line < 1 || !answer.description)) {
      setError(t("每一行都要填行号和一句描述。"));
      return;
    }
    setBusy(true);
    setError("");
    const response = await fetch("/api/drill", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ week: current.week, answers, ...(fixedFile ? { fixedFile } : {}) }) }).catch(() => undefined);
    setBusy(false);
    if (!response?.ok) { setError(t("答案没有交上去，可以再试一次。")); return; }
    await reload();
  };

  return <section className="rd-card review-block" aria-labelledby="rv-drill">
    <header className="rd-card-head"><h2 id="rv-drill" className="ds-serif">{t("找错练习")}</h2></header>
    {!current
      ? <p className="review-empty">{t("本周的题还没出。出题前每道题都在仿真器里验证过，服务器上没有仿真器时不出题。")}</p>
      : <>
        <p className="review-note">{t("{{title}}（{{week}} 这一周）：共 {{count}} 处错误。在本机用 iverilog 做，不开 AI；交行号和一句描述，可以附上改好的 dut.sv。",
          { title: current.title, week: current.week, count: current.bugCount })}</p>
        <ul className="review-list">{current.files.map((file) => <li key={file.name}>
          <a href={fileHref(file.text)} download={file.name}>{t("下载 {{name}}", { name: file.name })}</a>
        </li>)}</ul>

        {current.graded
          ? <>
            <p className="review-note">{t("找到 {{found}}/{{total}}（{{rate}}%），误报 {{falsePositives}} 条。",
              { found: current.graded.found, total: current.graded.total, rate: percent(current.graded.found, current.graded.total), falsePositives: current.graded.falsePositives })}</p>
            <ul className="review-list">{current.graded.bugs.map((bug) => <li key={bug.line}>
              <b>{t("第 {{line}} 行 · {{verdict}}", { line: bug.line, verdict: bug.verdict === "found" ? t("找到") : t("没找到") })}</b>
              <span>{bug.description}</span>
              {bug.why && <small>{bug.why}</small>}
            </li>)}</ul>
          </>
          : current.answered
            ? <p className="review-note">{t("已交 {{count}} 条答案，正在判分。", { count: current.answered.answers.length })}</p>
            : <form onSubmit={(event) => { event.preventDefault(); void submit(); }} style={{ display: "grid", gap: 8 }}>
              {rows.map((row, index) => <div key={index} style={{ display: "grid", gridTemplateColumns: "5.5em minmax(0,1fr) auto", gap: 6 }}>
                <input type="number" min={1} inputMode="numeric" value={row.line} aria-label={t("行号")} placeholder={t("行号")}
                  onChange={(event) => setRows((list) => list.map((item, at) => at === index ? { ...item, line: event.target.value } : item))} />
                <input type="text" maxLength={400} value={row.description} aria-label={t("错在哪里")} placeholder={t("一句话：错在哪里")}
                  onChange={(event) => setRows((list) => list.map((item, at) => at === index ? { ...item, description: event.target.value } : item))} />
                <button type="button" className="plan-sync" disabled={rows.length === 1}
                  onClick={() => setRows((list) => list.filter((_, at) => at !== index))}>{t("删去")}</button>
              </div>)}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button type="button" className="plan-sync" disabled={rows.length >= 20} onClick={() => setRows((list) => [...list, { ...EMPTY }])}>{t("再加一条")}</button>
                <label className="review-note" style={{ margin: 0 }}>{t("改好的文件（可选）")}{" "}
                  <input type="file" accept=".sv,.v,.txt" onChange={async (event) => {
                    const file = event.target.files?.[0];
                    setFixedFile(file ? { name: file.name, text: await file.text() } : undefined);
                  }} />
                </label>
                <button type="submit" className="plan-sync" disabled={busy}>{busy ? t("提交中…") : t("交答案")}</button>
              </div>
              {error && <p className="review-note" role="alert">{error}</p>}
            </form>}
      </>}

    {trend.length > 0 && <>
      <p className="review-note">{t("检出率")}</p>
      <ul className="review-list" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(7em,1fr))" }}>{trend.map((item) => <li key={item.week}>
        <b>{`${percent(item.found ?? 0, item.total)}%`}</b>
        <small>{`${item.week.slice(5)} · ${item.found ?? 0}/${item.total}`}</small>
      </li>)}</ul>
    </>}
  </section>;
}
