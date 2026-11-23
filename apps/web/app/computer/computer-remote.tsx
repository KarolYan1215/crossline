"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REMOTE_CODE_WORDS, remoteCodeOf, type RemoteCode, type RemoteKind } from "@crossline/core/remote-control";
import { commandSha, phoneKey, readPhoneKey, remoteKeySupported, signRemote, type PhoneKey } from "../../lib/remote-key";
import { intlLocale } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";

type Computer = { host: string; role: string; online: boolean; lastSeen?: string; level?: string; phones?: number; folders?: boolean; transcribe?: boolean; forms?: boolean };
type Pending = { approval: string; kind: string; subject: string; sha: string; cwd?: string; rule?: string; reason?: string; expiresAt?: string };
type Live = { session: { id: string; folder: string; approval: string; endsAt: string } | null; busy: boolean; draft: string; running: string | null; pending: Pending[] };
type Event = { type: string; at: string; event?: string; session?: string; text?: string; command?: string; exitCode?: number | null; output?: string; truncated?: boolean;
  subject?: string; state?: string; accepted?: boolean; code?: string; reason?: string; files?: Array<{ path: string }>; direct?: boolean; role?: string };
type State = { ok?: boolean; computers: Computer[]; host: string; notify: boolean; live: Live | null; events: Event[] };
type Answer = { ok?: boolean; code?: string; reason?: string; blocker?: { code?: string; message?: string } } & Record<string, unknown>;

const post = async (path: string, body: Record<string, unknown> = {}): Promise<Answer> => {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
  if (!response) return { ok: false, code: "REMOTE_OFFLINE" };
  return await response.json().catch(() => ({ ok: false, code: "REMOTE_OFFLINE" })) as Answer;
};
const PAIRED = "crossline.remote.paired";
const pairedHosts = (): string[] => { try { return JSON.parse(localStorage.getItem(PAIRED) ?? "[]") as string[]; } catch { return []; } };
const rememberPaired = (host: string) => { try { localStorage.setItem(PAIRED, JSON.stringify([...new Set([...pairedHosts(), host])])); } catch { /* a convenience only */ } };
const sessionId = () => `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** The phone's view of the person's computer (docs/plans/remote-control-1122.md §6). */
export function ComputerRemote() {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<State | undefined>();
  const [down, setDown] = useState(false);
  const [host, setHost] = useState("");
  const [key, setKey] = useState<PhoneKey | undefined>();
  const [paired, setPaired] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState<{ text: string; reason: string } | undefined>();
  const [result, setResult] = useState<{ command: string; output: string; exitCode: unknown } | undefined>();
  const words = (answer: Answer) => {
    const code = answer.code ?? answer.blocker?.code ?? "";
    const known = REMOTE_CODE_WORDS[remoteCodeOf(code) as RemoteCode];
    return [known ? t(known) : answer.blocker?.message ?? t("没有完成，请重试。"), answer.reason].filter(Boolean).join(" · ");
  };
  const load = useCallback(async () => {
    const next = await post("/api/computer/state", host ? { host } : {}) as unknown as State;
    // The worker not answering is said, not shown as loading forever; the last state stays while it is away.
    setDown(!next?.computers);
    if (next?.computers) { setState(next); if (!host && next.host) setHost(next.host); }
  }, [host]);
  useEffect(() => {
    void readPhoneKey().then(setKey);
    setPaired(pairedHosts());
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 2_000); return () => clearInterval(timer); }, [load]);

  const computer = state?.computers.find((item) => item.host === host);
  const live = state?.live;
  const session = live?.session ?? null;
  const time = (iso?: string) => iso ? new Date(iso).toLocaleString(intlLocale(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

  /** One signed instruction to this computer; the answer, or why not, in words. */
  const send = async (kind: RemoteKind, payload: Record<string, unknown>, sessionOf?: string): Promise<Answer> => {
    setBusy(true);
    try {
      const signed = await signRemote({ kind, computer: host, ...(sessionOf ? { session: sessionOf } : {}), payload });
      const answer = await post("/api/computer/send", { signed });
      if (!answer.ok) setNote(words(answer)); else setNote("");
      void load();
      return answer;
    } catch { setNote(t("这部手机还没有密钥：先配对。")); return { ok: false }; }
    finally { setBusy(false); }
  };

  if (!state) return <p className="muted" role="status">{down ? t("后台服务没有连上，稍后再试。") : t("正在读取……")}</p>;
  if (!remoteKeySupported()) return <p className="st-note">{t("这个浏览器不能保存遥控密钥（需要 https 网址）。")}</p>;
  if (!state.computers.length) return <section className="st-card"><p>{t("这个账号还没有开启「从手机遥控」的电脑。")}</p>
    <p className="muted">{t("在电脑上打开 Crossline 的「这台电脑」页，开启算力节点，把「在这台电脑上执行命令」设为「只从手机遥控」。")}</p></section>;

  const isPaired = Boolean(key) && paired.includes(host);
  const submitText = async () => {
    const value = text.trim();
    if (!value || !session) return;
    if (value.startsWith("!")) {
      const command = value.slice(1).trim();
      const answer = await send("command", { text: command }, session.id);
      if (answer.ok && answer.state === "needs_confirm") { setConfirm({ text: command, reason: String(answer.reason ?? "") }); return; }
      if (answer.ok) { setText(""); setResult({ command, output: String(answer.output ?? ""), exitCode: answer.exitCode }); }
      return;
    }
    const answer = await send("message", { text: value }, session.id);
    if (answer.ok) setText("");
  };

  return <div className="cr">
    <section className="st-card cr-head" aria-label={t("电脑")}>
      {state.computers.length > 1 && <select value={host} onChange={(event) => setHost(event.target.value)} aria-label={t("选择电脑")}>
        {state.computers.map((item) => <option key={item.host} value={item.host}>{item.host}</option>)}</select>}
      <p><b>{host}</b> · <span className={computer?.online ? "cr-on" : "cr-off"}>{computer?.online ? t("电脑在线") : t("电脑离线（最后在线：{{when}}）", { when: time(computer?.lastSeen) })}</span></p>
      {session && <p className="muted">{t("会话进行中：{{folder}}，到 {{until}} 结束", { folder: session.folder, until: time(session.endsAt) })}</p>}
    </section>

    {!computer?.online && <section className="st-card">
      <p>{t("电脑不在线：开始会话、读文件夹、提交表单都要等它连上。其余功能在网页版照常可用。")}</p>
      <p className="muted">{t("离线时不会排队执行：签好的指令五分钟后就过期。")}</p>
      <label className="cr-check"><input type="checkbox" checked={state.notify} onChange={(event) => void post("/api/computer/notify", { on: event.target.checked }).then(load)} /> {t("电脑上线时通知我")}</label>
    </section>}

    {computer?.online && !isPaired && <PairCard host={host} onPaired={async () => { rememberPaired(host); setPaired(pairedHosts()); setKey(await readPhoneKey()); }} />}

    {computer?.online && isPaired && !session && <StartCard host={host} busy={busy} onStart={async (payload) => { await send("session.start", payload, sessionId()); }} />}

    {session && <section className="st-card cr-session" aria-label={t("会话")}>
      <ol className="cr-feed">
        {state.events.filter((event) => event.session === session.id).map((event, index) => <FeedItem key={index} event={event} />)}
        {live?.draft && <li className="cr-msg cr-assistant cr-live">{live.draft}</li>}
        {live?.running && <li className="cr-cmd cr-live"><code>{live.running}</code> <span className="muted">{t("正在执行……")}</span></li>}
      </ol>
      {live?.pending.map((item) => <div key={item.approval} className="cr-approval" role="alert">
        <p><b>{item.kind === "fileChange" ? t("助手要改这些文件") : t("助手要执行这条命令")}</b>{item.reason ? ` · ${item.reason}` : ""}</p>
        <pre>{item.subject}</pre>
        {item.cwd && <p className="muted">{t("工作目录：{{cwd}}", { cwd: item.cwd })}</p>}
        <p className="cr-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={() => void commandSha(item.subject).then((sha) => send("approve", { approval: item.approval, sha: item.subject.length < 4_000 ? sha : item.sha }, session.id))}>{t("执行")}</button>
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("deny", { approval: item.approval, sha: item.sha }, session.id)}>{t("不执行")}</button></p>
      </div>)}
      {confirm && <div className="cr-approval" role="alert"><p><b>{t("这条命令需要再确认一次")}</b> · {confirm.reason}</p><pre>{confirm.text}</pre>
        <p className="cr-actions"><button type="button" className="primary-button" disabled={busy} onClick={() => void send("command", { text: confirm.text, confirm: true }, session.id).then((answer) => {
          setConfirm(undefined); if (answer.ok) { setText(""); setResult({ command: confirm.text, output: String(answer.output ?? ""), exitCode: answer.exitCode }); } })}>{t("执行")}</button>
          <button type="button" className="secondary-button" onClick={() => setConfirm(undefined)}>{t("取消")}</button></p></div>}
      {result && <div className="cr-result"><p><code>{result.command}</code> · {t("退出码 {{code}}", { code: String(result.exitCode ?? "—") })}</p><pre>{result.output || t("（没有输出）")}</pre>
        <button type="button" className="secondary-button" onClick={() => setResult(undefined)}>{t("收起")}</button></div>}
      <div className="cr-input">
        <textarea value={text} rows={2} onChange={(event) => setText(event.target.value)} placeholder={t("对助手说……；以 ! 开头直接执行一条命令")} aria-label={t("消息")} />
        <button type="button" className="primary-button" disabled={busy || !text.trim() || (live?.busy && !text.trim().startsWith("!"))} onClick={() => void submitText()}>{t("发送")}</button>
      </div>
      <p className="cr-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("interrupt", {}, session.id)}>{t("停止")}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void send("session.stop", {}, session.id)}>{t("结束会话")}</button></p>
    </section>}

    {note && <p role="status" className="st-note">{note}</p>}
    {computer?.online && isPaired && computer.folders && <FoldersCard host={host} sign={send} />}
    {computer?.online && isPaired && computer.forms && <FormsCard host={host} sign={send} />}
    <History events={state.events} time={time} />
  </div>;
}

/** 「用这部手机遥控」: a code from the computer's page, this phone's key, and the fingerprint to compare there (§5.1). */
function PairCard({ host, onPaired }: { host: string; onPaired: () => Promise<void> }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [groups, setGroups] = useState("");
  const [note, setNote] = useState("");
  const pair = async () => {
    const key = await phoneKey();
    const answer = await post("/api/computer/pair", { host, code: code.trim(), publicKey: key.publicKey, label: label.trim() || t("手机") });
    if (!answer.ok) { setNote(t(REMOTE_CODE_WORDS.REMOTE_PAIRING_REFUSED)); return; }
    // The digits stay on screen until the person has compared them on the computer; only then does the page go on.
    setGroups(key.groups);
  };
  return <section className="st-card" id="pair" aria-label={t("用这部手机遥控")}>
    <header><h3>{t("用这部手机遥控")}</h3><small>{t("在电脑上「这台电脑」页点「添加手机」，把显示的 8 位配对码填在这里")}</small></header>
    {groups ? <><p>{t("在电脑上核对这串数字，一致才点「确认」：")}</p><p className="cr-groups">{groups}</p>
      <p className="muted">{t("确认后这部手机才能遥控。清除浏览器的网站数据会丢失密钥，要重新配对。")}</p>
      <p><button type="button" className="primary-button" onClick={() => void onPaired()}>{t("电脑上已确认")}</button></p></> : <>
      <label className="st-row"><span className="st-row-label">{t("配对码")}</span><input inputMode="numeric" value={code} maxLength={8} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>
      <label className="st-row"><span className="st-row-label">{t("这部手机的名称")}</span><input value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} placeholder={t("手机")} /></label>
      <p><button type="button" className="primary-button" disabled={code.length !== 8} onClick={() => void pair()}>{t("配对")}</button></p></>}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

/** 开始会话: the working folder from the computer's list, the approval mode, how long (§6.1). */
function StartCard({ host, busy, onStart }: { host: string; busy: boolean; onStart: (payload: Record<string, unknown>) => Promise<void> }) {
  const t = useT();
  const [folders, setFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState("");
  const [approval, setApproval] = useState("each");
  const [hours, setHours] = useState(1);
  useEffect(() => { void post("/api/computer/status", { host }).then((answer) => { if (Array.isArray(answer.folders)) setFolders(answer.folders as string[]); }); }, [host]);
  return <section className="st-card" aria-label={t("开始会话")}>
    <header><h3>{t("开始会话")}</h3><small>{t("助手用电脑上本人自己的 ChatGPT 登录运行")}</small></header>
    <label className="st-row"><span className="st-row-label">{t("工作文件夹")}</span>
      <select value={folder} onChange={(event) => setFolder(event.target.value)}><option value="">{t("会话自己的临时文件夹")}</option>
        {folders.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    <label className="st-row"><span className="st-row-label">{t("审批方式")}</span>
      <select value={approval} onChange={(event) => setApproval(event.target.value)}><option value="each">{t("每条命令都问我")}</option>
        <option value="auto_in_folder">{t("会话文件夹内的命令自动执行，其余问我")}</option></select></label>
    <label className="st-row"><span className="st-row-label">{t("时长")}</span>
      <select value={hours} onChange={(event) => setHours(Number(event.target.value))}>{[1, 2, 4, 8].map((value) => <option key={value} value={value}>{t("{{count}} 小时", { count: value })}</option>)}</select></label>
    <p><button type="button" className="primary-button" disabled={busy} onClick={() => void onStart({ ...(folder ? { folder } : {}), approval, hours })}>{t("开始")}</button></p>
  </section>;
}

function FeedItem({ event }: { event: Event }) {
  const t = useT();
  const type = event.type;
  if (type === "message.person") return <li className="cr-msg cr-person">{event.text}</li>;
  if (type === "message.assistant") return <li className="cr-msg cr-assistant">{event.text}</li>;
  if (type === "command.completed") return <li className="cr-cmd"><code>{event.direct ? "! " : ""}{event.command}</code> <span className="muted">{t("退出码 {{code}}", { code: String(event.exitCode ?? "—") })}</span>
    {event.output ? <pre>{event.output}{event.truncated ? "\n…" : ""}</pre> : null}</li>;
  if (type === "files.changed") return <li className="cr-cmd muted">{t("改动了 {{count}} 个文件", { count: event.files?.length ?? 0 })}: {(event.files ?? []).map((file) => file.path.split(/[\\/]/).pop()).join("、")}</li>;
  if (type === "approval.refused") return <li className="cr-cmd cr-refused">{t("守卫拒绝：{{reason}}", { reason: event.reason ?? "" })}<pre>{event.subject}</pre></li>;
  if (type === "approval.resolved") return <li className="cr-cmd muted">{event.accepted ? t("已批准") : t("未批准")}</li>;
  if (type === "approval.expired") return <li className="cr-cmd muted">{t("五分钟没有回答，已拒绝")}</li>;
  if (type === "refused") return <li className="cr-cmd cr-refused">{t(REMOTE_CODE_WORDS[remoteCodeOf(event.code ?? "") as RemoteCode] ?? "电脑拒绝了这条指令")}{event.reason ? ` · ${event.reason}` : ""}</li>;
  if (type === "session.started") return <li className="cr-cmd muted">{t("会话开始")}</li>;
  if (type === "session.ended") return <li className="cr-cmd muted">{t("会话结束")}</li>;
  return null;
}

/** The authorised folders on the computer: names, sizes and dates; a file's content only with a signature (§6.3). */
function FoldersCard({ host, sign }: { host: string; sign: (kind: RemoteKind, payload: Record<string, unknown>) => Promise<Answer> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState<string | undefined>();
  const [dir, setDir] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [shown, setShown] = useState<{ name: string; text: string } | undefined>();
  const [note, setNote] = useState("");
  const list = useCallback(async () => {
    const answer = await post("/api/computer/folders", { host, ...(folder ? { folder } : {}), dir });
    if (answer.ok) { setLines(String(answer.text ?? "").split("\n").filter(Boolean)); setNote(""); } else setNote(String(answer.reason ?? t("读不到这个位置。")));
  }, [host, folder, dir, t]);
  useEffect(() => { if (open) void list(); }, [open, list]);
  const read = async (relative: string, as: "text" | "file" | "save") => {
    const answer = await sign("folder.read", { folder, path: relative, as });
    if (!answer.ok) return;
    if (as === "file" && typeof answer.data === "string") {
      const bytes = Uint8Array.from(atob(answer.data), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: String(answer.contentType ?? "application/octet-stream") }));
      const link = document.createElement("a");
      link.href = url; link.download = String(answer.name ?? "file"); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    if (as === "save") { setNote(t("已存进 Crossline，几分钟内出现在资料里。")); return; }
    setShown({ name: String(answer.name ?? relative), text: String(answer.text ?? "") });
  };
  return <section className="st-card" aria-label={t("授权文件夹")}>
    <header><h3>{t("授权文件夹")}</h3><small>{t("列清单不签名；读内容、存进 Crossline、下载原文件都由这部手机签名")}</small></header>
    {!open ? <p><button type="button" className="secondary-button" onClick={() => setOpen(true)}>{t("浏览")}</button></p> : <>
      {folder && <p><button type="button" className="secondary-button" onClick={() => { if (dir) setDir(dir.split("/").slice(0, -1).join("/")); else setFolder(undefined); }}>{t("上一级")}</button> <span className="muted">{dir || "/"}</span></p>}
      <ul className="cr-files">{lines.map((line) => {
        if (!folder) { const id = line.split(" · ")[0] ?? ""; return <li key={line}><button type="button" className="cr-link" onClick={() => { setFolder(id); setDir(""); }}>{line}</button></li>; }
        if (/^《/.test(line)) return <li key={line} className="muted">{line}</li>;
        const relative = line.split(" · ")[0] ?? "";
        if (relative.endsWith("/")) return <li key={line}><button type="button" className="cr-link" onClick={() => setDir(relative.replace(/\/$/, ""))}>{relative}</button></li>;
        return <li key={line}><span>{line}</span> <span className="cr-actions">
          <button type="button" className="secondary-button" onClick={() => void read(relative, "text")}>{t("读取")}</button>
          <button type="button" className="secondary-button" onClick={() => void read(relative, "save")}>{t("存进 Crossline")}</button>
          <button type="button" className="secondary-button" onClick={() => void read(relative, "file")}>{t("下载")}</button></span></li>;
      })}</ul></>}
    {shown && <div className="cr-result"><p><b>{shown.name}</b></p><pre>{shown.text || t("（没有可读的文字）")}</pre><button type="button" className="secondary-button" onClick={() => setShown(undefined)}>{t("收起")}</button></div>}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

/** Free registration forms filled on the computer and waiting for 提交: a fresh masked picture, then a signed submit (§6.5). */
function FormsCard({ host, sign }: { host: string; sign: (kind: RemoteKind, payload: Record<string, unknown>) => Promise<Answer> }) {
  const t = useT();
  const [forms, setForms] = useState<Array<{ id: string; title: string; host: string; free: boolean }>>([]);
  const [shot, setShot] = useState<{ id: string; picture: string; shot: string; button: { role: string; name: string }; checklist: Array<{ field: string; shown: string }> } | undefined>();
  const [note, setNote] = useState("");
  const loaded = useRef(false);
  useEffect(() => { if (loaded.current) return; loaded.current = true; void post("/api/computer/forms", { host }).then((answer) => { if (Array.isArray(answer.forms)) setForms(answer.forms as typeof forms); }); }, [host]);
  if (!forms.length) return null;
  const take = async (id: string) => {
    setNote("");
    const answer = await post(`/api/computer/forms/${id}/shot`);
    if (!answer.ok) { setNote(t(REMOTE_CODE_WORDS.REMOTE_FORM_REFUSED)); return; }
    setShot({ id, picture: String(answer.picture), shot: String(answer.shot), button: answer.button as { role: string; name: string }, checklist: (answer.checklist ?? []) as Array<{ field: string; shown: string }> });
  };
  const submit = async () => {
    if (!shot) return;
    const answer = await sign("form.submit", { run: shot.id, shot: shot.shot, button: shot.button });
    if (answer.ok) { setShot(undefined); setNote(t("已在电脑上点了「{{button}}」。确认页出现后，报名记录会更新。", { button: shot.button.name })); }
  };
  return <section className="st-card" aria-label={t("等提交的报名表")}>
    <header><h3>{t("等提交的报名表")}</h3><small>{t("只有免费的可以从手机提交；需要付款的永远在电脑前由本人完成")}</small></header>
    <ul className="cr-files">{forms.map((form) => <li key={form.id}><span>{form.title}</span> {form.free
      ? <button type="button" className="secondary-button" onClick={() => void take(form.id)}>{t("截图核对")}</button> : <span className="muted">{t("需要付款，只能在电脑上提交")}</span>}</li>)}</ul>
    {shot && <div className="cr-result">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL of the form's picture */}
      <img src={`data:image/png;base64,${shot.picture}`} alt={t("报名表截图")} className="cr-shot" />
      <ul>{shot.checklist.map((item, index) => <li key={index}>{item.field}：{item.shown}</li>)}</ul>
      <p className="muted">{t("截图两分钟内有效；截图后页面有变化，电脑会拒绝。")}</p>
      <p className="cr-actions"><button type="button" className="primary-button" onClick={() => void submit()}>{t("提交（点「{{button}}」）", { button: shot.button.name })}</button>
        <button type="button" className="secondary-button" onClick={() => setShot(undefined)}>{t("取消")}</button></p></div>}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

function History({ events, time }: { events: Event[]; time: (iso?: string) => string }) {
  const t = useT();
  const sessions = events.filter((event) => event.type === "session.started").slice(-20).reverse();
  if (!sessions.length) return null;
  return <section className="st-card" aria-label={t("历史")}>
    <header><h3>{t("历史")}</h3><small>{t("最近 90 天的遥控记录；电脑上另有一份只追加的审计日志")}</small></header>
    <ul className="cr-files">{sessions.map((event) => <li key={`${event.session}-${event.at}`}>{time(event.at)} · {String((event as Record<string, unknown>).folder ?? "")}</li>)}</ul>
  </section>;
}
