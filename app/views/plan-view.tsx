"use client";

import { useEffect, useState } from "react";
import type { Availability, Course, StudyTask } from "@/lib/types";
import { courseById, formatWeekday } from "../ui-helpers";

type PlanViewProps = {
  tasks: StudyTask[];
  courseList: Course[];
  availability: Availability[];
  planSource?: "ai" | "schedule";
  missedTasks: StudyTask[];
  today: string;
  onComplete: (id: string) => void;
  onOpenPractice: (courseId: string, knowledge?: string) => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
  onSaveAvailability: (availability: Availability[]) => Promise<void>;
  savingAvailability: boolean;
};

export default function PlanView({
  tasks,
  courseList,
  availability,
  planSource,
  missedTasks,
  today,
  onComplete,
  onOpenPractice,
  onRegenerate,
  isRegenerating,
  onSaveAvailability,
  savingAvailability,
}: PlanViewProps) {
  const [draft, setDraft] = useState<Availability[]>(availability);
  useEffect(() => setDraft(availability), [availability]);
  const days = availability.map((item) => item.date).sort().slice(0, 7);
  const updateDay = (index: number, patch: Partial<Availability>) => setDraft((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));

  return <div className="view-content">
    <div className="page-heading">
      <div><p className="eyebrow">可完成的节奏</p><h2>可完成的 7 天计划</h2><p>可用时间只改每天分钟数；日期会随学习者时区滚动。任务可标记完成或撤销。</p></div>
      <button className="primary" onClick={onRegenerate} disabled={isRegenerating}>{isRegenerating ? "正在重排…" : "✦ 重新生成计划"}</button>
    </div>
    <div className="plan-notice"><span>◎</span><p>{planSource === "ai" ? "本计划由 AI 依据已识别考点与每日可用时间生成。提交练习不会整表覆盖，只会插入错题回顾；改资料或可用时间仍会按本地规则重排。" : "本计划由本地算法按考试临近度与掌握度自动排期，未调用 AI；配置 AI 后点击“重新生成计划”可获得个性化 AI 计划。"}</p></div>
    <section className="availability-editor">
      <div className="section-heading"><div><p className="eyebrow">YOUR CAPACITY</p><h2>每日可用时间</h2></div><button className="outline" onClick={() => void onSaveAvailability(draft)} disabled={savingAvailability}>{savingAvailability ? "保存中…" : "保存时间并重排"}</button></div>
      <div className="availability-grid">{draft.slice(0, 7).map((item, index) => <label key={`${item.date}-${index}`}><span>{index === 0 ? "今天" : `第 ${index + 1} 天`}<small>{item.date.slice(5).replace("-", "/")}</small></span><div><input type="number" min={0} max={720} step={15} value={item.minutes} onChange={(event) => updateDay(index, { minutes: Number(event.target.value) })} /><small>分钟</small></div></label>)}</div>
    </section>
    <div className="schedule-grid">{days.map((day) => {
      const items = tasks.filter((task) => task.date === day);
      const capacity = availability.find((item) => item.date === day)?.minutes ?? 0;
      const used = items.reduce((total, task) => total + task.duration, 0);
      return <section className="day-column" key={day}><header><span>{day === today ? "今天" : formatWeekday(day)}</span><b>{day.slice(5).replace("-", "/")}</b><small>{used}/{capacity} min</small></header><div>{items.map((task) => {
        const course = courseById(task.courseId, courseList);
        return <article className={`plan-task ${task.status === "已完成" ? "done" : ""}`} style={{ borderLeftColor: course?.color }} key={task.id}><time>{task.start} · {task.duration}m</time><b>{task.title}</b><span>{task.type}</span><div className="plan-task-actions"><button type="button" className="text-button" onClick={() => onComplete(task.id)}>{task.status === "已完成" ? "撤销完成" : "标记完成"}</button>{(task.type === "练习" || task.type === "回顾") && <button type="button" className="text-button" onClick={() => onOpenPractice(task.courseId, task.knowledge)}>去练习</button>}</div></article>;
      })}{!items.length && <p className="empty-day">预留给弹性调整</p>}</div></section>;
    })}</div>
    {missedTasks.length > 0 && <section className="missed-section"><div className="section-heading"><div><p className="eyebrow">MISSED</p><h2>错过的任务</h2></div><span>{missedTasks.length} 个未完成</span></div><div className="missed-list">{missedTasks.slice(0, 12).map((task) => { const course = courseById(task.courseId, courseList); return <article key={`${task.id}-${task.date}`}><span className="course-dot" style={{ backgroundColor: course?.color }} /><div><b>{task.title}</b><small>{task.date} · {task.duration} 分钟 · {course?.name ?? "已删除课程"}</small></div><span className="missed-badge">已错过</span></article>; })}</div><p className="missed-hint">错过的任务不会自动补做；点击上方“重新生成计划”会按当前掌握度重新安排优先级。</p></section>}
  </div>;
}
