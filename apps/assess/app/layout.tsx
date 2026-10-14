import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./assess.css";

export const metadata: Metadata = {
  title: "Crossline 速测：思维模式与精力节律",
  description: "16 道题的思维模式类型、精简版慕尼黑时型问卷和 3 分钟反应测试。全部在浏览器里计算，不上传任何数据。"
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F6F2EA" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
