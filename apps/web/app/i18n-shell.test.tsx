import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { tFor } from "../lib/i18n";
import { LocaleProvider } from "./locale-context";
import { LoginForm } from "./login/login-form";
import { AuthLayout } from "./login/auth-layout";
import { LOGIN_SERIF } from "./ui/serif-strings";
import { ScheduleSummary } from "./schedule-summary";
import { BottomNav } from "./bottom-nav";
import { AppShell } from "./app-shell";
import { DashboardView, type DashboardData } from "./dashboard-view";
import { authErrorMessage } from "./auth-errors";
import { dayLabel, formatMinutes } from "./ui/controls";
import { previewText } from "./helper-state";
import type { ScheduleChange } from "../lib/crossline";

/** The shared frame and the ways in, switched to English (docs/i18n.md); with no locale everything stays Chinese (the other tests). */
const en = (node: React.ReactNode) => renderToStaticMarkup(<LocaleProvider locale="en">{node}</LocaleProvider>);

describe("the shell in English", () => {
  test("the sign-in form", () => {
    const html = en(<LoginForm googleEnabled emailEnabled />);
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Email code");
    expect(html).toContain("Send code");
    expect(html).not.toMatch(/[一-龥]/);
  });

  test("every way in carries the language switch, and its heading leaves the Chinese-only serif in English", () => {
    const html = en(<AuthLayout title={LOGIN_SERIF.signup} locale="en"><p /></AuthLayout>);
    expect(html).toContain("locale-switch");
    expect(html).toContain("Sign up");
    expect(html).toContain("Your life&#x27;s tracks, on one calendar");
    expect(html).toContain(">Mon<");
    expect(html).not.toContain("login-tagline pt-serif");
    // The switch itself is written in the language it switches to: 「中文」, 「切换到中文」.
    expect(html.replace(/切换到中文|中文/g, "")).not.toMatch(/[一-龥]/);
    // Chinese keeps the serif.
    expect(renderToStaticMarkup(<AuthLayout title={LOGIN_SERIF.signup}><p /></AuthLayout>)).toContain("login-tagline pt-serif");
  });

  test("every signed-in frame carries the language switch, the interview's focus frame too", () => {
    // The ordinary frame: the four views, the side items and the switch.
    const page = en(<AppShell active="今日" corner={false} banner={false}><p /></AppShell>);
    expect(page).toMatch(/running-head.*locale-switch/s);
    expect(page).toContain(">Today<");
    // The interview before the start standard (`focus`): no working view, only Settings — and still the switch, kept in the header on a
    // phone too since that frame has no bottom bar (`data-focus`, mobile.css).
    const focus = en(<AppShell focus><p /></AppShell>);
    expect(focus).toMatch(/running-head[^>]*data-focus.*locale-switch/s);
    expect(focus).toContain(">Settings<");
    expect(focus).not.toContain(">Today<");
    expect(focus).not.toContain("bottom-nav");
  });

  test("on a phone the language switch stays in the header, not under More (2026-10-28)", () => {
    const html = en(<BottomNav active="今日" />);
    expect(html).toContain("More");
    expect(html).not.toContain("locale-switch");
  });

  test("a schedule change reads as one English sentence", () => {
    const html = en(<ScheduleSummary changes={[{ blockId: "scheduled:hw3", title: "HW 3", day: "2026-10-13", from: { start: "11:00", end: "12:00" },
      to: { day: "2026-10-13", start: "11:30", end: "12:30" }, cause: "11:30 Sync up" }]} />);
    expect(html).toContain("&quot;HW 3&quot; moved 30 min later because of 11:30 Sync up");
    expect(html).toContain("Pin back");
  });

  test("folded schedule lines stay one English sentence each, names drawn inside them", () => {
    const hw3: ScheduleChange = { blockId: "scheduled:hw3", title: "HW 3", day: "2026-10-13", from: { start: "11:00", end: "12:00" },
      to: { day: "2026-10-13", start: "11:30", end: "12:30" }, cause: "11:30 Sync up" };
    const text = (node: React.ReactNode) => en(node).replace(/<[^>]+>/g, "");
    expect(text(<ScheduleSummary changes={[hw3, { ...hw3, blockId: "scheduled:hw3:2" }]} />))
      .toContain("2 blocks of &quot;HW 3&quot; moved 30 min later because of 11:30 Sync up");
    const splits = ["A", "B", "C", "D"].map((title) => ({ orderId: title, title, step: "", days: 2 }));
    expect(text(<ScheduleSummary changes={[]} splits={splits} />))
      .toContain("4 steps went undone for 2 days, so they have been split into smaller steps; the first takes 15 min at most: &quot;A&quot;, &quot;B&quot;, &quot;C&quot; (4 in all)");
  });

  test("Today's head and empty state", () => {
    const html = renderToStaticMarkup(<LocaleProvider locale="en"><DashboardView data={{
      locale: "en", principalId: "o", workspaceId: "w", nowLabel: "Mon · 09:00", nowIso: "2026-09-14T14:00:00.000Z", timeZone: "America/Chicago", clockPinned: true,
      dateLabel: "14", monthLabel: "SEP · 2026", awaitingApproval: 1,
      capacity: { level: "uncalibrated", observationCount: 0, basis: [], blockers: [] },
      progress: { streakDays: 0, weekCount: 3 }, care: [], identities: [], upcoming: [], milestonePulse: [], todayCapacity: { availableMinutes: 120, committedMinutes: 30 },
      flywheel: [], flywheelStrip: { nodes: [], edges: [] }, taskDetailById: new Map(), milestoneDetailById: new Map()
    } as DashboardData} /></LocaleProvider>);
    expect(html).toContain("Energy not calibrated");
    expect(html).toContain("2 h");
    expect(html).toContain("30 min");
    expect(html).toContain("At a glance");
    expect(html).toContain("3 tasks");
    expect(html).toContain("proposal awaits approval");
    expect(html).toContain("0 things to handle");
  });
});

describe("helpers the other pages call, in English", () => {
  test("durations and days", () => {
    expect(formatMinutes(45, "en")).toBe("45 min");
    expect(formatMinutes(90, "en")).toBe("1 h 30 min");
    expect(formatMinutes(120, "en")).toBe("2 h");
    expect(formatMinutes(90)).toBe("1 时 30 分");
    expect(dayLabel("2026-10-19", "en")).toBe("10/19 Mon");
    expect(dayLabel("2026-10-19")).toBe("10/19 周一");
  });

  test("sign-in errors", () => {
    expect(authErrorMessage({ code: "INVALID_OTP" }, "x", tFor("en"))).toBe("Wrong code.");
    expect(authErrorMessage({ code: "INVALID_OTP" }, "x")).toBe("验证码不正确。");
  });

  test("the helper's bubble closes an English quote the way it closes 「」", () => {
    expect(previewText("Undo it under \"Recently applied\" on Decisions", 22)).toBe("Undo it under \"Recent…\"");
    expect(previewText("Undo it under \"Recently applied\" on Decisions", 16)).toBe("Undo it under…");
    expect(previewText("Undo it under “Recently applied” on Decisions", 22)).toBe("Undo it under “Recent…”");
  });
});
