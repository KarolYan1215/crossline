/**
 * What a card shows when its preview is opened, built on the server from the ledger (`previews.ts`). The page frames are not embedded
 * (the private deployment forbids framing), so a preview is a summary of the thing plus the link that opens it.
 */
export type AskPreviewData =
  | { kind: "portrait"; image?: string; code?: string; name?: string; tagline?: string; summary?: string; keywords: string[] }
  | { kind: "milestones"; items: Array<{ title: string; deadline?: string; status: "draft" | "approved" | "archived"; line: string }> }
  | { kind: "task"; title: string; state: string; due?: string; steps: Array<{ title: string; done: boolean }> }
  | { kind: "file"; fileName: string; excerpt: string };

/** Keyed by ask id. */
export type AskPreviews = Record<string, AskPreviewData>;
