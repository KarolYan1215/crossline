import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./assess.css";

export const metadata: Metadata = {
  title: "Crossline 速测：你怎么同时活好几条线",
  description: "32 道题加上你的样子，约 4–5 分钟，得到一张类型海报：你的思维模式、适合同时推进的 3 条主线和最合拍的搭子。"
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F6F2EA" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
