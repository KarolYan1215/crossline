/**
 * What kind of source a file is, from its name and the type the browser claimed. Pure, so the web app (which
 * decides whether to accept an upload) and the worker (which decides how to read it) cannot disagree.
 */
export type SourceKind = "pdf" | "docx" | "image" | "audio" | "text";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * JSON, JSON Lines and zstd-compressed JSON Lines: read as text, so an AI conversation export the person gives (chat-history.ts) is
 * accepted; the worker recognizes the format and keeps only what the person said.
 */
export const JSON_SOURCE = /\.(json|jsonl|jsonl\.zst)$/i;

export function sourceKindFor(fileName: string, mediaType: string): SourceKind | undefined {
  const name = fileName.toLowerCase();
  if (mediaType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mediaType === DOCX || name.endsWith(".docx")) return "docx";
  if (/^image\/(png|jpeg|gif|webp)$/.test(mediaType) || /\.(png|jpe?g|gif|webp)$/.test(name)) return "image";
  if (mediaType.startsWith("audio/") || /\.(m4a|mp3|wav|aac|ogg|flac)$/.test(name)) return "audio";
  if (mediaType.startsWith("text/") || /\.(txt|md|markdown|csv)$/.test(name) || JSON_SOURCE.test(name)) return "text";
  return undefined;
}

/** Audio is large by nature; everything else is a document. */
export const SOURCE_SIZE_LIMIT: Record<SourceKind, number> = {
  pdf: 25 * 1024 * 1024, docx: 25 * 1024 * 1024, image: 15 * 1024 * 1024,
  audio: 100 * 1024 * 1024, text: 5 * 1024 * 1024
};

/** A conversation export is large by nature (a ChatGPT `conversations.json` of a few years runs to tens of MB); only what the person said is kept. */
export const CHAT_EXPORT_SIZE_LIMIT = 200 * 1024 * 1024;
/** The size a file may have: its kind's limit, or the export's for JSON. */
export const sourceSizeLimit = (fileName: string, kind: SourceKind) => kind === "text" && JSON_SOURCE.test(fileName) ? CHAT_EXPORT_SIZE_LIMIT : SOURCE_SIZE_LIMIT[kind];
