"use client";

import { useEffect, useRef, useState } from "react";
import { api, type ClientErrorCode } from "../lib/api-client";
import type { ResultView, WantsRequest } from "../lib/contract";
import { LAST_RESULT_KEY, errorMessage } from "../lib/flow";
import { AVATAR_POLL_MS, DrawingCard, isDrawing } from "./figure";
import { SavableImage } from "./poster";
import { CopyLink, ShareInvite } from "./share-invite";
import { withName } from "../lib/names";
import { readStored, writeStored } from "./storage";
import { WantsInline } from "./wants-step";
import { AxesList, TypeDetails, TypeHeading, groupStyle } from "./type-summary";

export { AVATAR_POLL_MS, isDrawing } from "./figure";
export const DISCLAIMER = "基于自评的趣味测评，非心理诊断";

const dateText = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`; };

/** The owner's own address for beta requests that do not go through the button (decided 2026-10-15). */
export const BETA_EMAIL = "karolyan1215@gmail.com";
/** A mail to the owner, subject filled in and the type code in the body, so the request says who it is from. */
export const betaMailto = (code: string, name: string): string =>
  `mailto:${BETA_EMAIL}?subject=${encodeURIComponent("Crossline 内测申请")}&body=${encodeURIComponent(`我的速测类型：${name} ${code}\n想申请 Crossline 内测。`)}`;

type State = { kind: "loading" } | { kind: "error"; code: ClientErrorCode } | { kind: "ready"; view: ResultView } | { kind: "deleted" };

/** The person's own result (`?delete=1` opens on the deletion confirmation): poster, the type as text, the figure's progress, the invitation, pair cards, and deleting it all. */
export function ResultScreen({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [wasDrawing, setWasDrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const scrollToDelete = useRef(false);
  const [deleting, setDeleting] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [beta, setBeta] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [editingWants, setEditingWants] = useState(false);
  const [wantsSave, setWantsSave] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [ownUrl, setOwnUrl] = useState("");
  useEffect(() => { setOwnUrl(`${window.location.origin}/r/${token}`); }, [token]);

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

  // While the figure is being drawn, ask again every few seconds. A failed ask (a network blip, a rate limit) is skipped, not the end of
  // asking: the old one-shot timer re-armed only after a successful answer, so one failure froze the page on the waiting state. The
  // poster addresses carry the figure's tag (server/views.ts), so the new answer brings a new poster with it.
  const drawing = state.kind === "ready" && isDrawing(state.view.avatar);
  useEffect(() => {
    if (!drawing) return;
    let live = true;
    const timer = setInterval(() => {
      void api.getResult(token).then((result) => { if (live && result.ok) setState({ kind: "ready", view: result.data }); });
    }, AVATAR_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [drawing, token]);

  const remove = async () => {
    setDeleting({ busy: true, error: null });
    const result = await api.deleteResult(token);
    if (!result.ok && result.code !== "NOT_FOUND") { setDeleting({ busy: false, error: errorMessage(result.code) }); return; }
    if (readStored("local", LAST_RESULT_KEY) === token) writeStored("local", LAST_RESULT_KEY, null);
    setState({ kind: "deleted" });
  };

  const saveWants = async (wants: WantsRequest) => {
    setWantsSave({ busy: true, error: null });
    const result = await api.setWants(token, wants);
    if (!result.ok) { setWantsSave({ busy: false, error: errorMessage(result.code) }); return; }
    const fresh = await api.getResult(token);
    if (fresh.ok) setState({ kind: "ready", view: fresh.data });
    setWantsSave({ busy: false, error: null });
    setEditingWants(false);
  };

  const askBeta = async () => {
    if (state.kind !== "ready") return;
    setBeta({ busy: true, error: null });
    const result = await api.requestBeta(token);
    if (!result.ok) { setBeta({ busy: false, error: errorMessage(result.code) }); return; }
    setBeta({ busy: false, error: null });
    setState({ kind: "ready", view: { ...state.view, betaRequested: true } });
  };

  if (state.kind === "loading") return <main className="as-main"><p className="as-note" role="status">正在读取结果…</p></main>;
  if (state.kind === "deleted") return <main className="as-main"><section className="as-sheet">
    <h1>已删除</h1>
    <p>你的邮箱、结果、海报、邀请链接和双人卡都已删除，链接全部失效。</p>
    <a className="as-button" href="/">重新测一次</a>
  </section></main>;
  if (state.kind === "error") return <main className="as-main"><section className="as-sheet">
    <h1>{state.code === "NOT_FOUND" ? "没有找到这个结果" : "暂时打不开"}</h1>
    <p>{errorMessage(state.code)}</p>
    <a className="as-button" href="/">去测一测</a>
  </section></main>;

  const { view } = state;
  const type = view.type;
  const mailed = view.sendEmail && view.mailOn;
  return <main className="as-main as-result" style={groupStyle(type)}>
    <TypeHeading type={type} />
    {!mailed && <p className="as-done">{view.sendEmail ? "邮件暂时发不出去" : "你选了不发邮件"}：请收藏本页，或到页面底部复制结果链接，否则换了设备就找不回来。</p>}
    {/* While the figure is drawn there is no poster yet: a waiting card, never the type's shared template (decided 2026-10-16). */}
    {isDrawing(view.avatar) ? <DrawingCard type={type} /> : <>
      <p className="as-note" aria-live="polite">{view.avatar.state === "template" ? "这次没有画出你的专属形象，海报上先用类型字母代替。"
        : wasDrawing ? "专属形象画好了。" : ""}</p>
      <SavableImage src={view.posterUrl} alt={`${type.name} ${type.code} 的海报`} width={1080} height={1440}
        downloadName={`crossline-${type.code}.png`} extra={{ src: view.longUrl, label: "长图", downloadName: `crossline-${type.code}-长图.png` }} />
    </>}

    <section className="as-block">
      <h2>拉朋友测，看你们是什么关系</h2>
      <p>朋友用这个链接答完 32 题，你们的双人卡当场生成{mailed ? "，你也会收到邮件" : ""}。海报上的二维码也是这个链接。</p>
      <ShareInvite url={view.inviteUrl} title="测测我们是什么关系" text={withName(view.nickname || "你的朋友", "邀请你测测你们是什么关系")} />
    </section>

    <section className="as-block">
      <h2>四条轴</h2>
      <AxesList type={type} />
    </section>
    <TypeDetails type={type} wants={!view.wants || editingWants
      ? view.wantsLeft > 0 && <div className="as-wants-ask">
        {!view.wants && <p>上面是按你的类型推荐的。告诉我们你想同时做哪几件事，按你的选择重新组合：</p>}
        <WantsInline initial={view.wants ?? { picks: [], text: "" }} left={view.wantsLeft} busy={wantsSave.busy} error={wantsSave.error}
          onSubmit={(wants) => void saveWants(wants)} onCancel={view.wants ? () => setEditingWants(false) : undefined} />
      </div>
      : view.wantsLeft > 0 && <button type="button" onClick={() => setEditingWants(true)}>改一改想做的事</button>} />

    <section className="as-block as-beta">
      <h2>把这三条线真的跑起来</h2>
      <p>Crossline 把你同时推进的几条线拆成里程碑，排进同一份日程，每天告诉你先做哪件；做完的东西留作证据，能看见每条线走了多远。</p>
      {view.appUrl ? <>
        <p className="as-note">内测现在开放，免费，名额有限。用你在这里留的邮箱登录，这份结果会自动带进 App，作为访谈的起点。</p>
        <ol className="as-steps">
          <li><b>准备一个能用 Codex 的 ChatGPT 账号。</b>App 用你自己的 ChatGPT 额度做访谈和规划，不需要另付费用。</li>
          <li><b>在 ChatGPT 打开一项设置（只需一次）。</b>ChatGPT 网页版 → 设置 → 安全 → 开启「为 Codex、Excel、PowerPoint 和 Word 启用设备代码登录」。不开的话，第 4 步的代码会被拒绝。</li>
          <li><b>打开 App，用邮箱验证码登录。</b>第一次登录就是注册，不用设密码。</li>
          <li><b>连接你的 ChatGPT。</b>页面会给一串一次性代码，在 OpenAI 的页面登录你的账号并输入它，几秒后显示「已连接」。</li>
          <li><b>和 AI 做一次深度访谈。</b>先把简历、课表、课程大纲拖进去，约 30 分钟得到一份全面的 AI 时代超级个体跨人生主线报告和跨主线排程计划。</li>
        </ol>
        <a className="as-button as-primary" href={view.appUrl} target="_blank" rel="noreferrer">打开 Crossline →</a>
      </> : <>
        <p className="as-note">现在小范围内测，名额有限，按申请先后用你留的邮箱发邀请。用同一个邮箱登录，这份结果会自动带进 App。</p>
        {view.betaRequested ? <p className="as-done" role="status">已申请。邀请会发到你留的邮箱。</p>
          : <button type="button" className="as-primary" disabled={beta.busy} onClick={() => void askBeta()}>{beta.busy ? "正在提交…" : "申请内测"}</button>}
        {beta.error && <p className="as-error" role="alert">{beta.error}</p>}
      </>}
      <p className="as-note">也可以直接发邮件到 <a href={betaMailto(type.code, type.name)}>{BETA_EMAIL}</a> 申请；在各大平台私信我也可以。</p>
    </section>

    <section className="as-block">
      <h2>双人卡</h2>
      {view.pairs.length ? <ul className="as-pairs">{view.pairs.map((pair) => <li key={pair.pairToken}>
        <a href={`/p/${pair.pairToken}`}><span><b>{pair.nickname || "你的朋友"}</b> · {pair.name} {pair.code}</span><span className="as-note">{pair.relation}</span></a>
      </li>)}</ul> : <p className="as-note">还没有人通过你的链接测过。</p>}
    </section>

    <section className="as-block">
      <h2>你的数据</h2>
      <p>{mailed ? "这个页面的链接已发到你的邮箱（没收到就看看垃圾邮件）。" : view.sendEmail ? "邮件暂时发不出去。请收藏本页，或复制下面的链接自己保存，这是回到结果的唯一入口。"
        : "你选了不发邮件。请收藏本页，或复制下面的链接自己保存，这是回到结果的唯一入口。"}</p>
      {!mailed && ownUrl && <CopyLink url={ownUrl} label="我的结果链接（只给自己看）" />}
      <p className="as-note">结果保存到 {dateText(view.expiresAt)}，到期自动删除。保存的是四条轴的分数、邮箱、署名、外貌选项和你想做的事，不存每道题的答案。</p>
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
