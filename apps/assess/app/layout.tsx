import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { LocaleProvider } from "../components/locale-context";
import { LocaleSwitch } from "../components/locale-switch";
import { htmlLang, tFor } from "../lib/i18n";
import { getLocale } from "../lib/locale-server";
import "./assess.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = tFor(await getLocale());
  return {
    title: t("Crossline 速测：你在 AI 时代会是什么样的超级个体"),
    description: t("36 个场景加上你的样子，约 5 分钟，得到一张类型海报：你是哪种 AI 时代超级个体、AI 替你干什么、思想相近的名人和最合拍的搭子。")
  };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F6F2EA" };

/** Every page in the cookie's language, with the 「中文 / EN」 switch at its top right. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return <html lang={htmlLang(locale)}><body><LocaleProvider locale={locale}>
    <div className="as-topbar"><LocaleSwitch /></div>
    {children}
  </LocaleProvider></body></html>;
}
