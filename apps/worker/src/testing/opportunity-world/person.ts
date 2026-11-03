import { AVAILABILITY_SETTING, RUNTIME_OWNER_SETTING } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { LINE_SETTING } from "@crossline/identity-packs";
import { PERSON_ZONE, type CalendarBlock, type MailMessage } from "./world";

/**
 * A fictional person for the synthetic world (§17.9 ③): Qiao Lin, a second-year PhD student in computer engineering at the fictional
 * Lakeshore University in Madison, Wisconsin, a Chinese citizen on a student visa, with three lines — research, a hardware startup and
 * technical writing — each with a long-term goal and milestones, a weekly class, movable work blocks and a trip to Boston in mid
 * November. Every value is invented. `PersonFacts` holds the few facts a counterfactual pair flips; everything else is fixed.
 */
export type PersonFacts = {
  citizenship: string;
  /** The country the person lives in (`apply.country`, the eligibility `region`). */
  country: string;
  /** The confirmed home city (`residence`), the default place on any day (§17.6). */
  residence: string;
  degreeStage: string;
  age: number;
  /** The Boston trip of 16–19 November: on the calendar (flight, hotel) and in a hotel confirmation mail. */
  trip: boolean;
  /** The fixed ECE 901 lecture, Tuesdays and Thursdays 14:30–15:45. */
  lecture: boolean;
};

export const BASE_PERSON: PersonFacts = {
  citizenship: "China", country: "United States", residence: "Madison, Wisconsin, United States", degreeStage: "PhD student (second year)", age: 27,
  trip: true, lecture: true
};

export const LINES = [
  { id: "research", label: "研究者", goal: "成为做机器学习系统硬件的研究者", goalParts: ["做机器学习系统硬件"] },
  { id: "startup", label: "创始人", goal: "成为能把研究做成产品的硬件创始人", goalParts: ["能把研究做成产品"] },
  { id: "media", label: "作者", goal: "成为写清楚计算机体系结构的科普作者", goalParts: ["写清楚计算机体系结构"] }
] as const;

/** Milestones per line; the research submission is the one the 60-day run completes (§17.4). */
export const MILESTONES = [
  { id: "ms-research-edgeaccel", lineId: "research", title: "EdgeAccel 2026 论文投稿", deadline: "2026-11-20" },
  { id: "ms-research-intern", lineId: "research", title: "2027 暑期研究实习录用", deadline: "2027-03-15" },
  { id: "ms-startup-interviews", lineId: "startup", title: "完成 10 位潜在用户访谈", deadline: "2026-12-15" },
  { id: "ms-media-posts", lineId: "media", title: "发布 4 篇体系结构科普文章", deadline: "2026-12-31" }
] as const;

const LECTURE_DAYS = ["2026-11-03", "2026-11-05", "2026-11-10", "2026-11-12", "2026-11-17", "2026-11-19", "2026-11-24", "2026-12-01", "2026-12-03"];

/** The person's calendar: the lecture (fixed), work blocks the scheduler placed (movable) and, with the trip, its flights and hotel. */
export function personCalendar(facts: PersonFacts): CalendarBlock[] {
  const blocks: CalendarBlock[] = [];
  if (facts.lecture) for (const day of LECTURE_DAYS) blocks.push({ id: `graph_calendar:ece901:${day}`, title: "ECE 901 Lecture",
    start: `${day}T14:30:00-06:00`, end: `${day}T15:45:00-06:00`, fixed: true, location: "Engineering Hall 2534, Madison, WI" });
  blocks.push({ id: "scheduled:wo-paper:s3", title: "写 EdgeAccel 论文实验部分", start: "2026-11-04T09:00:00-06:00", end: "2026-11-04T11:30:00-06:00", fixed: false });
  blocks.push({ id: "scheduled:wo-interviews:s1", title: "整理用户访谈提纲", start: "2026-11-12T16:00:00-06:00", end: "2026-11-12T17:30:00-06:00", fixed: false });
  if (facts.trip) {
    blocks.push({ id: "graph_calendar:flight-out", title: "Flight UA 512 MSN → BOS", start: "2026-11-16T07:10:00-06:00", end: "2026-11-16T11:40:00-05:00", fixed: true,
      location: "Boston Logan International Airport, Boston, MA" });
    blocks.push({ id: "graph_calendar:hotel", title: "Hotel: The Charles Hotel", start: "2026-11-16T15:00:00-05:00", end: "2026-11-19T11:00:00-05:00", fixed: true,
      location: "1 Bennett St, Cambridge, MA" });
    blocks.push({ id: "graph_calendar:flight-back", title: "Flight UA 513 BOS → MSN", start: "2026-11-19T18:05:00-05:00", end: "2026-11-19T20:20:00-06:00", fixed: true,
      location: "Dane County Regional Airport, Madison, WI" });
  }
  return blocks;
}

/** Travel mail (§17.6 source 3): the hotel confirmation, quotable. */
export function travelMail(facts: PersonFacts): MailMessage[] {
  return facts.trip ? [{ key: "mail-hotel", lineId: "", kind: "travel", from: "reservations@charleshotel.example",
    subject: "Your reservation at The Charles Hotel is confirmed",
    text: "Dear Qiao Lin, your reservation is confirmed. Check-in: Monday, November 16, 2026. Check-out: Thursday, November 19, 2026. The Charles Hotel, 1 Bennett St, Cambridge, MA 02138.",
    url: "", at: "2026-10-20T15:00:00.000Z" }] : [];
}

/**
 * Seeds the person into an empty workspace: the owner mark (the agent runs only there), zone and locale, lines with goals, milestones
 * with deadlines, availability, and confirmed facts — the person's `apply.*` profile plus residence and citizenship. Returns the owner id.
 */
export function seedPerson(store: CrosslineStore, workspaceId: string, facts: PersonFacts, now: Date): string {
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  const at = now.toISOString();
  store.setSetting(workspaceId, RUNTIME_OWNER_SETTING, "1");
  store.setSetting(workspaceId, "schedule.preferences", JSON.stringify({ timeZone: PERSON_ZONE }));
  store.setSetting(workspaceId, "locale", "zh");
  store.setSetting(workspaceId, LINE_SETTING, JSON.stringify(LINES.map((line, index) => ({ id: line.id, label: line.label, color: line.id, goal: line.goal,
    goals: [line.goal], goalParts: [...line.goalParts], createdAt: "2026-09-01T00:00:00.000Z", rank: index + 1 }))));
  store.setSetting(workspaceId, AVAILABILITY_SETTING, JSON.stringify([
    { days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" },
    { days: [1, 2, 3, 4, 5], start: "13:00", end: "21:00", energy: "medium" },
    { days: [6], start: "10:00", end: "16:00", energy: "medium" }
  ]));
  for (const milestone of MILESTONES) {
    store.saveMilestone({ id: milestone.id, ownerId, workspaceId, identityId: milestone.lineId, title: milestone.title, version: 1, status: "approved" });
    store.saveMilestoneAnchor({ workspaceId, milestoneId: milestone.id, stage: 1, deadline: milestone.deadline, baseline: "", target: milestone.title, stakeholders: [],
      sourceFactIds: [], dependsOn: [], updatedAt: at, outputs: [], inputs: [] });
  }
  const fact = (identityId: string, slot: string, value: string) => store.upsertProfileFact({ workspaceId, identityId, projectId: "", slot, value,
    status: "confirmed", sourceRef: "reply-1", sourceQuote: value, updatedAt: at });
  fact("person", "apply.full_name", "Qiao Lin");
  fact("person", "apply.email", "qiao.lin@lakeshore.example");
  fact("person", "apply.school", "Lakeshore University");
  fact("person", "apply.major", "Computer Engineering");
  fact("person", "apply.degree_stage", facts.degreeStage);
  fact("person", "apply.year", "2");
  fact("person", "apply.graduation_year", "2030");
  fact("person", "apply.age", String(facts.age));
  fact("person", "apply.citizenship", facts.citizenship);
  fact("person", "apply.country", facts.country);
  fact("person", "apply.city", facts.residence.split(",")[0]!);
  fact("person", "residence", facts.residence);
  fact("person", "apply.work_authorization", facts.citizenship === "United States" ? "U.S. citizen" : "F-1 student visa");
  fact("research", "research_topic", "面向边缘设备的机器学习加速器（数据流架构）");
  fact("startup", "startup_idea", "把实验室的低功耗推理芯片原型做成开发板产品");
  fact("media", "media_channel", "个人博客与小红书，写体系结构科普");
  return ownerId;
}
