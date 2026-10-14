"use client";

import { useEffect, useRef, useState } from "react";
import { api, type ClientErrorCode } from "../lib/api-client";
import type { AvatarStatus, ResultView } from "../lib/contract";
import { LAST_RESULT_KEY, errorMessage } from "../lib/flow";
import { SavableImage, withVersion } from "./poster";
import { ShareInvite } from "./share-invite";
import { readStored, writeStored } from "./storage";
import { AxesList, TypeDetails, TypeHeading, groupStyle } from "./type-summary";

/** How often a figure still being drawn is checked on. */
export const AVATAR_POLL_MS = 5_000;
export const isDrawing = (avatar: AvatarStatus): boolean => avatar.state === "queued" || avatar.state === "drawing";
export const DISCLAIMER = "基于自评的趣味测评，非心理诊断";

const dateText = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`; };

type State = { kind: "loading" } | { kind: "error"; code: ClientErrorCode } | { kind: "ready"; view: ResultView } | { kind: "deleted" };

/** The person's own result (`?delete=1` opens on the deletion confirmation): poster, the type as text, the figure's progress, the invitation, pair cards, and deleting it all. */
export function ResultScreen({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [version, setVersion] = useState(0);
  const [wasDrawing, setWasDrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const scrollToDelete = useRef(false);
  const [deleting, setDeleting] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  useEffect(() => {
    let live = true;
    const askDelete = new URLSearchParams(window.location.search).get("delete") === "1";
    if (askDelete) { setConfirming(true); scrollToDelete.current = true; }
    void api.getResult(token).then((result) => {
      if (!live) return;
      if (!result.ok) { setState({ kind: "error", code: result.code }); return; }
      writeStored("local", LAST_RESULT_KEY, token);
      setWasDrawing(isDrawing(result.data.avatar));
      setState({ kind: "ready", view: result.data });
    });
    return () => { live = false; };
  }, [token]);

  useEffect(() => {
    if (state.kind !== "ready" || !scrollToDelete.current) return;
    scrollToDelete.current = false;
    document.getElementById("as-delete")?.scrollIntoView({ block: "center" });
  }, [state.kind]);

  const drawing = state.kind === "ready" && isDrawing(state.view.avatar);
  useEffect(() => {
    if (!drawing) return;
    const timer = setTimeout(async () => {
      const result = await api.getResult(token);
      if (!result.ok) return;
      if (!isDrawing(result.data.avatar)) setVersion(Date.now());
      setState({ kind: "ready", view: result.data });
    }, AVATAR_POLL_MS);
    return () => clearTimeout(timer);
  }, [drawing, token, state]);

  const remove = async () => {
    setDeleting({ busy: true, error: null });
    const result = await api.deleteResult(token);
    if (!result.ok && result.code !== "NOT_FOUND") { setDeleting({ busy: false, error: errorMessage(result.code) }); return; }
    if (readStored("local", LAST_RESULT_KEY) === token) writeStored("local", LAST_RESULT_KEY, null);
    setState({ kind: "deleted" });
  };

  if (state.kind === "loading") return <main className="as-main"><p className="as-note" role="status">正在读取结果…</p></main>;
  if (state.kind === "deleted") return <main className="as-main"><section className="as-sheet">
    <h1>已删除</h1>
    <p>你的结果、海报、邀请链接和双人卡都已失效。</p>
    <a className="as-button" href="/">重新测一次</a>
  </section></main>;
  if (state.kind === "error") return <main className="as-main"><section className="as-sheet">
    <h1>{state.code === "NOT_FOUND" ? "没有找到这个结果" : "暂时打不开"}</h1>
    <p>{errorMessage(state.code)}</p>
    <a className="as-button" href="/">去测一测</a>
  </section></main>;

  const { view } = state;
  const type = view.type;
  return <main className="as-main as-result" style={groupStyle(type)}>
    <TypeHeading type={type} />
    <p className="as-note" aria-live="polite">{isDrawing(view.avatar) ? "你的专属形象正在画，好了会自动换到海报上（约 1 分钟）。"
      : view.avatar.state === "template" ? "这次用的是类型的基础形象。" : wasDrawing ? "专属形象已换上。" : ""}</p>
    <SavableImage src={withVersion(view.posterUrl, version)} alt={`${type.name} ${type.code} 的海报`} width={1080} height={1440}
      downloadName={`crossline-${type.code}.png`} extra={{ src: withVersion(view.longUrl, version), label: "长图", downloadName: `crossline-${type.code}-长图.png` }} />

    <section className="as-block">
      <h2>四条轴</h2>
      <AxesList type={type} />
    </section>
    <TypeDetails type={type} />

    <section className="as-block">
      <h2>邀请 TA 测</h2>
      <p>朋友用这个链接答完 32 题，你们的双人卡当场生成{view.sendEmail ? "，你也会收到邮件" : ""}。海报上的二维码也是这个链接。</p>
      <ShareInvite url={view.inviteUrl} title="测测我们是什么关系" text={`${view.nickname || "你的朋友"} 邀请你测测你们是什么关系`} />
    </section>

    <section className="as-block">
      <h2>双人卡</h2>
      {view.pairs.length ? <ul className="as-pairs">{view.pairs.map((pair) => <li key={pair.pairToken}>
        <a href={`/p/${pair.pairToken}`}><span><b>{pair.nickname || "你的朋友"}</b> · {pair.name} {pair.code}</span><span className="as-note">{pair.relation}</span></a>
      </li>)}</ul> : <p className="as-note">还没有人通过你的链接测过。</p>}
    </section>

    <section className="as-block">
      <h2>你的数据</h2>
      <p className="as-note">结果保存到 {dateText(view.expiresAt)}，到期自动删除。</p>
      {confirming ? <div className="as-confirm" role="group" aria-label="确认删除" id="as-delete">
        <p>删除后，海报、邀请链接和所有双人卡都会失效，不能恢复。</p>
        <div className="as-row">
          <button type="button" className="as-danger" disabled={deleting.busy} onClick={() => void remove()}>{deleting.busy ? "正在删除…" : "确认删除"}</button>
          <button type="button" disabled={deleting.busy} onClick={() => setConfirming(false)}>取消</button>
        </div>
        {deleting.error && <p className="as-error" role="alert">{deleting.error}</p>}
      </div> : <button type="button" onClick={() => setConfirming(true)}>删除我的结果</button>}
    </section>
    <p className="as-disclaimer">{DISCLAIMER}</p>
  </main>;
}
