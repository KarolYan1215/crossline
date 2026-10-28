import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAccessContext } from "../../../../lib/access-guard";
import { dataDirectory } from "../../../../lib/crossline";
import { tOf } from "../../../../lib/locale";
import { isCrossSiteWrite } from "../../../../lib/same-origin";
import { serviceProxy } from "../../../../lib/service-proxy";

const TEXT_MAX = 1_000_000;
const FILE_MAX = 8_000_000;

/** PNG, JPEG, GIF or WebP by its opening bytes; never by the name or type the browser sent. */
function imageExtension(bytes: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (ascii(0, 3) === "GIF") return "gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return undefined;
}

/**
 * A list brought from somewhere without an API (docs/personal-agent.md §9): pasted text (`text`), a CSV export or a screenshot (`file`).
 * It is written under the data directory for the worker to read once and delete (the worker's own routes take only small bodies), then
 * the worker parses it, offers a batch and sorts it in the background.
 */
export async function POST(request: Request) {
  if (isCrossSiteWrite(request)) return Response.json({ ok: false, code: "REQUEST_FORBIDDEN" }, { status: 403 });
  const access = await resolveAccessContext(request);
  if ("response" in access) return access.response;
  const t = tOf(access.ctx);
  const form = await request.formData().catch(() => null);
  const refuse = (message: string) => Response.json({ ok: false, blocker: { code: "IMPORT_UPLOAD_INVALID", message } }, { status: 400 });
  if (!form) return refuse(t("没有读到上传的内容，请重新上传。"));
  const text = form.get("text");
  const file = form.get("file");
  let kind: "text" | "csv" | "image";
  let bytes: Uint8Array;
  let extension: string;
  let name = "";
  if (typeof text === "string" && text.trim()) {
    if (text.length > TEXT_MAX) return refuse(t("粘贴的内容太长，请分几次导入，或上传 CSV。"));
    kind = "text"; bytes = new TextEncoder().encode(text); extension = "txt";
  } else if (file instanceof File) {
    if (file.size > FILE_MAX) return refuse(t("文件太大（上限 8 MB）。"));
    bytes = new Uint8Array(await file.arrayBuffer());
    name = file.name.replace(/\.[^.]+$/, "").slice(0, 60);
    const image = imageExtension(bytes);
    if (image) { kind = "image"; extension = image; }
    else if (/\.csv$/i.test(file.name)) { kind = "csv"; extension = "csv"; }
    else if (/\.(txt|md)$/i.test(file.name)) { kind = "text"; extension = "txt"; }
    else return refuse(t("只能导入 CSV、文本文件或截图（PNG、JPEG）。"));
  } else return refuse(t("没有读到上传的内容，请重新上传。"));
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(access.ctx.workspaceId)) return refuse(t("没有读到上传的内容，请重新上传。"));
  const folder = path.join(dataDirectory(), "imports", access.ctx.workspaceId);
  mkdirSync(folder, { recursive: true });
  const stored = `${randomUUID()}.${extension}`;
  writeFileSync(path.join(folder, stored), bytes);
  return serviceProxy(access.ctx, "/v1/import/file", { method: "POST", timeoutMs: kind === "image" ? 20 * 60_000 : 60_000, body: { file: stored, kind, name } });
}
