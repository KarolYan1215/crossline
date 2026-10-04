/**
 * What kind of source a file is, from its name and the type the browser claimed. Pure, so the web app (which
 * decides whether to accept an upload) and the worker (which decides how to read it) cannot disagree.
 */
export type SourceKind = "pdf" | "docx" | "image" | "audio" | "text";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function sourceKindFor(fileName: string, mediaType: string): SourceKind | undefined {
  const name = fileName.toLowerCase();
  if (mediaType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mediaType === DOCX || name.endsWith(".docx")) return "docx";
  if (/^image\/(png|jpeg|gif|webp)$/.test(mediaType) || /\.(png|jpe?g|gif|webp)$/.test(name)) return "image";
  if (mediaType.startsWith("audio/") || /\.(m4a|mp3|wav|aac|ogg|flac)$/.test(name)) return "audio";
  if (mediaType.startsWith("text/") || /\.(txt|md|markdown|csv)$/.test(name)) return "text";
  return undefined;
}

/** Audio is large by nature; everything else is a document. */
export const SOURCE_SIZE_LIMIT: Record<SourceKind, number> = {
  pdf: 25 * 1024 * 1024, docx: 25 * 1024 * 1024, image: 15 * 1024 * 1024,
  audio: 100 * 1024 * 1024, text: 5 * 1024 * 1024
};
