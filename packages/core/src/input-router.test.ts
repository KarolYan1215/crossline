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
    { kind: "capture", title: "把复习挪到周五", context: "", workOrderId: "", change: none, summary: "", opId: "", lineId: "", date: "", energy: "" }]);
});

test("taking something back names a recent operation, or none, and is never filed as new work", () => {
  const items = validateRoutedInput({ items: [
    { kind: "undo", title: "", context: "", workOrderId: "", change: none, summary: "撤销不等了", opId: "op-a" },
    { kind: "undo", title: "", context: "", workOrderId: "", change: none, summary: "撤销不存在的", opId: "op-x" }
  ] }, [], "撤销刚刚的不等了", ["op-a"]).items;
  expect(items.map((item) => [item.kind, item.opId])).toEqual([["undo", "op-a"], ["undo", ""]]);
  expect(looksLikeScheduleCommand("撤销刚刚的不等了")).toBe(true);
});

test("only instruction-like wording is sent to the router", () => {
  expect(looksLikeScheduleCommand("把作业 2 推到周五")).toBe(true);
  expect(looksLikeScheduleCommand("复习多给一小时")).toBe(true);
  expect(looksLikeScheduleCommand("读完 Sze 第三章")).toBe(false);
});

test("goals and milestones need a known line, a new line a short noun, a record a task or an energy; otherwise they are captures", () => {
  const blank = { title: "", context: "", workOrderId: "", change: none, summary: "", opId: "", lineId: "", date: "", energy: "" };
  const items = validateRoutedInput({ items: [
    { ...blank, kind: "goal", title: "成为能独立带项目的研究者", lineId: "research" },
    { ...blank, kind: "goal", title: "成为跑完全马的跑者", lineId: "ghost" },
    { ...blank, kind: "milestone", title: "投出第一篇论文", lineId: "research", date: "2026-12-01" },
    { ...blank, kind: "milestone", title: "期末考到 A", lineId: "research", date: "下周" },
    { ...blank, kind: "line", title: "跑者" },
    { ...blank, kind: "record", title: "今天很累", energy: "low" },
    { ...blank, kind: "record", title: "第三题卡住了", workOrderId: "wo-1" },
    { ...blank, kind: "record", title: "开会很顺利" },
    { ...blank, kind: "question", title: "这周还有多少空闲？" }
  ] }, ["wo-1"], "原文", [], ["research"]).items;
  expect(items.map((item) => [item.kind, item.title, item.lineId || item.workOrderId || item.energy, item.date])).toEqual([
    ["goal", "成为能独立带项目的研究者", "research", ""], ["capture", "成为跑完全马的跑者", "", ""],
    ["milestone", "投出第一篇论文", "research", "2026-12-01"], ["milestone", "期末考到 A", "research", ""],
    ["line", "跑者", "", ""], ["record", "今天很累", "low", ""], ["record", "第三题卡住了", "wo-1", ""], ["capture", "开会很顺利", "", ""],
    ["question", "这周还有多少空闲？", "", ""]]);
  expect(looksLikeScheduleCommand("长期目标：成为能独立带项目的研究者")).toBe(true);
  expect(looksLikeScheduleCommand("这周还有多少空闲？")).toBe(true);
  expect(looksLikeScheduleCommand("今天很累")).toBe(true);
});
