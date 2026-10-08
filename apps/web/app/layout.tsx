import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./ui.css";
import "./ui/primitives.css";
import "./task/task.css";
import "./chat/composer.css";
import "./mobile.css";

export const metadata: Metadata = {
  title: "Crossline",
  description: "跨人生主线 AI 工作流系统",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/pwa-icon/192", apple: "/pwa-icon/180" },
  // Opened from the home screen it runs full-screen like an app, under its own name.
  appleWebApp: { capable: true, title: "Crossline", statusBarStyle: "default" }
};

/** `viewport-fit=cover` so the bottom tab bar can reach the screen edge and pad itself past the iPhone's home indicator. */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0A0A0A" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN">
    <body>{children}</body>
  </html>;
}
