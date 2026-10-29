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
import { headers } from "next/headers";

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

/**
 * The views (the header, the bottom bar, a task's full page, the back link) move in the page since 2026-10-28 (`NavLink`), each fetched
 * while the pointer rests on its link. What is still an ordinary link to a view — a task's page linked from a list, the weekly review —
 * is fetched by Chromium as a document while the pointer rests on it (`moderate`: about 200 ms of hover, or a press), so the click
 * usually finds it already here; the views' own links (`data-soft`) are left out, since their page is fetched in the page instead.
 * Prefetch only, never prerender: a prerendered page would run its scripts (presence, the day's opener) for a page the person may not
 * open. Other browsers ignore the rules. Pages with a side effect on open (`/return`, `/confirm`) are not listed. The pages are
 * Measured in Chrome on 2026-10-28: a hovered task link is served from the prefetch (`deliveryType` 「navigational-prefetch」) with the
 * pages' `private, no-cache` and with Next's old `no-store` alike; the miss in W-129 was the app's built-in browser pane.
 */
const SPECULATION_RULES = JSON.stringify({ prefetch: [{ eagerness: "moderate", where: { and: [
  { or: ["/", "/milestones", "/plan", "/workbench", "/workbench/*", "/approvals", "/settings", "/review", "/portrait"].map((path) => ({ href_matches: path })) },
  { not: { selector_matches: "[data-soft]" } }
] } }] });

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  // The page's nonce (proxy.ts): without it the rules would be inline script the policy refuses. None in `local` mode, where no policy is sent.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <html lang={htmlLang(locale)}>
    <body><LocaleProvider locale={locale}>{children}{isLocalInstall() && <PageBeacon />}</LocaleProvider>
      <script type="speculationrules" nonce={nonce} dangerouslySetInnerHTML={{ __html: SPECULATION_RULES }} />
    </body>
  </html>;
}
