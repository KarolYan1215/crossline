import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./ui.css";

export const metadata: Metadata = {
  title: "Crossline",
  description: "跨人生主线 AI 工作流系统",
  manifest: "/manifest.webmanifest"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN">
    <body>{children}</body>
  </html>;
}
