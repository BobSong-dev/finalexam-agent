"use client";

import type { Course, Insight, StudyTask } from "@/lib/types";
import { TaskRow } from "../components/task-row";
import type { View } from "../ui-types";
import { courseById, daysUntilExam, formatExamDate } from "../ui-helpers";

type OverviewProps = {
  courseList: Course[];
  tasks: StudyTask[];
  plannedMinutes: number;
  completedMinutes: number;
  insights: Insight[];
  today: string;
  missedCount: number;
  onComplete: (id: string) => void;
  onNavigate: (view: View) => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
};

export function Overview({
  courseList,
  tasks,
  plannedMinutes,
  completedMinutes,
  insights,
  today,
  missedCount,
  onComplete,
  onNavigate,
  onRegenerate,
  isRegenerating,
}: OverviewProps) {
  const upcomingCourses = courseList.filter((course) => course.examDate >= today);
  const urgentCourse =
    [...upcomingCourses].sort((left, right) => left.examDate.localeCompare(right.examDate))[0] ??
    [...courseList].sort((left, right) => left.examDate.localeCompare(right.examDate))[0];
  const nextInsight = insights[0];
  const progress = plannedMinutes ? Math.round((completedMinutes / plannedMinutes) * 100) : 0;
  const daysLeft = urgentCourse ? daysUntilExam(urgentCourse.examDate, today) : null;
  const overdue = daysLeft !== null && daysLeft < 0;
  const nextTask = tasks[0];

  return (
    <div className="view-content overview">
      <section className="hero-grid">
        <div className="hero-card">
          <div className="hero-orbit orbit-a" />
          <div className="hero-orbit orbit-b" />
          <p>最近一场考试</p>
          <div className="countdown">
            <strong>{daysLeft === null ? "—" : overdue ? "已过" : daysLeft}</strong>
            <span>{daysLeft === null ? "待设置" : overdue ? "考试日" : "天"}</span>
          </div>
          <h2>
            {urgentCourse
              ? `${urgentCourse.name} · ${formatExamDate(urgentCourse.examDate)}`
              : "先创建课程"}
          </h2>
          <p className="hero-note">计划会按照考试日期、优先级、掌握度和可用时间自动重排。</p>
          <button className="light-button" type="button" onClick={() => onNavigate("学习计划")}>
            查看复习计划 <span>→</span>
          </button>
        </div>

        <div className="progress-card">
          <div className="card-top">
            <span>今日进度</span>
            <button onClick={onRegenerate} disabled={isRegenerating}>
              {isRegenerating ? "重排中…" : "重新排期 ↻"}
            </button>
          </div>
          <div
            className="ring"
            style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}
          >
            <div>
              <strong>{progress}%</strong>
              <span>已完成</span>
            </div>
          </div>
          <div className="progress-stats">
            <div>
              <b>{completedMinutes}</b>
              <span>已学习分钟</span>
            </div>
            <div>
              <b>{plannedMinutes}</b>
              <span>计划分钟</span>
            </div>
          </div>
        </div>

        <div className="insight-card">
          <div className="sparkle">✦</div>
          <p>Agent 发现</p>
          <h3>
            {nextInsight ? (
              <>
                {nextInsight.title}
                <br />
                <em>{nextInsight.trend}</em>
              </>
            ) : (
              <>
                上传资料后
                <br />
                生成你的
                <br />
                <em>高频薄弱点</em>
              </>
            )}
          </h3>
          <button onClick={() => onNavigate("资料分析")}>查看依据与来源 →</button>
        </div>
      </section>

      <section className="section-heading">
        <div>
          <p className="eyebrow">TODAY&apos;S FOCUS</p>
          <h2>今天的复习路径</h2>
        </div>
        <button className="text-button" onClick={() => onNavigate("学习计划")}>
          完整计划 <span>→</span>
        </button>
      </section>

      <div className="task-list">
        {tasks.length ? (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              course={courseById(task.courseId, courseList)}
              onToggle={(id) => onComplete(id)}
            />
          ))
        ) : (
          <p className="empty-state">尚无今日任务。点击“重新排期”即可生成首个计划。</p>
        )}
      </div>
      {missedCount > 0 && (
        <p className="missed-hint">有 {missedCount} 个错过的任务记录在学习计划页，可重新安排。</p>
      )}

      <section className="lower-grid">
        <article className="mastery-card">
          <div className="card-top">
            <div>
              <p className="eyebrow">MASTERY MAP</p>
              <h2>掌握度一览</h2>
            </div>
            <button onClick={() => onNavigate("练习测验")}>去练习 →</button>
          </div>
          {courseList.map((course) => (
            <div className="mastery-row" key={course.id}>
              <span className="course-dot" style={{ backgroundColor: course.color }} />
              <div>
                <b>{course.name}</b>
                <small>
                  {course.code} · {course.examDate.slice(5).replace("-", "/")}
                </small>
              </div>
              <div className="bar">
                <i style={{ width: `${course.mastery}%`, background: course.color }} />
              </div>
              <strong>{course.mastery}%</strong>
            </div>
          ))}
          {!courseList.some((course) => course.mastery > 0) && (
            <p className="empty-state">还没有练习记录；完成一次练习后这里会显示真实掌握度。</p>
          )}
        </article>

        <article className="nudge-card">
          <span>⌁</span>
          <p>下一步</p>
          <h3>{nextTask?.start || "生成计划"}</h3>
          <b>{nextTask?.title || "上传一份课程资料"}</b>
          <small>
            {nextTask
              ? `${nextTask.duration} 分钟 · ${nextTask.reason}`
              : "资料分析完成后会生成专属任务"}
          </small>
          <button onClick={() => onNavigate(nextTask ? "学习计划" : "资料分析")}>继续</button>
        </article>
      </section>
    </div>
  );
}
