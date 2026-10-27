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
    // The installed app's own menu (right-click on its icon): the 小帮手 alone, or Today's box ready to type in. Opened from there it
    // focuses the window already open (`launch_handler`), which takes the target (helper-pet-client.tsx `useLaunchTarget`).
    shortcuts: [
      { name: "打开小帮手", short_name: "小帮手", url: "/helper", icons: [{ src: "/pwa-icon/192", sizes: "192x192", type: "image/png" }] },
      { name: "记一下", url: "/?focus=input", icons: [{ src: "/pwa-icon/192", sizes: "192x192", type: "image/png" }] }
    ],
    launch_handler: { client_mode: ["focus-existing", "auto"] },
    background_color: "#FFFFFF",
    theme_color: "#0A0A0A",
    icons: [
      { src: "/pwa-icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon/512", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

