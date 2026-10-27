"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet } from "./overlay";
import { useT } from "../locale-context";
import "./remote-login.css";

/**
 * The login dialog of the hosted beta (docs/skills-library.md 「托管版登录」): a browser on the server, its screen polled as JPEG frames
 * and drawn here, the person's clicks, scrolling and typing sent back. Everything the site asks is answered by the person in this
 * dialog; the page keeps nothing of what is typed (each character goes out and the field is emptied).
 *
 * Positions are sent as fractions of the frame, so the frame may be drawn at any size. On a touch screen a tap is a click and a drag
 * scrolls the page; typing goes through a small text field so the phone's keyboard and input methods work.
 */
export type RemoteLoginTarget = { workflowId: string; service: string };
type Frame = { data: string; width: number; height: number; seq: number };
type Session = { url: string; title: string; label: string; endsAt: string; purpose?: "login" | "verify" };
type RemoteEvent =
  | { kind: "mouse"; type: "move" | "down" | "up" | "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string };

/** Keys sent as keys; anything else typed is text. Escape is not among them: it closes the dialog, as everywhere in Crossline. */
const KEYS = new Set(["Enter", "Tab", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const POLL_MS = 400;
/** The empty field keeps one space, so a Backspace on a phone keyboard (which often reports no key) still shows up as a shorter value. */
const SENTINEL = " ";

/** The server browser's window for this screen: the desktop size on a computer, the phone's own width on a phone. */
export function remoteWindowSize(width: number, height: number): { width: number; height: number } {
  if (width >= 760) return { width: 1280, height: 800 };
  return { width: Math.max(360, Math.min(1280, Math.round(width))), height: Math.max(560, Math.min(900, Math.round(height - 190))) };
}

/** Where on the frame an event landed, as fractions of it. */
export function framePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((clientX - rect.left) / Math.max(1, rect.width)), y: clamp((clientY - rect.top) / Math.max(1, rect.height)) };
}

export function RemoteLogin({ target, label, onClose }: { target: RemoteLoginTarget; label: string; onClose: (loggedIn: boolean) => void }) {
  const t = useT();
  const [frame, setFrame] = useState<Frame | undefined>();
  const [session, setSession] = useState<Session | undefined>();
  const [note, setNote] = useState("");
  const [closed, setClosed] = useState(false);
  const seq = useRef(0);
  const image = useRef<HTMLImageElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const queue = useRef<RemoteEvent[]>([]);
  const sending = useRef(false);
  const touch = useRef<{ x: number; y: number; lastY: number; moved: boolean } | undefined>(undefined);
  const composing = useRef(false);

  // Frames: polled while the dialog is open; the server says when the browser has closed (finished elsewhere, or left too long).
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const answer = await fetch(`/api/remote-browser/frame?after=${seq.current}`, { cache: "no-store" })
        .then((response) => response.json() as Promise<{ ok?: boolean; open?: boolean; frame?: Frame; session?: Session }>).catch(() => undefined);
      if (stopped) return;
      if (answer?.ok && answer.open === false) { setClosed(true); return; }
      if (answer?.session) setSession(answer.session);
      if (answer?.frame) { seq.current = answer.frame.seq; setFrame(answer.frame); }
      timer = setTimeout(() => { void poll(); }, POLL_MS);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  // Inputs in order, batched while one request is out; moves are coalesced to the latest.
  const flush = useCallback(async () => {
    if (sending.current || !queue.current.length) return;
    sending.current = true;
    const events = queue.current.splice(0, 60);
    const answer = await fetch("/api/remote-browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "input", events }) })
      .then((response) => response.json() as Promise<{ ok?: boolean; code?: string; message?: string }>).catch(() => undefined);
    sending.current = false;
    if (answer && !answer.ok && answer.code === "REMOTE_BROWSER_CLOSED") setClosed(true);
    else if (!answer?.ok) setNote(answer?.message ?? t("操作没有送达，稍后再试"));
    if (queue.current.length) void flush();
  }, []);
  const send = useCallback((event: RemoteEvent) => {
    const last = queue.current[queue.current.length - 1];
    if (event.kind === "mouse" && event.type === "move" && last?.kind === "mouse" && last.type === "move") queue.current[queue.current.length - 1] = event;
    else queue.current.push(event);
    void flush();
  }, [flush]);

  const point = (clientX: number, clientY: number) => image.current ? framePoint(clientX, clientY, image.current.getBoundingClientRect()) : undefined;
  const focusField = () => { field.current?.focus({ preventScroll: true }); };

  // A wheel over the frame scrolls the page on the server, not this dialog (React's wheel handler is passive and cannot stop that).
  useEffect(() => {
    const node = image.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = point(event.clientX, event.clientY);
      if (at) send({ kind: "wheel", ...at, dx: event.deltaX, dy: event.deltaY });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  });

  const button = (which: number): "left" | "right" | "middle" => which === 2 ? "right" : which === 1 ? "middle" : "left";
  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    event.preventDefault();
    const at = point(event.clientX, event.clientY);
    if (!at) return;
    if (event.pointerType === "touch") { touch.current = { x: event.clientX, y: event.clientY, lastY: event.clientY, moved: false }; return; }
    // Held until the button is let go, so a release outside the frame still reaches the page.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    focusField();
    send({ kind: "mouse", type: "down", ...at, button: button(event.button) });
  };
  const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const at = point(event.clientX, event.clientY);
    if (!at) return;
    const finger = touch.current;
    if (event.pointerType === "touch") {
      if (!finger) return;
      if (Math.abs(event.clientY - finger.y) > 8 || Math.abs(event.clientX - finger.x) > 8) finger.moved = true;
      if (finger.moved) {
        // Dragging a finger scrolls the page under it, the way it does on a phone; scaled to the server's pixels.
        const scale = frame && image.current ? frame.height / Math.max(1, image.current.getBoundingClientRect().height) : 1;
        send({ kind: "wheel", ...at, dx: 0, dy: (finger.lastY - event.clientY) * scale });
        finger.lastY = event.clientY;
      }
      return;
    }
    send({ kind: "mouse", type: "move", ...at });
  };
  const onPointerUp = (event: React.PointerEvent<HTMLImageElement>) => {
    const at = point(event.clientX, event.clientY);
    if (!at) return;
    if (event.pointerType === "touch") {
      const finger = touch.current;
      touch.current = undefined;
      if (finger && !finger.moved) { focusField(); send({ kind: "mouse", type: "click", ...at }); }
      return;
    }
    send({ kind: "mouse", type: "up", ...at, button: button(event.button) });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current) return;
    if (KEYS.has(event.key)) {
      event.preventDefault();
      send({ kind: "key", key: event.key === "Tab" && event.shiftKey ? "Shift+Tab" : event.key });
    } else if (event.key === "Backspace" && field.current?.value === SENTINEL) {
      event.preventDefault();
      send({ kind: "key", key: "Backspace" });
    }
  };
  // What the field holds besides the sentinel is what was typed (or pasted, or chosen in an input method): sent, and the field emptied.
  const take = () => {
    const node = field.current;
    if (!node || composing.current) return;
    const value = node.value;
    if (!value.startsWith(SENTINEL)) send({ kind: "key", key: "Backspace" });
    const text = (value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : value).replace(/[\r\n]+/g, "");
    for (let start = 0; start < text.length; start += 200) send({ kind: "text", text: text.slice(start, start + 200) });
    node.value = SENTINEL;
  };

  const act = async (action: "back" | "reload" | "cancel") => {
    await fetch("/api/remote-browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => undefined);
    if (action === "cancel") onClose(false);
  };
  const finish = async () => {
    setNote(t("正在保存登录状态"));
    const answer = await fetch(`/api/skills/grown/${encodeURIComponent(target.workflowId)}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "login_done", service: target.service }) })
      .then((response) => response.json() as Promise<{ ok?: boolean; message?: string }>).catch(() => undefined);
    if (answer?.ok) onClose(true); else setNote(answer?.message ?? t("没有保存，稍后再试"));
  };

  const ends = session?.endsAt ? new Date(session.endsAt) : undefined;
  // A reader's own page lent for the site's verification: the same dialog, said as a verification.
  const verifying = session?.purpose === "verify";
  return <Sheet title={verifying ? t("完成{{label}}的验证", { label }) : t("登录{{label}}", { label })} size="wide" open onOpenChange={(open) => { if (!open) void act("cancel"); }}
    footer={closed ? <button type="button" className="primary-button" onClick={() => onClose(false)}>{t("关闭")}</button> : <>
      <button type="button" className="secondary-button" onClick={() => { void act("cancel"); }}>{verifying ? t("不验证，先停下") : t("取消")}</button>
      <button type="button" className="primary-button" onClick={() => { void finish(); }}>{verifying ? t("验证完成") : t("登录完成")}</button>
    </>}>
    <div className="rl-body">
      <p className="rl-intro">{verifying
        ? t("{{label}}在读取中途要求验证。下方是正在读取的那个页面：请本人完成验证（滑块、点选或短信），系统不代做。完成后点「验证完成」，读取会从停下的地方接着往下。", { label })
        : t("在下方画面里登录{{label}}：账号、密码、验证码、短信或 Duo 都由本人完成，系统不代填、不保存输入的内容。这个浏览器运行在 Crossline 的服务器上（香港），网站看到的是服务器的地址。登录后点「登录完成」，之后由服务器上的同一浏览器读取。", { label })}</p>
      <div className="rl-bar">
        <button type="button" className="secondary-button" disabled={closed} onClick={() => { void act("back"); }} aria-label={t("后退")}>←</button>
        <button type="button" className="secondary-button" disabled={closed} onClick={() => { void act("reload"); }}>{t("刷新")}</button>
        <output className="rl-address" title={session?.url ?? ""}>{session?.url || t("正在打开")}</output>
      </div>
      {closed ? <p className="rl-closed">{t("登录窗口已关闭（登录完成、取消，或 10 分钟没有操作）。需要时重新点「登录{{label}}」。", { label })}</p>
        : <div className="rl-screen" onClick={focusField}>
          {frame ? <img ref={image} className="rl-frame" alt={t("{{label}}的页面画面", { label })} src={`data:image/jpeg;base64,${frame.data}`} width={frame.width} height={frame.height}
            draggable={false} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onContextMenu={(event) => event.preventDefault()} />
            : <p className="rl-wait">{t("正在打开{{label}}…", { label })}</p>}
          <textarea ref={field} className="rl-keys" aria-label={t("在{{label}}页面里输入", { label })} defaultValue={SENTINEL} autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
            onKeyDown={onKeyDown} onInput={take} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; take(); }} />
        </div>}
      {note && <p role="status" className="st-note">{note}</p>}
      {ends && !closed && <p className="rl-limit">{t("最长开到 {{time}}；10 分钟没有操作会自动关闭。", { time: `${ends.getHours()}:${String(ends.getMinutes()).padStart(2, "0")}` })}</p>}
    </div>
  </Sheet>;
}
