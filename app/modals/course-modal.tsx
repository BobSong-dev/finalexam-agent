"use client";

import type { Course } from "@/lib/types";
import type { CourseDraft } from "../ui-types";
import ModalShell from "./modal-shell";

export default function CourseModal({ draft, editing, saving, onClose, onChange, onSubmit }: { draft: CourseDraft; editing: boolean; saving: boolean; onClose: () => void; onChange: (patch: Partial<CourseDraft>) => void; onSubmit: () => void }) {
  return <ModalShell className="compact" labelledBy="course-title" onClose={onClose}><p className="eyebrow">课程设置</p><h2 id="course-title">{editing ? "编辑课程" : "纳入一门新课程"}</h2><p className="modal-intro">课程代码、教师、学期、考试日期都是排期与资料归属所需的真实数据。</p><div className="form-grid"><label>课程名称<input value={draft.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如 高等数学" /></label><label>课程代码<input value={draft.code} readOnly={editing} onChange={(event) => onChange({ code: event.target.value })} placeholder="例如 MATH201" /></label><label>任课教师<input value={draft.teacher} onChange={(event) => onChange({ teacher: event.target.value })} placeholder="例如 张老师" /></label><label>学期<input value={draft.term} onChange={(event) => onChange({ term: event.target.value })} placeholder="例如 2026 秋" /></label><label>考试日期<input type="date" value={draft.examDate} onChange={(event) => onChange({ examDate: event.target.value })} /></label><label>复习优先级<select value={draft.priority} onChange={(event) => onChange({ priority: event.target.value as Course["priority"] })}><option value="高">高</option><option value="中">中</option><option value="低">低</option></select></label></div><button className="primary full" onClick={onSubmit} disabled={saving}>{saving ? "正在保存…" : editing ? "保存课程修改" : "创建课程并开始上传资料"}</button></ModalShell>;
}

