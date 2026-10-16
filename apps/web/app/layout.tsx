import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./ui.css";
import "./ui/primitives.css";
import "./task/task.css";
import "./chat/composer.css";
import "./milestones/milestones.css";
import "./milestones/flywheel-edges.css";
import "./plan/plan.css";
import "./settings/settings.css";
import "./onboarding/onboarding.css";
import "./portrait/portrait.css";
import "./mobile.css";
import { isLocalInstall } from "../lib/install-mode";
import { PageBeacon } from "./page-beacon";
import { htmlLang, tFor } from "../lib/i18n";
import { getLocale } from "../lib/locale";
import { LocaleProvider } from "./locale-context";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const t = tFor(locale);
  return {
    title: "Crossline",
    description: t("跨人生主线 AI 工作流系统"),
    // The language goes in the address: a manifest is fetched without cookies (manifest.webmanifest/route.ts).
    manifest: locale === "en" ? "/manifest.webmanifest?lang=en" : "/manifest.webmanifest",
    icons: { icon: "/pwa-icon/192", apple: "/pwa-icon/180" },
    // Opened from the home screen it runs full-screen like an app, under its own name.
    appleWebApp: { capable: true, title: "Crossline", statusBarStyle: "default" }
  };
}

/** `viewport-fit=cover` so the bottom tab bar can reach the screen edge and pad itself past the iPhone's home indicator. */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#0A0A0A" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return <html lang={htmlLang(locale)}>
    <body><LocaleProvider locale={locale}>{children}{isLocalInstall() && <PageBeacon />}</LocaleProvider></body>
  </html>;
}
