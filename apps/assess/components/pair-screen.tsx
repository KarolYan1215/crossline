"use client";

import { useEffect, useState } from "react";
import { api, type ClientErrorCode } from "../lib/api-client";
import type { PairView, RelationView } from "../lib/contract";
import { LAST_RESULT_KEY, errorMessage } from "../lib/flow";
import { SavableImage, smallFigure } from "./poster";
import { DISCLAIMER } from "./result-screen";
import { readStored } from "./storage";
import { TypeHeading, groupStyle } from "./type-summary";

function Relation({ relation, second }: { relation: RelationView; second?: boolean }) {
  return <section className="as-block">
    {second ? <h2>也是：{relation.name}</h2> : null}
    <p>{relation.when}</p>
    <ol className="as-tips">{relation.tips.map((tip) => <li key={tip}>{tip}</li>)}</ol>
  </section>;
}

/** Two people's card: the image to save, the relation and its two tips as text, both types, and a way to invite someone else. */
export function PairScreen({ token }: { token: string }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; code: ClientErrorCode } | { kind: "ready"; pair: PairView }>({ kind: "loading" });
  const [ownResult, setOwnResult] = useState<string | null>(null);
  useEffect(() => {
    setOwnResult(readStored("local", LAST_RESULT_KEY));
    let live = true;
    void api.getPair(token).then((result) => { if (live) setState(result.ok ? { kind: "ready", pair: result.data } : { kind: "error", code: result.code }); });
    return () => { live = false; };
  }, [token]);

  if (state.kind === "loading") return <main className="as-main"><p className="as-note" role="status">正在读取双人卡…</p></main>;
  if (state.kind === "error") return <main className="as-main"><section className="as-sheet">
    <h1>{state.code === "NOT_FOUND" ? "没有找到这张双人卡" : "暂时打不开"}</h1>
    <p>{state.code === "NOT_FOUND" ? "可能已过期，或者其中一人删除了结果。" : errorMessage(state.code)}</p>
    <a className="as-button" href="/">去测一测</a>
  </section></main>;

  const { pair } = state;
  const people = [pair.a, pair.b];
  const names = people.map((person) => person.nickname || "你的朋友");
  return <main className="as-main as-result">
    <header className="as-pair-head">
      <p className="as-kicker">{names[0]} × {names[1]}</p>
      <h1>{pair.primary.name}</h1>
    </header>
    <SavableImage src={pair.cardUrl} alt={`${names[0]}和${names[1]}的双人卡：${pair.primary.name}`} width={1080} height={1440}
      downloadName="crossline-双人卡.png" label="双人卡" />
    <Relation relation={pair.primary} />
    {pair.secondary && <Relation relation={pair.secondary} second />}
    <section className="as-block">
      <h2>你们俩</h2>
      <div className="as-people">{people.map((person, index) => <div key={index} className="as-person" style={groupStyle(person.type)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a figure, a plain image */}
        <img className="as-figure" src={smallFigure(person.avatar.url)} alt={`${names[index]}的形象`} width={120} height={180} />
        <p className="as-person-name">{names[index]}</p>
        <TypeHeading type={person.type} as="h3" />
      </div>)}</div>
      <p>{pair.sharedLines.length ? `你们都适合的主线：${pair.sharedLines.join("、")}` : "你们适合的主线没有重合，正好各管一摊。"}</p>
    </section>
    <section className="as-block">
      {ownResult ? <>
        <a className="as-button as-primary" href={`/r/${ownResult}`}>看我自己的海报，再拉别人测</a>
        <p className="as-note">你的类型海报、邀请链接和所有双人卡都在那一页。</p>
      </> : <a className="as-button as-primary" href="/">我也测一测</a>}
    </section>
    <p className="as-disclaimer">{DISCLAIMER}</p>
  </main>;
}
