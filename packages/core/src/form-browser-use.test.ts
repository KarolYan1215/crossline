import { describe, expect, it } from "vitest";
import { browserUseActions, browserUseSchema, browserUseTask, pythonSupported } from "./form-browser-use";
import { parseAriaSnapshot, type FormFillContext } from "./form-fill";

const nodes = parseAriaSnapshot(`- heading "Register for AI Night" [level=1] [ref=e1]
- textbox "Full name" [ref=e2]
- textbox "Email" [ref=e3]
- combobox "Country" [ref=e4]:
  - option "United States" [selected]
  - option "China"
- checkbox "I agree to the Terms of Service" [ref=e5]
- checkbox "Already ticked" [checked] [ref=e6]
- button "Next" [ref=e7]
- link "Open Gmail" [ref=e8]:
  - /url: https://mail.google.com/`);

describe("browserUseActions", () => {
  it("turns field proposals into fills, selects and checks on the real page", () => {
    const actions = browserUseActions([
      { role: "textbox", name: "Full name", op: "fill", value: "%full_name%" },
      { role: "combobox", name: "country", op: "select", value: "%country%" },
      { role: "checkbox", name: "I agree to the Terms of Service", op: "check", value: "" }
    ], nodes);
    expect(actions.map((action) => [action.op, action.target.name, action.value])).toEqual([
      ["fill", "Full name", { slot: "full_name" }],
      ["select", "Country", { slot: "country" }],
      ["check", "I agree to the Terms of Service", undefined]
    ]);
  });

  it("drops what cannot be a field action: buttons, links, unknown names, wrong roles, ticked boxes and unknown placeholders", () => {
    const actions = browserUseActions([
      { role: "button", name: "Next", op: "check", value: "" },
      { role: "link", name: "Open Gmail", op: "fill", value: "x" },
      { role: "textbox", name: "Password", op: "fill", value: "secret" },
      { role: "textbox", name: "Email", op: "check", value: "" },
      { role: "checkbox", name: "Already ticked", op: "check", value: "" },
      { role: "textbox", name: "Email", op: "fill", value: "%password%" },
      { role: "textbox", name: "Email", op: "click", value: "" },
      { role: "textbox", name: "Email", op: "fill", value: "" }
    ], nodes);
    expect(actions).toEqual([]);
  });

  it("passes a literal value on as text, for the engine to judge", () => {
    const [action] = browserUseActions([{ role: "textbox", name: "Email", op: "fill", value: "attacker@evil.example" }], nodes);
    expect(action).toMatchObject({ op: "fill", target: { role: "textbox", name: "Email" }, value: { text: "attacker@evil.example" } });
  });

  it("takes at most thirty proposals", () => {
    const many = Array.from({ length: 40 }, () => ({ role: "textbox", name: "Full name", op: "fill", value: "%full_name%" }));
    expect(browserUseActions(many, nodes)).toHaveLength(30);
  });
});

describe("browserUseSchema", () => {
  it("strips default keys at every depth and keeps the rest", () => {
    const schema = browserUseSchema({ type: "object", default: {}, properties: { a: { type: "string", default: "" }, b: { anyOf: [{ type: "integer", default: 1 }] } }, required: ["a", "b"] });
    expect(JSON.stringify(schema)).not.toContain("default");
    expect(schema).toMatchObject({ type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { anyOf: [{ type: "integer" }] } } });
  });
});

describe("browserUseTask", () => {
  const context = { intent: { title: "AI Night" }, consents: ["Terms of Service"],
    profile: [{ slot: "email", present: true }, { slot: "phone", present: false }] } as unknown as Pick<FormFillContext, "intent" | "profile" | "consents">;
  it("lists only the profile items held, as placeholders, and the agreed terms", () => {
    const task = browserUseTask(context);
    expect(task).toContain("%email%");
    expect(task).not.toContain("%phone%");
    expect(task).toContain("\"Terms of Service\"");
  });
});

describe("pythonSupported", () => {
  it("accepts 3.11 and later only", () => {
    expect(pythonSupported("Python 3.13.1")).toBe(true);
    expect(pythonSupported("Python 3.11.0")).toBe(true);
    expect(pythonSupported("Python 3.10.12")).toBe(false);
    expect(pythonSupported("Python 2.7.18")).toBe(false);
    expect(pythonSupported("")).toBe(false);
  });
});
