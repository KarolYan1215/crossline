import fs from "node:fs";
import { avatarImagePath, avatarStatus } from "../../../../server/avatar";
import { imageType } from "../../../../server/avatar/provider";
import { getResultByInvite } from "../../../../server/store";

/**
 * GET /api/avatar/<inviteToken>.png — a result's figure: the drawn PNG once it is ready, else the type's template; 404 for anything
 * else. Keyed by the invitation token (printed on the poster), never the result token. A `?v=` address names one drawn file and may be
 * cached for good; the bare address changes from template to drawn figure, so it is revalidated every time.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILE = /^([A-Za-z0-9_-]{8,128})\.png$/;

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

export async function GET(request: Request, context: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await context.params;
  const token = FILE.exec(file)?.[1];
  const result = token ? getResultByInvite(token) : undefined;
  if (!result) return notFound();
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(avatarImagePath(result));
  } catch {
    return notFound();
  }
  const versioned = new URL(request.url).searchParams.has("v") && avatarStatus(result).state === "ready";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": imageType(bytes) ?? "application/octet-stream",
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex"
    }
  });
}
