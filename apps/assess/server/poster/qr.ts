import QRCode from "qrcode";

/**
 * A QR code as an SVG data URI, one path of square modules with crisp edges, so resvg draws it sharp at any size. Error correction M
 * (15%): the link is short, and M keeps the modules large enough to scan off a phone screen or a printed poster. The light colour is
 * transparent; the poster's paper round it is the quiet zone.
 */
export function qrDataUri(text: string, dark: string): { uri: string; modules: number } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = modules.size;
  let d = "";
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="${dark}" d="${d}"/></svg>`;
  return { uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, modules: size };
}
