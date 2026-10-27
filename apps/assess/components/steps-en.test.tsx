import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { QUIZ_ITEMS } from "@crossline/core/assess";
import "../lib/i18n";
import { appearanceProblem, emailProblem, emptyFlow, errorMessage, wantsProblem } from "../lib/flow";
import { publicType } from "../lib/public-type";
import { AppearanceStep } from "./appearance-step";
import { EmailStep } from "./email-step";
import { LocaleProvider } from "./locale-context";
import { SavableImage } from "./poster";
import { QuizStep } from "./quiz-step";
import { AiAndKindred, AxesList, DimensionNotes, TypeDetails, TypeHeading } from "./type-summary";
import { WantsStep } from "./wants-step";

const noop = () => {};
const english = (node: ReactNode) => renderToStaticMarkup(<LocaleProvider locale="en">{node}</LocaleProvider>);
const HAN = /[㐀-鿿]/;

test("a situation screen in English: the situation and its two options rewritten for English readers, the five answers and the controls", () => {
  const flow = { ...emptyFlow(), step: "quiz" as const, startedAt: 0, index: 0, answers: { q1: 4 } };
  const html = english(<QuizStep flow={flow} onChoose={noop} onBack={noop} onNext={noop} />);
  expect(html).toContain("Write a long article");
  expect(html).toContain("Outline it yourself, then hand each section to AI to write");
  expect(html).toContain(" / 36 · Writing");
  expect(html).toContain("Clearly A");
  expect(html).toContain("1 of 36 answered");
  expect(html).toContain("Keyboard: press 1–5 to answer");
  expect(html).not.toMatch(HAN);
  // The same screen with no provider is Chinese, as before.
  expect(renderToStaticMarkup(<QuizStep flow={flow} onChoose={noop} onBack={noop} onNext={noop} />)).toContain(QUIZ_ITEMS[0]!.text);
});

test("the appearance, email and wants steps in English carry no Chinese", () => {
  const steps = [
    english(<AppearanceStep draft={{ note: "" }} onChange={noop} onBack={noop} onNext={noop} />),
    english(<EmailStep fields={{ email: "", nickname: "", sendEmail: true, website: "" }} problems={{ email: null, nickname: null }} error={null} busy={false}
      invited={false} onChange={noop} onSubmit={noop} onBack={noop} />),
    english(<WantsStep wants={{ picks: ["media"], text: "" }} busy={false} error={null} onChange={noop} onSubmit={noop} onSkip={noop} />)
  ];
  for (const html of steps) expect(html).not.toMatch(HAN);
  expect(steps[0]).toContain("Roughly what do you look like?");
  expect(steps[1]).toContain("Email me the link to my result");
  expect(steps[1]).toContain("One email address can take the test up to 3 times");
  expect(steps[2]).toContain("Coding and products");
  expect(steps[2]).toContain("0 / 120");
});

test("the result's type and details in English, built in English by the server and labelled in English here", () => {
  const type = publicType({ collab: 20, purpose: 20, build: 80, lines: 80 }, {}, "seed", undefined, ["写初稿"], "en");
  const html = english(<><TypeHeading type={type} /><AxesList type={type} /><DimensionNotes /><AiAndKindred type={type} /><TypeDetails type={type} /></>);
  expect(html).toContain("Time Management Guru");
  expect(html).toContain("Galaxy 80%");
  expect(html).toContain("Where the four dimensions come from");
  expect(html).toContain("first drafts");
  expect(html).toContain("Richard Branson");
  expect(html).toContain("ahead of about");
  expect(html).toContain("You might try");
  expect(html).toContain("Best partner:");
  expect(html).not.toMatch(HAN);
});

test("the poster's save and download labels in English", () => {
  const html = english(<SavableImage src="/p.png" alt="Poster" width={1080} height={1440} downloadName="p.png"
    extra={{ src: "/l.png", label: "long image", downloadName: "l.png" }} />);
  expect(html).toContain("Press and hold the image to save it");
  expect(html).toContain("Download poster");
  expect(html).toContain("Download long image");
});

test("the test's messages in English, Chinese unchanged", () => {
  expect(errorMessage("EMAIL_LIMIT_REACHED", "en")).toContain("already taken the test 3 times");
  expect(errorMessage("WANTS_INVALID", "en")).toContain("up to 120 characters");
  expect(errorMessage("WANTS_INVALID")).toContain("最多 60 个字");
  expect(errorMessage("UNKNOWN_CODE", "en")).toBe("Something went wrong. Try again later.");
  expect(appearanceProblem({ note: "" }, "en")).toBe("Still missing: Gender presentation, Hair, Glasses, Skin tone, Clothing style");
  expect(emailProblem("", "en")).toBe("Enter your email");
  expect(wantsProblem({ picks: ["media"], text: "x".repeat(61) }, "en")).toBeNull();
  expect(wantsProblem({ picks: ["media"], text: "x".repeat(121) }, "en")).toBe("Up to 120 characters");
});
