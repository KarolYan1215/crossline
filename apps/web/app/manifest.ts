import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Crossline",
    short_name: "Crossline",
    description: "跨人生主线精力与工作流系统",
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
}

