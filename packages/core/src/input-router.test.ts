import { expect, test } from "vitest";
import { INPUT_ROUTE_SCHEMA, looksLikeScheduleCommand, structuredOutputProblems, validateRoutedInput } from "./index";

const none = { type: "none" as const, date: "", minutes: 0 };

test("the router's schema follows the strict structured-output rules", () => {
  expect(structuredOutputProblems(INPUT_ROUTE_SCHEMA)).toEqual([]);
});

test("a change to a task that is not open, or a malformed one, falls back to a capture of the same wording", () => {
  const routed = validateRoutedInput({ items: [
    { kind: "schedule", title: "", context: "", workOrderId: "wo-1", change: { type: "due", date: "2026-10-16", minutes: 0 }, summary: "作业 2 截止改为 10/16" },
    { kind: "schedule", title: "", context: "", workOrderId: "ghost", change: { type: "due", date: "2026-10-16", minutes: 0 }, summary: "不存在的任务推迟" },
    { kind: "schedule", title: "", context: "", workOrderId: "wo-1", change: { type: "estimate", date: "", minutes: 2 }, summary: "多给两分钟" },
    { kind: "capture", title: "买电池", context: "", workOrderId: "", change: none, summary: "" }
  ] }, ["wo-1"], "原文");
  expect(routed.items.map((item) => [item.kind, item.kind === "schedule" ? item.change.type : item.title])).toEqual([
    ["schedule", "due"], ["capture", "不存在的任务推迟"], ["capture", "多给两分钟"], ["capture", "买电池"]]);
});

test("nothing usable keeps the whole text as one capture", () => {
  expect(validateRoutedInput({ items: [] }, [], "把复习挪到周五").items).toEqual([
    { kind: "capture", title: "把复习挪到周五", context: "", workOrderId: "", change: none, summary: "" }]);
});

test("only instruction-like wording is sent to the router", () => {
  expect(looksLikeScheduleCommand("把作业 2 推到周五")).toBe(true);
  expect(looksLikeScheduleCommand("复习多给一小时")).toBe(true);
  expect(looksLikeScheduleCommand("读完 Sze 第三章")).toBe(false);
});
