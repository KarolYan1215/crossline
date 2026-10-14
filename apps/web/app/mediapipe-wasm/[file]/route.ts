import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The MediaPipe vision runtime for 摄像头精力采样, served from the installed package rather than copied into `public` (26 MB of wasm
 * kept out of the repository), and its module loaded by the browser itself — bundled, its own dynamic import of the wasm loader was
 * rewritten and failed. Only these five files, by name; nothing else under node_modules is reachable.
 */
const FILES: Record<string, string> = {
  "vision_bundle.mjs": "text/javascript",
  "vision_wasm_internal.js": "text/javascript", "vision_wasm_internal.wasm": "application/wasm",
  "vision_wasm_nosimd_internal.js": "text/javascript", "vision_wasm_nosimd_internal.wasm": "application/wasm"
};

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const type = FILES[file];
  if (!type) return new Response("Not found", { status: 404 });
  // A plain path, not require.resolve: the bundler turns that into a module id. The web app runs from its own directory.
  const root = path.join(process.cwd(), "node_modules", "@mediapipe", "tasks-vision");
  const body = await readFile(file.endsWith(".mjs") ? path.join(root, file) : path.join(root, "wasm", file));
  return new Response(new Uint8Array(body), { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
}
