import assert from "node:assert/strict";
import test from "node:test";
import { buildAdaptivePlan, isCapacityRespected, materializeAiPlan } from "../lib/plan-engine";
import type { AiPlanEntry } from "../lib/ai-types";
import type { Availability, Course, Insight } from "../lib/types";

const courses: Course[] = [
  { id: "urgent", name: "数据结构", code: "CS203", teacher: "周老师", term: "2026 秋", examDate: "2026-12-14", priority: "高", mastery: 45, highFrequencyWeight: .9, color: "#000" },
  { id: "later", name: "大学英语", code: "ENG104", teacher: "李老师", term: "2026 秋", examDate: "2026-12-25", priority: "中", mastery: 80, highFrequencyWeight: .4, color: "#111" },
];

const availability: Availability[] = [
  { date: "2026-12-09", minutes: 90 },
  { date: "2026-12-10", minutes: 120 },
];

test("generated plan respects every day capacity", () => {
  const plan = buildAdaptivePlan({ courses, availability, fromDate: "2026-12-09" });
  assert.ok(plan.length > 0);
  assert.ok(isCapacityRespected(plan, availability));
});

test("urgent weak course receives the first task", () => {
  const plan = buildAdaptivePlan({ courses, availability, fromDate: "2026-12-09" });
  assert.equal(plan[0]?.courseId, "urgent");
  assert.equal(plan[0]?.date, "2026-12-09");
});

test("generated tasks start after the previous task instead of overlapping", () => {
  const plan = buildAdaptivePlan({ courses, availability: [{ date: "2026-12-09", minutes: 120 }], fromDate: "2026-12-09" });
  assert.equal(plan[0]?.start, "18:30");
  assert.equal(plan[1]?.start, "19:30");
});

test("a custom daily study start shifts every task start time", () => {
  const plan = buildAdaptivePlan({ courses, availability: [{ date: "2026-12-09", minutes: 120 }], fromDate: "2026-12-09", dayStartMinutes: 8 * 60 });
  assert.equal(plan[0]?.start, "08:00");
  assert.equal(plan[1]?.start, "09:00");
  assert.throws(
    () => buildAdaptivePlan({ courses, availability, fromDate: "2026-12-09", dayStartMinutes: 1_500 }),
    /学习开始时间无效/,
  );
});

test("plan validation rejects calendar-invalid dates", () => {
  assert.throws(() => buildAdaptivePlan({ courses, availability, fromDate: "2026-02-30" }), /计划起始日期无效/);
  assert.throws(() => buildAdaptivePlan({ courses: [{ ...courses[0]!, examDate: "2026-02-30" }], availability, fromDate: "2026-12-09" }), /课程考试日期无效/);
});

test("empty availability falls back to calendar-correct consecutive dates in every timezone", () => {
  // addDays must not shift dates in UTC+X timezones (e.g. Asia/Shanghai).
  // Force a hostile timezone to make the regression observable on any host.
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    const plan = buildAdaptivePlan({ courses, availability: [], fromDate: "2026-12-09" });
    const dates = plan.map((task) => task.date);
    assert.equal(dates[0], "2026-12-09");
    assert.deepEqual([...new Set(dates)], [
      "2026-12-09",
      "2026-12-10",
      "2026-12-11",
      "2026-12-12",
      "2026-12-13",
      "2026-12-14",
      "2026-12-15",
    ]);
    assert.ok(dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("generated plan names the evidence-backed focus instead of a generic placeholder", () => {
  const insights: Insight[] = [{
    id: "hash-focus",
    courseId: "urgent",
    title: "哈希冲突处理与查找效率",
    frequency: 5,
    mastery: 20,
    trend: "高频",
    sources: ["期末卷 · 第 2 页"],
    summary: "高频考查冲突处理和效率统计。",
  }];
  const plan = buildAdaptivePlan({ courses, availability, insights, fromDate: "2026-12-09" });
  const first = plan.find((task) => task.courseId === "urgent");
  assert.match(first?.title ?? "", /哈希冲突处理与查找效率/);
  assert.match(first?.reason ?? "", /重要度 5\/5/);
});

test("plan phases follow exam proximity instead of one fixed label", () => {
  const far = buildAdaptivePlan({ courses: [{ ...courses[0]!, examDate: "2026-12-30" }], availability: [{ date: "2026-12-09", minutes: 60 }], fromDate: "2026-12-09" });
  assert.match(far[0]?.title ?? "", /系统梳理/);
  const near = buildAdaptivePlan({ courses: [{ ...courses[0]!, examDate: "2026-12-11" }], availability: [{ date: "2026-12-09", minutes: 60 }], fromDate: "2026-12-09" });
  assert.match(near[0]?.title ?? "", /考前冲刺/);
});

test("consecutive days rotate evidence-backed focuses instead of repeating one", () => {
  const insights: Insight[] = [
    { id: "a", courseId: "urgent", title: "哈希冲突处理", frequency: 5, mastery: 20, trend: "高频", sources: [], summary: "" },
    { id: "b", courseId: "urgent", title: "红黑树旋转", frequency: 4, mastery: 30, trend: "高频", sources: [], summary: "" },
    { id: "c", courseId: "urgent", title: "B 树分裂", frequency: 3, mastery: 25, trend: "需巩固", sources: [], summary: "" },
  ];
  const plan = buildAdaptivePlan({
    courses: [courses[0]!],
    availability: [
      { date: "2026-12-09", minutes: 60 },
      { date: "2026-12-10", minutes: 60 },
      { date: "2026-12-11", minutes: 60 },
    ],
    insights,
    fromDate: "2026-12-09",
  });
  assert.ok(plan.length >= 3);
  const titles = plan.map((task) => task.title);
  assert.equal(new Set(titles).size, titles.length, "no two tasks may repeat one focus while alternatives remain");
});

test("recently missed topics become review tasks that cite the miss date", () => {
  const plan = buildAdaptivePlan({
    courses,
    availability: [{ date: "2026-12-09", minutes: 120 }],
    recentMisses: [{ courseId: "urgent", topic: "AVL 树旋转", missedOn: "2026-12-08" }],
    fromDate: "2026-12-09",
  });
  const review = plan.find((task) => task.courseId === "urgent");
  assert.equal(review?.type, "回顾");
  assert.match(review?.title ?? "", /重练错题「AVL 树旋转」/);
  assert.match(review?.reason ?? "", /12\/08/);
});

test("validation rejects malformed recent misses", () => {
  assert.throws(
    () => buildAdaptivePlan({ courses, availability, fromDate: "2026-12-09", recentMisses: [{ courseId: "urgent", topic: "", missedOn: "2026-12-08" }] }),
    /错题主题格式无效/,
  );
  assert.throws(
    () => buildAdaptivePlan({ courses, availability, fromDate: "2026-12-09", recentMisses: [{ courseId: "urgent", topic: "极限", missedOn: "2026-13-01" }] }),
    /错题日期无效/,
  );
});

test("materialized AI plan drops unknown courses and dates outside the availability window", () => {
  const entries: AiPlanEntry[] = [
    { date: "2026-12-09", courseCode: "CS203", type: "练习", durationMinutes: 45, focus: "二叉树遍历", reason: "掌握度 45%" },
    { date: "2026-12-09", courseCode: "MISSING", type: "复习", durationMinutes: 60, focus: "不存在", reason: "伪造课程" },
    { date: "2026-12-30", courseCode: "CS203", type: "复习", durationMinutes: 60, focus: "超窗日期", reason: "不在可用时间内" },
  ];
  const tasks = materializeAiPlan(entries, courses, availability);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.courseId, "urgent");
  assert.equal(tasks[0]?.duration, 45);
  assert.equal(tasks[0]?.start, "18:30");
});

test("materialized AI plan never exceeds daily capacity and starts sequentially", () => {
  const capacity: Availability[] = [{ date: "2026-12-09", minutes: 90 }];
  const greedy = materializeAiPlan([
    { date: "2026-12-09", courseCode: "CS203", type: "复习", durationMinutes: 120, focus: "二叉树", reason: "超容量被截断" },
    { date: "2026-12-09", courseCode: "ENG104", type: "练习", durationMinutes: 60, focus: "长难句", reason: "容量耗尽后被跳过" },
  ], courses, capacity);
  assert.equal(greedy.length, 1, "no task may start once the day is full");
  assert.equal(greedy[0]?.duration, 90);
  assert.equal(greedy[0]?.start, "18:30");
  assert.ok(isCapacityRespected(greedy, capacity));

  const roomy: Availability[] = [{ date: "2026-12-09", minutes: 120 }];
  const tasks = materializeAiPlan([
    { date: "2026-12-09", courseCode: "CS203", type: "复习", durationMinutes: 60, focus: "二叉树", reason: "第一段" },
    { date: "2026-12-09", courseCode: "ENG104", type: "练习", durationMinutes: 45, focus: "长难句", reason: "第二段" },
    { date: "2026-12-09", courseCode: "ENG104", type: "回顾", durationMinutes: 45, focus: "词汇", reason: "剩余 15 分钟被截断" },
  ], courses, roomy);
  assert.deepEqual(tasks.map((task) => task.duration), [60, 45, 15]);
  assert.deepEqual(tasks.map((task) => task.start), ["18:30", "19:30", "20:15"]);
  assert.ok(isCapacityRespected(tasks, roomy));
});
