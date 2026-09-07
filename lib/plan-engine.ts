import type { AiPlanEntry } from "./ai-types";
import type { Availability, Course, Insight, PlanRequest, RecentMissedTopic, StudyTask } from "./types";

const taskKinds: StudyTask["type"][] = ["复习", "练习", "回顾", "模拟"];

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

/**
 * Calendar-date arithmetic must not depend on the host timezone. Parsing a
 * date-only string as local midnight and then serializing it with toISOString
 * shifts the result by a day in every UTC+X timezone (including Asia/Shanghai,
 * the application default).
 */
function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function differenceInDays(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.ceil((end - start) / 86_400_000));
}

function priorityValue(course: Course, fromDate: string): number {
  const urgency = 1 / Math.max(2, differenceInDays(fromDate, course.examDate));
  const weakness = 1 - course.mastery / 100;
  const priorityBoost = course.priority === "高" ? 0.32 : course.priority === "中" ? 0.16 : 0.05;
  return urgency * 18 + weakness * 1.4 + course.highFrequencyWeight * 0.8 + priorityBoost;
}

const DEFAULT_DAY_START_MINUTES = 18 * 60 + 30;

function startAt(offsetMinutes: number, dayStartMinutes = DEFAULT_DAY_START_MINUTES): string {
  const totalMinutes = dayStartMinutes + offsetMinutes;
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export type ExamPhase = "系统梳理" | "专项强化" | "冲刺模拟" | "考前冲刺";

/**
 * Revision phases borrowed from exam-planner projects: what a sensible week
 * looks like depends on how close the exam is, so the label must change over
 * the plan window instead of repeating one fixed phrase every day.
 */
export function examPhaseLabel(daysLeft: number): ExamPhase {
  if (daysLeft <= 3) return "考前冲刺";
  if (daysLeft <= 7) return "冲刺模拟";
  if (daysLeft <= 14) return "专项强化";
  return "系统梳理";
}

const PHASE_TASK_PATTERN: Record<ExamPhase, StudyTask["type"][]> = {
  "系统梳理": ["复习", "练习"],
  "专项强化": ["复习", "练习", "回顾"],
  "冲刺模拟": ["模拟", "练习", "回顾"],
  "考前冲刺": ["模拟", "回顾", "练习"],
};

function phaseTaskType(phase: ExamPhase, slotIndex: number): StudyTask["type"] {
  return PHASE_TASK_PATTERN[phase]![slotIndex % PHASE_TASK_PATTERN[phase]!.length]!;
}

/**
 * Concrete first-pass activities for courses that have no analyzed evidence
 * yet. They rotate so a plan without AI analysis still reads as varied, honest
 * work instead of the same sentence every day.
 */
const FIRST_PASS_ACTIVITIES = [
  "通读全部资料并标记反复出现的内容",
  "整理笔记中的核心定义与公式",
  "标记仍未理解、需要请教老师或同学的疑难点",
] as const;

/**
 * Generates a short, capacity-constrained study plan. The database version can
 * replace this pure function without changing the API contract.
 */
export function buildAdaptivePlan({ courses, availability, insights = [], recentMisses = [], fromDate, dayStartMinutes }: PlanRequest): StudyTask[] {
  validatePlanRequest({ courses, availability, insights, recentMisses, fromDate, dayStartMinutes });
  const dayStart = dayStartMinutes ?? DEFAULT_DAY_START_MINUTES;
  const usableDays = availability.length > 0 ? availability : Array.from({ length: 7 }, (_, index) => ({
    date: addDays(fromDate, index),
    minutes: 120,
  }));
  const ranked = [...courses].sort((left, right) => priorityValue(right, fromDate) - priorityValue(left, fromDate));
  const tasks: StudyTask[] = [];
  const missedQueues = missedQueuesByCourse(recentMisses);
  const insightQueues = new Map<string, Insight[]>();
  for (const insight of rankedInsights(insights)) {
    const queue = insightQueues.get(insight.courseId) ?? [];
    queue.push(insight);
    insightQueues.set(insight.courseId, queue);
  }
  const cursorsByCourse = new Map<string, number>();

  usableDays.forEach((day) => {
    let remaining = day.minutes;
    let slotIndex = 0;
    let elapsedMinutes = 0;
    const activeCourses = ranked.filter((course) => course.examDate >= day.date).slice(0, Math.min(3, ranked.length));

    for (const course of activeCourses) {
      if (remaining < 30) break;
      const isMostUrgent = course.id === activeCourses[0]?.id;
      const duration = Math.min(remaining, isMostUrgent ? 60 : 45);
      const daysLeft = differenceInDays(day.date, course.examDate);
      const phase = examPhaseLabel(daysLeft);
      const missed = missedQueues.get(course.id)?.shift();
      const type = missed ? "回顾" : phaseTaskType(phase, slotIndex);
      const focus = missed
        ? { title: missed.topic, reason: `${missed.missedOn.slice(5).replace("-", "/")} 练习答错，安排重练巩固` }
        : nextTopicForCourse(course, insightQueues.get(course.id), cursorsByCourse);
      const action = missed ? `重练错题「${missed.topic}」并核对解题依据` : taskAction(type, focus.title, course.mastery);
      tasks.push({
        id: `${day.date}-${course.id}-${slotIndex}`,
        courseId: course.id,
        date: day.date,
        start: startAt(elapsedMinutes, dayStart),
        duration,
        title: `${phase} · ${action} · ${course.name}`,
        type,
        status: "待完成",
        reason: `${daysLeft} 天后考试 · ${focus.reason}`,
        knowledge: missed ? missed.topic : focus.title,
      });
      remaining -= duration;
      elapsedMinutes += duration;
      slotIndex += 1;
    }
  });

  return tasks;
}

/**
 * Materializes untrusted AI plan entries into persisted StudyTasks. Every
 * entry is re-validated against the real course list and daily capacity:
 * unknown codes, unknown/expired dates and overflow minutes are dropped or
 * clamped so a model can never schedule beyond a day's availability.
 */
export function materializeAiPlan(entries: AiPlanEntry[], courses: Course[], availability: Availability[], dayStartMinutes = DEFAULT_DAY_START_MINUTES, knownFocuses: ReadonlySet<string> = new Set()): StudyTask[] {
  const byCode = new Map(courses.map((course) => [course.code, course]));
  const capacityByDate = new Map(availability.map((day) => [day.date, day.minutes]));
  const dayState = new Map<string, { remaining: number; elapsed: number; slot: number }>();
  const tasks: StudyTask[] = [];

  for (const entry of [...entries].sort((left, right) => left.date.localeCompare(right.date))) {
    const course = byCode.get(entry.courseCode);
    if (!course) continue;
    const capacity = capacityByDate.get(entry.date);
    if (capacity === undefined || course.examDate < entry.date) continue;
    let state = dayState.get(entry.date);
    if (!state) {
      state = { remaining: capacity, elapsed: 0, slot: 0 };
      dayState.set(entry.date, state);
    }
    if (state.remaining < 15) continue;
    const rawMinutes = Math.round(entry.durationMinutes / 15) * 15;
    const duration = Math.max(15, Math.min(rawMinutes, 120, state.remaining));
    const type = (taskKinds as string[]).includes(entry.type) ? entry.type : "复习";
    const rawFocus = entry.focus.trim().slice(0, 120);
    const focus = !rawFocus
      ? course.name
      : knownFocuses.size === 0 || knownFocuses.has(rawFocus)
        ? rawFocus
        : [...knownFocuses].find((item) => rawFocus.includes(item) || item.includes(rawFocus)) ?? rawFocus;
    const phase = examPhaseLabel(differenceInDays(entry.date, course.examDate));
    tasks.push({
      id: `${entry.date}-${course.id}-${state.slot}`,
      courseId: course.id,
      date: entry.date,
      start: startAt(state.elapsed, dayStartMinutes),
      duration,
      title: `${phase} · ${taskAction(type, focus, course.mastery)} · ${course.name}`,
      type,
      status: "待完成",
      reason: entry.reason.trim().slice(0, 200) || `依据「${focus}」`,
      knowledge: focus,
    });
    state.remaining -= duration;
    state.elapsed += duration;
    state.slot += 1;
  }
  return tasks;
}

export function insightImportance(insight: Insight): number {
  if (Number.isInteger(insight.importance) && insight.importance >= 1 && insight.importance <= 5) return insight.importance;
  return Math.min(5, Math.max(1, insight.frequency || 1));
}

function rankedInsights(insights: Insight[]): Insight[] {
  return [...insights].sort((left, right) =>
    left.courseId.localeCompare(right.courseId)
    || right.frequency - left.frequency
    || insightImportance(right) - insightImportance(left)
    || left.mastery - right.mastery
    || left.title.localeCompare(right.title));
}

function missedQueuesByCourse(recentMisses: RecentMissedTopic[]): Map<string, RecentMissedTopic[]> {
  const queues = new Map<string, RecentMissedTopic[]>();
  for (const miss of [...recentMisses].sort((left, right) => left.missedOn.localeCompare(right.missedOn))) {
    const queue = queues.get(miss.courseId) ?? [];
    queue.push(miss);
    queues.set(miss.courseId, queue);
  }
  return queues;
}

/**
 * Returns the next topic for a course: evidence-backed insights first, and
 * rotating first-pass activities when no analysis exists yet. A per-course
 * cursor advances on every task, so consecutive days never repeat the same
 * topic while alternatives remain (a rotation style borrowed from
 * spaced-repetition planners instead of a fixed daily placeholder).
 */
function nextTopicForCourse(course: Course, queue: Insight[] | undefined, cursorsByCourse: Map<string, number>): { title: string; reason: string } {
  const cursor = cursorsByCourse.get(course.id) ?? 0;
  cursorsByCourse.set(course.id, cursor + 1);
  if (queue?.length) {
    const insight = queue[cursor % queue.length]!;
    const importance = insightImportance(insight);
    return { title: insight.title, reason: `依据「${insight.title}」· 重要度 ${importance}/5 · 出现 ${insight.frequency} 份` };
  }
  return {
    title: FIRST_PASS_ACTIVITIES[cursor % FIRST_PASS_ACTIVITIES.length]!,
    reason: `尚无考点证据（完成资料分析后任务会细化）· 掌握度 ${course.mastery}%`,
  };
}

/**
 * Action depth reacts to course mastery: first-pass study when weak, error
 * consolidation in the middle band, and a light confirmation once mastered.
 * Crossing a mastery band therefore changes the task itself (and never
 * inherits a stale completion), while the phase word reacts to exam proximity.
 */
function taskAction(type: StudyTask["type"], focus: string, mastery: number): string {
  if (type === "练习") return `针对「${focus}」完成 2–3 题练习`;
  if (type === "回顾") return `回顾「${focus}」并口述关键依据`;
  if (type === "模拟") return `限时自测「${focus}」`;
  if (mastery >= 80) return `快速回顾「${focus}」确认掌握状态`;
  if (mastery >= 60) return `巩固「${focus}」并整理易错点`;
  return `学习并整理「${focus}」`;
}

export function validatePlanRequest(request: PlanRequest): void {
  if (!request || !Array.isArray(request.courses) || request.courses.length > 100) throw new PlanValidationError("课程列表格式无效或数量过多。");
  if (!Array.isArray(request.availability) || request.availability.length > 31) throw new PlanValidationError("可用时间列表格式无效或数量过多。");
  if (!isValidDateOnly(request.fromDate)) throw new PlanValidationError("计划起始日期无效。");
  if (request.dayStartMinutes !== undefined && (!Number.isInteger(request.dayStartMinutes) || request.dayStartMinutes < 0 || request.dayStartMinutes > 1_439)) throw new PlanValidationError("每日学习开始时间无效。");
  for (const course of request.courses) {
    if (!course || typeof course.id !== "string" || !course.id || !isValidDateOnly(course.examDate)) throw new PlanValidationError("课程考试日期无效。");
    if (!Number.isFinite(course.mastery) || course.mastery < 0 || course.mastery > 100 || !Number.isFinite(course.highFrequencyWeight)) throw new PlanValidationError("课程掌握度或高频权重无效。");
  }
  for (const day of request.availability) {
    if (!day || !isValidDateOnly(day.date) || !Number.isInteger(day.minutes) || day.minutes < 0 || day.minutes > 1_440) throw new PlanValidationError("可用时间必须是有效日期和 0–1440 的整数分钟。");
  }
  if (request.recentMisses !== undefined) {
    if (!Array.isArray(request.recentMisses) || request.recentMisses.length > 100) throw new PlanValidationError("错题主题列表格式无效或数量过多。");
    for (const miss of request.recentMisses) {
      if (!miss || typeof miss.courseId !== "string" || !miss.courseId || typeof miss.topic !== "string" || !miss.topic.trim() || miss.topic.length > 120) throw new PlanValidationError("错题主题格式无效。");
      if (!isValidDateOnly(miss.missedOn)) throw new PlanValidationError("错题日期无效。");
    }
  }
}

export function isCapacityRespected(tasks: StudyTask[], availability: Availability[]): boolean {
  return availability.every((day) => tasks
    .filter((task) => task.date === day.date)
    .reduce((total, task) => total + task.duration, 0) <= day.minutes);
}
