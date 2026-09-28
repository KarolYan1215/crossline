"use client";

import { type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

/**
 * The quick-preview affordance every card gets: a small corner button that opens this in place, separate
 * from the card itself being a real `<Link>` to the standalone page — two independent triggers instead of
 * one click trying to mean two things. `children` is the same server-rendered `TaskDetailView`/
 * `MilestoneDetailView` output the standalone page uses; this component only supplies the dialog chrome.
 */
export function PreviewDrawer({ title, href, children }: { title: string; href: string; children: ReactNode }) {
  return <Dialog.Root>
    <Dialog.Trigger asChild>
      <button type="button" className="card-preview-button" aria-label={`预览：${title}`}
        onClick={(event) => event.stopPropagation()}>⊕</button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-sheet detail-drawer" aria-describedby={undefined}>
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        {children}
        <div className="dialog-actions">
          <a className="secondary" href={href}>⤢ 独立页面查看</a>
          <Dialog.Close asChild><button type="button" className="secondary">关闭</button></Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
