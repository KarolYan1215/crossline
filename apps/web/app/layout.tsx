import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@fontsource/archivo-black/400.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/600.css";
// 700 is the reference sheet's body-bold weight; 600 rendered the ink headings visibly lighter.
import "@fontsource/noto-sans-sc/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crossline",
  description: "跨人生主线 AI 工作流系统",
  manifest: "/manifest.webmanifest"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN" className={`${GeistSans.variable} ${GeistMono.variable}`}>
    <body className={GeistSans.className}>{children}</body>
  </html>;
}
