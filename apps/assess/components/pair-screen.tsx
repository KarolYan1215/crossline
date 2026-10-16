"use client";

import { useEffect, useState } from "react";
import { api, type ClientErrorCode } from "../lib/api-client";
import type { PairView, RelationView } from "../lib/contract";
import { LAST_RESULT_KEY, errorMessage } from "../lib/flow";
import { FigureTile } from "./figure";
import { useLocale, useT } from "./locale-context";
import { SavableImage } from "./poster";
import { AVATAR_POLL_MS, DISCLAIMER, isDrawing } from "./result-screen";
import { readStored } from "./storage";
import { TypeHeading, groupStyle } from "./type-summary";

function Relation({ relation, second }: { relation: RelationView; second?: boolean }) {
  const t = useT();
  return <section className="as-block">
    {second ? <h2>{t("也是：{{name}}", { name: relation.name })}</h2> : null}
    <p>{relation.when}</p>
    <ol className="as-tips">{relation.tips.map((tip) => <li key={tip}>{tip}</li>)}</ol>
  </section>;
}

/** Two people's card: the image to save, the relation and its two tips as text, both types, and a way to invite someone else. */
export function PairScreen({ token }: { token: string }) {
  const locale = useLocale();
  const t = useT();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; code: ClientErrorCode } | { kind: "ready"; pair: PairView }>({ kind: "loading" });
  const [ownResult, setOwnResult] = useState<string | null>(null);
  useEffect(() => {
    setOwnResult(readStored("local", LAST_RESULT_KEY));
    let live = true;
    void api.getPair(token).then((result) => { if (live) setState(result.ok ? { kind: "ready", pair: result.data } : { kind: "error", code: result.code }); });
    return () => { live = false; };
  }, [token]);

  // Someone who answered an invitation lands here seconds after submitting, while their own figure is still being drawn: keep asking
  // until both figures are settled, and the card's address (which carries both figures' tags) changes with them.
  const drawing = state.kind === "ready" && (isDrawing(state.pair.a.avatar) || isDrawing(state.pair.b.avatar));
  useEffect(() => {
    if (!drawing) return;
    let live = true;
    const timer = setInterval(() => {
      void api.getPair(token).then((result) => { if (live && result.ok) setState({ kind: "ready", pair: result.data }); });
    }, AVATAR_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [drawing, token]);

  if (state.kind === "loading") return <main className="as-main"><p className="as-note" role="status">{t("正在读取双人卡…")}</p></main>;
  if (state.kind === "error") return <main className="as-main"><section className="as-sheet">
    <h1>{state.code === "NOT_FOUND" ? t("没有找到这张双人卡") : t("暂时打不开")}</h1>
    <p>{state.code === "NOT_FOUND" ? t("可能已过期，或者其中一人删除了结果。") : errorMessage(state.code, locale)}</p>
    <a className="as-button" href="/">{t("去测一测")}</a>
  </section></main>;

  const { pair } = state;
  const people = [pair.a, pair.b];
  const names = people.map((person) => person.nickname || t("你的朋友"));
  return <main className="as-main as-result">
    <header className="as-pair-head">
      <p className="as-kicker">{names[0]} × {names[1]}</p>
      <h1>{pair.primary.name}</h1>
    </header>
    {drawing && <p className="as-note" role="status">{t("形象正在画，画好后双人卡会自动换上，不用刷新。")}</p>}
    <SavableImage src={pair.cardUrl} alt={t("{{a}}和{{b}}的双人卡：{{relation}}", { a: names[0], b: names[1], relation: pair.primary.name })} width={1080} height={1440}
      downloadName={t("crossline-双人卡.png")} label={t("双人卡")} />
    <Relation relation={pair.primary} />
    {pair.secondary && <Relation relation={pair.secondary} second />}
    <section className="as-block">
      <h2>{t("你们俩")}</h2>
      <div className="as-people">{people.map((person, index) => <div key={index} className="as-person" style={groupStyle(person.type)}>
        <FigureTile avatar={person.avatar} type={person.type} alt={t("{{name}}的形象", { name: names[index] })} width={120} height={180} />
        <p className="as-person-name">{names[index]}</p>
        <TypeHeading type={person.type} as="h3" />
      </div>)}</div>
      <p>{pair.sharedLines.length ? t("你们都适合的主线：{{lines}}", { lines: pair.sharedLines.join(locale === "en" ? ", " : "、") }) : t("你们适合的主线没有重合，正好各管一摊。")}</p>
    </section>
    <section className="as-block">
      {ownResult ? <>
        <a className="as-button as-primary" href={`/r/${ownResult}`}>{t("看我自己的海报，再拉别人测")}</a>
        <p className="as-note">{t("你的类型海报、邀请链接和所有双人卡都在那一页。")}</p>
      </> : <a className="as-button as-primary" href="/">{t("我也测一测")}</a>}
    </section>
    <p className="as-disclaimer">{t(DISCLAIMER)}</p>
  </main>;
}
