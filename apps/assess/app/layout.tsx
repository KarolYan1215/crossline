import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./assess.css";

export const metadata: Metadata = {
  title: "Crossline 速测：你在 AI 时代会是什么样的超级个体",
  description: "36 个场景加上你的样子，约 5 分钟，得到一张类型海报：你是哪种 AI 时代超级个体、AI 替你干什么、思想相近的名人和最合拍的搭子。"
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F6F2EA" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
