import { Resvg } from "@resvg/resvg-js";
import { TYPE_GROUPS, TYPE_TABLE } from "@crossline/core/assess";

/**
 * Placeholder templates, until the owner picks real ones (templates/README.md): a flat comic bust in the type group's colour on the
 * group's tint, its four letters drawn as small cues (S neat hair / G tufts, E glasses / I a spark, M a pen / R a speech bubble,
 * P a tie / A hoodie strings), with the code, the name and 「占位图」 printed so nobody mistakes it for the finished art.
 */

const INK = "#24211D";
const PAPER = "#F3EFE6";
const SKIN = "#E8CDB5";

export function placeholderSvg(code: string): string {
  const type = TYPE_TABLE[code];
  const group = TYPE_GROUPS[code.slice(0, 2)];
  if (!type || !group) throw new Error(`AVATAR_TYPE_UNKNOWN: ${code}`);
  const [scope, basis, output, rhythm] = code.split("") as [string, string, string, string];
  const line = `stroke="${INK}" stroke-width="8" stroke-linejoin="round" stroke-linecap="round"`;
  const hair = scope === "S"
    ? `<path d="M372 452 C368 330 452 290 524 296 C606 302 660 350 652 452 C620 400 560 372 470 380 C430 384 396 410 372 452 Z" fill="${INK}"/>`
    : `<path d="M368 456 C350 380 380 330 410 318 L404 282 L452 306 L470 262 L506 300 L540 258 L566 302 L612 276 L604 322 C650 346 666 400 656 456 C610 404 560 388 512 392 C450 396 400 418 368 456 Z" fill="${INK}"/>`;
  const eyes = basis === "E"
    ? `<circle cx="462" cy="478" r="34" fill="none" ${line}/><circle cx="562" cy="478" r="34" fill="none" ${line}/><path d="M496 478 L528 478" ${line}/><circle cx="462" cy="478" r="8" fill="${INK}"/><circle cx="562" cy="478" r="8" fill="${INK}"/>`
    : `<circle cx="462" cy="478" r="9" fill="${INK}"/><circle cx="562" cy="478" r="9" fill="${INK}"/><path d="M712 262 L724 302 L764 314 L724 326 L712 366 L700 326 L660 314 L700 302 Z" fill="${group.colour}"/>`;
  const cue = output === "M"
    ? `<rect x="580" y="812" width="84" height="70" rx="8" fill="${PAPER}" ${line}/><path d="M612 812 L612 760" stroke="${group.tint}" stroke-width="14" stroke-linecap="round"/>`
    : `<path d="M690 330 C690 286 728 262 780 262 C832 262 870 286 870 330 C870 374 832 398 780 398 L752 398 L716 430 L726 394 C704 386 690 360 690 330 Z" fill="${PAPER}" ${line}/>`;
  const collar = rhythm === "P"
    ? `<path d="M452 716 L512 770 L572 716" fill="none" ${line}/><path d="M512 770 L490 806 L512 900 L534 806 Z" fill="${group.tint}" ${line}/>`
    : `<path d="M440 712 C470 760 554 760 584 712" fill="none" ${line}/><path d="M470 752 L466 846" ${line}/><path d="M554 752 L558 846" ${line}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="${group.tint}"/>
  <path d="M212 1024 C212 820 330 704 512 704 C694 704 812 820 812 1024 Z" fill="${group.colour}" ${line}/>
  <rect x="470" y="600" width="84" height="120" fill="${SKIN}" ${line}/>
  ${collar}
  ${cue}
  <ellipse cx="512" cy="470" rx="148" ry="162" fill="${SKIN}" ${line}/>
  ${hair}
  ${eyes}
  <path d="M482 552 C500 568 524 568 542 552" fill="none" ${line}/>
  <rect x="412" y="120" width="200" height="64" rx="32" fill="${INK}"/>
  <text x="512" y="163" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="30" font-weight="700" fill="${PAPER}">占位图</text>
  <rect x="312" y="900" width="400" height="92" rx="46" fill="${PAPER}" ${line}/>
  <text x="512" y="962" text-anchor="middle" font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="44" font-weight="700" fill="${INK}">${code} ${type.name}</text>
</svg>`;
}

/** The placeholder as a 1024×1024 PNG. */
export function renderPlaceholder(code: string): Buffer {
  const resvg = new Resvg(placeholderSvg(code), {
    fitTo: { mode: "width", value: 1024 },
    font: { loadSystemFonts: true, defaultFontFamily: "Microsoft YaHei" }
  });
  return Buffer.from(resvg.render().asPng());
}
