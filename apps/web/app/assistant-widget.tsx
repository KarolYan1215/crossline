"use client";

import { useEffect, useState } from "react";
import { AssistantChat } from "./chat/assistant-chat";

/**
 * The site-wide floating 小助手: a bubble by default, a panel when opened. The conversation survives moving between pages; the panel
 * being open does not (it used to reopen on every page and cover the content underneath).
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  // A question typed into the input box arrives here (`crossline:ask-assistant`) and is sent as the person's message.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  useEffect(() => {
    const ask = (event: Event) => { const text = String((event as CustomEvent).detail ?? "").trim(); if (text) { setSeed({ text, nonce: Date.now() }); setOpen(true); } };
    window.addEventListener("crossline:ask-assistant", ask);
    return () => window.removeEventListener("crossline:ask-assistant", ask);
  }, []);
  if (!open) return <button type="button" className="assistant-bubble" onClick={() => setOpen(true)} aria-label="打开小助手">小助手</button>;
  return <section className="assistant-panel" aria-label="小助手">
    <header>
      <span>小助手</span>
      <button type="button" className="text-button" onClick={() => setOpen(false)} aria-label="收起小助手">收起</button>
    </header>
    <AssistantChat storageKey="crossline-assistant-session" seed={seed}
      emptyText="可查询本周安排、截止日与下一步；需要改动时给出卡片，点击后才生效。" />
  </section>;
}
