import { ImageResponse } from "next/og";

/** The sizes a phone asks for: the iOS home-screen icon (180) and the manifest's two (192, 512). */
const SIZES = new Set([180, 192, 512]);
const LINES = ["#1F5FA8", "#A8551F", "#7A3FA0", "#1E7A4C", "#8A6D1F"];

/**
 * The app icon, drawn rather than shipped as a binary: a "C" on ink with the five line colours under it. Without one, iOS put a
 * screenshot of whatever page was open on the home screen and the manifest listed no icon at all, so "Add to Home Screen" did
 * not produce an installable app.
 */
export async function GET(_request: Request, context: { params: Promise<{ size: string }> }) {
  const size = Number((await context.params).size);
  if (!SIZES.has(size)) return new Response("not found", { status: 404 });
  const bar = Math.round(size * 0.07);
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0A0A0A" }}>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#FFFFFF",
        fontSize: Math.round(size * 0.62), fontWeight: 700, lineHeight: 1 }}>C</div>
      <div style={{ display: "flex", height: bar, width: "100%" }}>
        {LINES.map((color) => <div key={color} style={{ flex: 1, background: color }} />)}
      </div>
    </div>,
    { width: size, height: size, headers: { "cache-control": "public, max-age=604800, immutable" } }
  );
}
