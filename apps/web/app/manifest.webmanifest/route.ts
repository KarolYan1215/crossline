import type { MetadataRoute } from "next";
import { isLocale, tFor, type Locale } from "../../lib/i18n";
import { getLocale } from "../../lib/locale";

/**
 * The installable app's manifest, in the page's language (docs/i18n.md). A browser fetches a manifest without cookies unless the link
 * says `use-credentials`, so the layout names the language in the address (`?lang=en`); the cookie is only the fallback.
 */
export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams.get("lang");
  const locale: Locale = isLocale(asked) ? asked : await getLocale();
  const t = tFor(locale);
  const manifest: MetadataRoute.Manifest = {
    name: "Crossline",
    short_name: "Crossline",
    description: t("跨人生主线精力与工作流系统"),
    lang: locale === "en" ? "en" : "zh-CN",
    start_url: "/",
    display: "standalone",
    // The phone's share sheet lands in Today's box (Android; iOS has no web share target): the shared title, text and link are
    // put in the box for the person to send, nothing is written until they do.
    share_target: { action: "/", method: "GET", params: { title: "share_title", text: "share_text", url: "share_url" } },
    background_color: "#FFFFFF",
    theme_color: "#0A0A0A",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
}
