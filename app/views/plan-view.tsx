"use client";

import { useState } from "react";
import type { Availability, Course, StudyTask } from "@/lib/types";
import { examPhaseLabel } from "@/lib/plan-engine";
import { courseById, daysUntilExam, formatExamDate, formatWeekday } from "../ui-helpers";

type PlanViewProps = {
  tasks: StudyTask[];
  courseList: Course[];
  availability: Availability[];
  planSource?: "ai" | "schedule";
  missedTasks: StudyTask[];
  today: string;
  onComplete: (id: string, completed: boolean) => void;
  onOpenPractice: (courseId: string, knowledge?: string) => void;
  onRegenerate: () => void;
  /** 把错过的任务重新排进计划。 */
  onRescheduleMissed: () => void;
  isRegenerating: boolean;
  onSaveAvailability: (availability: Availability[]) => Promise<void>;
  savingAvailability: boolean;
};

export default function PlanView(props: PlanViewProps) {
  const {
    tasks,
    courseList,
    availability,
    planSource,
    missedTasks,
    today,
    onComplete,
    onOpenPractice,
    onRegenerate,
    onRescheduleMissed,
    isRegenerating,
    onSaveAvailability,
    savingAvailability,
  } = props;

  // 编辑草稿跟随服务端值变化。用「渲染期比对」而不是 useEffect 同步：
  // 后者会多渲染一次，而且 React 明确不建议在副作用里直接 setState。
  const [draft, setDraft] = useState<Availability[]>(availability);
  const [syncedFrom, setSyncedFrom] = useState(availability);
  if (syncedFrom !== availability) {
    setSyncedFrom(availability);
    setDraft(availability);
  }

  const days = availability
    .map((item) => item.date)
    .sort()
    .slice(0, 7);
  const updateDay = (index: number, minutes: number) => {
    setDraft((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, minutes } : item)),
    );
  };

  return (
    <div className="view-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">可完成的节奏</p>
          <h2>可完成的 7 天计划</h2>
          <p>可用时间只改每天分钟数；日期会随学习者时区滚动。任务可标记完成或撤销。</p>
        </div>
        <button className="primary" onClick={onRegenerate} disabled={isRegenerating}>
          {isRegenerating ? "正在重排…" : "✦ 重新生成计划"}
        </button>
      </div>

      <div className="plan-notice">
        <span>◎</span>
        <p>
          {planSource === "ai"
            ? "本计划由 AI 依据已识别考点与每日可用时间生成。提交练习不会整表覆盖，只会插入错题回顾；改资料或可用时间仍会按本地规则重排。"
            : "本计划由本地算法按考试临近度与掌握度自动排期，未调用 AI；配置 AI 后点击“重新生成计划”可获得个性化 AI 计划。"}
        </p>
      </div>

      <PhasesOverview courseList={courseList} today={today} />

      <section className="availability-editor">
        <div className="section-heading">
          <div>
            <p className="eyebrow">YOUR CAPACITY</p>
            <h2>每日可用时间</h2>
          </div>
          <button
            className="outline"
            onClick={() => void onSaveAvailability(draft)}
            disabled={savingAvailability}
          >
            {savingAvailability ? "保存中…" : "保存时间并重排"}
          </button>
        </div>
        <div className="availability-grid">
          {draft.slice(0, 7).map((item, index) => (
            <label key={`${item.date}-${index}`}>
              <span>
                {index === 0 ? "今天" : `第 ${index + 1} 天`}
                <small>{item.date.slice(5).replace("-", "/")}</small>
              </span>
              <div>
                <input
                  type="number"
                  min={0}
                  max={720}
                  step={15}
                  value={item.minutes}
                  onChange={(event) => updateDay(index, Number(event.target.value))}
                />
                <small>分钟</small>
              </div>
            </label>
          ))}
        </div>
      </section>

      <div className="schedule-grid">
        {days.map((day) => {
          const items = tasks.filter((task) => task.date === day);
          const capacity = availability.find((item) => item.date === day)?.minutes ?? 0;
          const used = items.reduce((total, task) => total + task.duration, 0);
          return (
            <section className="day-column" key={day}>
              <header>
                <span>{day === today ? "今天" : formatWeekday(day)}</span>
                <b>{day.slice(5).replace("-", "/")}</b>
                <small>
                  {used}/{capacity} min
                </small>
              </header>
              <div>
                {items.map((task) => {
                  const course = courseById(task.courseId, courseList);
                  const done = task.status === "已完成";
                  return (
                    <article
                      className={`plan-task ${done ? "done" : ""}`}
                      style={{ borderLeftColor: course?.color }}
                      key={task.id}
                    >
                      <time>
                        {task.start} · {task.duration}m
                      </time>
                      <b>{task.title}</b>
                      <span>{task.type}</span>
                      <div className="plan-task-actions">
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => onComplete(task.id, !done)}
                        >
                          {done ? "撤销完成" : "标记完成"}
                        </button>
                        {(task.type === "练习" || task.type === "回顾") && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => onOpenPractice(task.courseId, task.knowledge)}
                          >
                            去练习
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
                {!items.length && <p className="empty-day">预留给弹性调整</p>}
              </div>
            </section>
          );
        })}
      </div>

      {missedTasks.length > 0 && (
        <section className="missed-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MISSED</p>
              <h2>错过的任务</h2>
            </div>
            <div className="missed-actions">
              <span>{missedTasks.length} 个未完成</span>
              <button
                className="outline"
                type="button"
                disabled={isRegenerating}
                onClick={onRescheduleMissed}
              >
                {isRegenerating ? "正在重排…" : "补做全部"}
              </button>
            </div>
          </div>
          <div className="missed-list">
            {missedTasks.slice(0, 12).map((task) => {
              const course = courseById(task.courseId, courseList);
              return (
                <article key={`${task.id}-${task.date}`}>
                  <span className="course-dot" style={{ backgroundColor: course?.color }} />
                  <div>
                    <b>{task.title}</b>
                    <small>
                      {task.date} · {task.duration} 分钟 · {course?.name ?? "已删除课程"}
                    </small>
                  </div>
                  <span className="missed-badge">已错过</span>
                </article>
              );
            })}
          </div>
          <p className="missed-hint">
            错过的任务不会自动补做；点击上方“重新生成计划”会按当前掌握度重新安排优先级。
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * 阶段总览（P2-2）：7 天计划窗口之外的长期视角。
 *
 * 这里只给「什么时候该做什么阶段」的建议，不排具体任务——任务仍然由 7 天窗口
 * 与每日可用时间决定，避免界面展示一个做不到的长计划。
 */
function PhasesOverview({ courseList, today }: { courseList: Course[]; today: string }) {
  const upcoming = courseList
    .map((course) => ({ course, daysLeft: daysUntilExam(course.examDate, today) }))
    .filter((item): item is { course: Course; daysLeft: number } => item.daysLeft !== null)
    .sort((left, right) => left.daysLeft - right.daysLeft);
  if (!upcoming.length) return null;

  return (
    <section className="phases-overview">
      <div className="section-heading">
        <div>
          <p className="eyebrow">EXAM TIMELINE</p>
          <h2>到考试为止的阶段</h2>
        </div>
        <span>长期建议 · 具体任务仍按 7 天窗口排期</span>
      </div>
      <div className="phase-grid">
        {upcoming.map(({ course, daysLeft }) => {
          const phase = examPhaseLabel(Math.max(1, daysLeft));
          const masteryNote =
            course.mastery >= 80
              ? "掌握度较高，可以多做限时模拟"
              : course.mastery >= 50
                ? "掌握度中等，重点补易错点"
                : course.mastery > 0
                  ? "掌握度偏低，先回到资料与例题"
                  : "还没有练习数据，先完成一轮资料分析";
          return (
            <article key={course.id} className="phase-card">
              <header>
                <span className="course-dot" style={{ backgroundColor: course.color }} />
                <div>
                  <b>{course.name}</b>
                  <small>
                    {course.code} · 考试 {formatExamDate(course.examDate)}
                  </small>
                </div>
                <strong>{daysLeft < 0 ? "已结束" : `${daysLeft} 天`}</strong>
              </header>
              <p className="phase-current">
                当前阶段：<b>{phase}</b>
              </p>
              <p className="phase-note">{masteryNote}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
