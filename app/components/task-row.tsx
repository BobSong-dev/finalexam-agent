"use client";

import type { Course, StudyTask } from "@/lib/types";

export function TaskRow({
  task,
  course,
  onToggle,
}: {
  task: StudyTask;
  course?: Course;
  onToggle: (id: string, completed: boolean) => void;
}) {
  const done = task.status === "已完成";
  return (
    <article className={`task-row ${done ? "done" : ""}`}>
      <button
        className="check"
        type="button"
        onClick={() => onToggle(task.id, !done)}
        aria-pressed={done}
        aria-label={done ? `取消完成 ${task.title}` : `完成 ${task.title}`}
      >
        {done ? "✓" : ""}
      </button>
      <time>{task.start}</time>
      <span className="course-dot" style={{ backgroundColor: course?.color }} />
      <div className="task-copy">
        <h3>{task.title}</h3>
        <p>{task.reason}</p>
      </div>
      <span className={`task-type ${task.type}`}>{task.type}</span>
      <strong className="duration">{task.duration} min</strong>
    </article>
  );
}
