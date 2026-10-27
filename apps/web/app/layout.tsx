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

/**
 * Every view is a full page load (the back link and the saved scroll position rely on it), and on the hosted beta a page costs one
 * round trip to Hong Kong plus its render, 0.4–1.3 s measured from Chicago (2026-10-27). Chromium fetches a view's page while the pointer
 * rests on its link (`moderate`: about 200 ms of hover, or a press), so the click usually finds it already here. Prefetch only, never
 * prerender: a prerendered page would run its scripts (presence, the day's opener) for a page the person may not open. Other browsers
 * ignore the rules. Pages with a side effect on open (`/return`, `/confirm`) are not listed.
 */
const SPECULATION_RULES = JSON.stringify({ prefetch: [{ eagerness: "moderate", where: { or: [
  "/", "/milestones", "/plan", "/workbench", "/workbench/*", "/approvals", "/settings", "/review", "/portrait"
].map((path) => ({ href_matches: path })) } }] });

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN">
    <body>{children}{isLocalInstall() && <PageBeacon />}
      <script type="speculationrules" dangerouslySetInnerHTML={{ __html: SPECULATION_RULES }} />
    </body>
  </html>;
}
