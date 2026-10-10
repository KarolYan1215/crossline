"use client";

import { useState } from "react";
import { Conversation } from "./chat/conversation";

/**
 * The site-wide floating 小助手: a bubble by default, a panel when opened. It is the one input box's conversation of the day, opened
 * larger (docs/one-input.md): the same messages as Today's box, on every page and device.
 */
export function AssistantWidget() {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="assistant-bubble" onClick={() => setOpen(true)} aria-label="打开小助手">小助手</button>;
  return <section className="assistant-panel" aria-label="小助手">
    <header>
      <span>小助手</span>
      <button type="button" className="text-button" onClick={() => setOpen(false)} aria-label="收起小助手">收起</button>
    </header>
    <Conversation variant="panel" />
  </section>;
}
