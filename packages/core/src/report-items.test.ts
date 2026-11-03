import { expect, test } from "vitest";
import { readReportItems, REPORT_ITEMS_MAX } from "./report-items";

test("a report's items keep only well-formed actions and only the person's own lines", () => {
  const raw = JSON.stringify([
    { title: "把三篇早餐笔记做成一周菜单", why: "「早餐」话题里三篇都讲备餐", topic: "早餐", lineId: "line-wellness" },
    { title: "未知主线的动作", why: "x", topic: "t", lineId: "evil" },
    { title: "", why: "空标题" },
    { title: "长".repeat(41), why: "太长" },
    { title: "把三篇早餐笔记做成一周菜单", why: "重复" },
    "not an object", null
  ]);
  expect(readReportItems(raw, ["line-wellness"])).toEqual([
    { title: "把三篇早餐笔记做成一周菜单", why: "「早餐」话题里三篇都讲备餐", topic: "早餐", lineId: "line-wellness" },
    { title: "未知主线的动作", why: "x", topic: "t", lineId: "" }
  ]);
});

test("an object with items, a byte order mark, too many items and not JSON", () => {
  const many = Array.from({ length: 12 }, (_, n) => ({ title: `动作 ${n}`, why: "", topic: "", lineId: "" }));
  expect(readReportItems(`﻿${JSON.stringify({ items: many })}`, [])).toHaveLength(REPORT_ITEMS_MAX);
  expect(readReportItems("{not json", [])).toEqual([]);
  expect(readReportItems("42", [])).toEqual([]);
});
