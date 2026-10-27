"use client";

import { createContext, useContext, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useT } from "../locale-context";

/**
 * Where dialogs and tips open: the page's own body unless set. The 小帮手 pinned on the desktop (a Picture-in-Picture window with its own
 * document) sets its body, so a dialog it opens appears in that window and not behind it in the tab.
 */
export const OverlayContainer = createContext<HTMLElement | null>(null);

/**
 * The one dialog chrome: `side="center"` for the task dialog, `side="right"` for the milestone drawer that keeps the timeline in view.
 * Controlled (`open`/`onOpenChange`) or triggered (`trigger`).
 */
export function Sheet({ title, side = "center", size, trigger, open, onOpenChange, footer, children }: {
  title: string; side?: "center" | "right";
  /** `wide`: most of a large screen and the whole of a phone's, for content that reads in columns (a task opened from a card). */
  size?: "wide"; trigger?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void;
  footer?: ReactNode; children: ReactNode;
}) {
  const t = useT();
  const container = useContext(OverlayContainer);
  return <Dialog.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
    {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
    <Dialog.Portal {...(container ? { container } : {})}>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="ui-sheet" data-side={side} data-size={size} aria-describedby={undefined}>
        <header className="ui-sheet-head">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close asChild><button type="button" className="ui-icon-button" aria-label={t("关闭")}>×</button></Dialog.Close>
        </header>
        <div className="ui-sheet-body">{children}</div>
        {footer && <footer className="ui-sheet-foot">{footer}</footer>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Hover/focus help for one control. Short text only — anything longer belongs on the page. */
export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const container = useContext(OverlayContainer);
  return <Tooltip.Provider delayDuration={250}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal {...(container ? { container } : {})}><Tooltip.Content className="ui-tip" sideOffset={6}>{content}<Tooltip.Arrow className="ui-tip-arrow" /></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}
