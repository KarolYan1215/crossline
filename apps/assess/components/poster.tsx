/**
 * A server-rendered PNG shown as a plain <img>: inside WeChat's browser a download link does nothing and a script cannot save a file,
 * but a long press on an image served from a real https address offers 「保存图片」. Phones get that hint; a mouse gets real downloads.
 * Which one shows is decided by CSS (`pointer: coarse`), so the server render and the browser agree.
 */
export function SavableImage({ src, alt, width, height, downloadName, label = "海报", extra }: {
  src: string; alt: string; width: number; height: number; downloadName: string; label?: string;
  /** A second image offered beside it (the long image): a download on desktop, a link to open and long-press on a phone. */
  extra?: { src: string; label: string; downloadName: string } | undefined;
}) {
  return <div className="as-savable">
    <figure className="as-poster">
      {/* eslint-disable-next-line @next/next/no-img-element -- a plain image is what a long press can save */}
      <img src={src} alt={alt} width={width} height={height} />
    </figure>
    <p className="as-hint as-only-touch">长按图片保存，或直接发给朋友{extra ? <>　·　<a href={extra.src} target="_blank" rel="noopener">打开{extra.label}</a></> : null}</p>
    <div className="as-row as-only-mouse">
      <a className="as-button" href={src} download={downloadName}>下载{label}</a>
      {extra && <a className="as-button" href={extra.src} download={extra.downloadName}>下载{extra.label}</a>}
    </div>
  </div>;
}

/** A cache-buster for an image that is redrawn under the same address; inline placeholders are left alone. */
export const withVersion = (url: string, version: number): string =>
  !version || url.startsWith("data:") ? url : `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
