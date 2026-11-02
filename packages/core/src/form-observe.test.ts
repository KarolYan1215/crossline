import { describe, expect, it } from "vitest";
import { redactSensitive } from "./form-fill";
import { FORM_OBSERVE_SCHEMA, observedActions, observeTree, observeVariables, validateFormObserve } from "./form-observe";
import { structuredOutputProblems } from "./structured-output";

const SNAPSHOT = `- heading "Register for AI Night" [level=1] [ref=e1]
- textbox "Full name" [ref=e2]: Ada Lovelace
- textbox "Phone" [ref=e3]: +1 608 555 0123
- textbox "Company" [ref=e4]
- combobox "Country" [ref=e5]:
  - option "United States" [selected]
  - option "China"
- checkbox "I agree to the Terms of Service" [ref=e6]
- checkbox "Already ticked" [checked] [ref=e7]
- button "Next" [ref=e8]
- link "Open Gmail" [ref=e9]:
  - /url: https://mail.google.com/`;

describe("observeTree", () => {
  const { tree, elements } = observeTree(redactSensitive(SNAPSHOT, [{ slot: "phone", value: "+1 608 555 0123" }]));
  it("never writes a field's value, only whether it is filled", () => {
    expect(tree).not.toContain("Ada Lovelace");
    expect(tree).not.toContain("555");
    expect(tree).toMatch(/\[0-\d+\] textbox: Full name \(filled\)/);
    expect(tree).toMatch(/\[0-\d+\] textbox: Company \(empty\)/);
  });
  it("lists options and checked state, and maps every id back to its element", () => {
    expect(tree).toMatch(/combobox: Country \(selected: United States\) options: United States \| China/);
    expect(tree).toMatch(/checkbox: Already ticked \(checked\)/);
    const id = /\[(0-\d+)\] textbox: Company/.exec(tree)![1]!;
    expect(elements.get(id)).toMatchObject({ role: "textbox", name: "Company" });
  });
});

describe("observeVariables", () => {
  it("names the profile items that hold a value, with empty values", () => {
    const variables = observeVariables([{ slot: "email", present: true, sensitive: false }, { slot: "phone", present: true, sensitive: true }, { slot: "school", present: false, sensitive: false }]);
    expect(Object.keys(variables)).toEqual(["email", "phone"]);
    expect(Object.values(variables).every((variable) => variable.value === "")).toBe(true);
  });
});

describe("observedActions", () => {
  const { tree, elements } = observeTree(SNAPSHOT);
  const idOf = (label: string) => new RegExp(`\\[(0-\\d+)\\] [a-z]+: ${label}`).exec(tree)![1]!;
  it("turns fills, dropdown choices and checkbox clicks into the engine's actions", () => {
    const actions = observedActions([
      { elementId: idOf("Company"), description: "company", method: "fill", arguments: ["Acme"] },
      { elementId: idOf("Full name"), description: "name", method: "type", arguments: ["%full_name%"] },
      { elementId: idOf("Country"), description: "country", method: "selectOptionFromDropdown", arguments: ["%country%"] },
      { elementId: idOf("I agree to the Terms of Service"), description: "terms", method: "click", arguments: [] }
    ], elements);
    expect(actions).toEqual([
      expect.objectContaining({ op: "fill", target: { role: "textbox", name: "Company" }, value: { text: "Acme" } }),
      expect.objectContaining({ op: "fill", target: { role: "textbox", name: "Full name" }, value: { slot: "full_name" } }),
      expect.objectContaining({ op: "select", target: { role: "combobox", name: "Country" }, value: { slot: "country" } }),
      expect.objectContaining({ op: "check", target: { role: "checkbox", name: "I agree to the Terms of Service" } })
    ]);
  });
  it("drops page moves, links, keys, unknown ids, unknown placeholders and already-ticked boxes", () => {
    expect(observedActions([
      { elementId: idOf("Next"), description: "next", method: "click", arguments: [] },
      { elementId: idOf("Open Gmail"), description: "gmail", method: "click", arguments: [] },
      { elementId: idOf("Company"), description: "enter", method: "press", arguments: ["Enter"] },
      { elementId: "0-999", description: "ghost", method: "fill", arguments: ["x"] },
      { elementId: idOf("Company"), description: "secret", method: "fill", arguments: ["%password%"] },
      { elementId: idOf("Already ticked"), description: "ticked", method: "click", arguments: [] }
    ], elements)).toEqual([]);
  });
});

describe("FORM_OBSERVE_SCHEMA", () => {
  it("meets the strict structured-output rules and refuses ids not copied from the tree", () => {
    expect(structuredOutputProblems(FORM_OBSERVE_SCHEMA)).toEqual([]);
    expect(validateFormObserve({ elements: [{ elementId: "12", description: "", method: "fill", arguments: [] }] })).toMatch(/elementId/);
    expect(validateFormObserve({ elements: [] })).toBeUndefined();
  });
});
