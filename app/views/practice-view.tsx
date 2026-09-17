"use client";

import type { Course, Insight, KnowledgeMasteryRecord, PracticeGrade } from "@/lib/types";
import type { AssessmentAttempt, PracticeReveal, PublicQuestion } from "@/lib/workspace-types";
import QuestionItem from "../components/question-item";
import { initials } from "../ui-helpers";

type PracticeViewProps = {
  selectedCourse: Course;
  courseList: Course[];
  /** 当前会话的题目；没有会话时为空数组。 */
  questions: PublicQuestion[];
  /** 该课程可练题目总数，用于“开始练习”前的说明。 */
  availableCount: number;
  knowledgeFocus: string;
  loading: boolean;
  insights: Insight[];
  knowledgeMastery: Record<string, KnowledgeMasteryRecord>;
  attempts: AssessmentAttempt[];
  answers: Record<string, string>;
  grades: Record<string, PracticeGrade>;
  rating?: number;
  submitted: boolean;
  submitting: boolean;
  revealed: PracticeReveal[];
  onSelectCourse: (id: string) => void;
  onStart: (knowledge?: string) => void;
  onChange: (id: string, value: string) => void;
  onGradeChange: (id: string, grade: PracticeGrade | undefined) => void;
  onCorrectAnswer: (id: string, answer: string) => void;
  onRatingChange: (rating: number | undefined) => void;
  onSubmit: () => void;
  onReset: () => void;
};

export default function PracticeView(props: PracticeViewProps) {
  const {
    selectedCourse,
    courseList,
    questions,
    availableCount,
    knowledgeFocus,
    loading,
    insights,
    knowledgeMastery,
    attempts,
    answers,
    grades,
    rating,
    submitted,
    submitting,
    revealed,
    onSelectCourse,
    onStart,
    onChange,
    onGradeChange,
    onCorrectAnswer,
    onRatingChange,
    onSubmit,
    onReset,
  } = props;
  const revealById = new Map(revealed.map((item) => [item.questionId, item]));
  const unanswered = questions.filter(
    (question) => !String(answers[question.id] ?? "").trim(),
  ).length;
  const essaysNeedingGrade = questions.filter(
    (question) =>
      question.type === "简答" && String(answers[question.id] ?? "").trim() && !grades[question.id],
  ).length;
  const weakest = Object.values(knowledgeMastery)
    .filter((record) => record.attempts > 0)
    .sort((left, right) => left.mastery - right.mastery)
    .slice(0, 3);
  const focusTitles = insights.slice(0, 4).map((item) => item.title);

  return (
    <div className="view-content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">带着依据练习</p>
          <h2>带着依据练习，而不是盲目刷题</h2>
          <p>
            每次练习由服务端按薄弱知识点与近期错题抽题；只对本次题目判分。标准答案在提交后返回。
          </p>
        </div>
        <div className="practice-meta">
          <span>{availableCount ? `${availableCount} 题可练` : "等待资料"}</span>
          <b>{selectedCourse.name}</b>
        </div>
      </div>

      <aside className="course-selector practice-course-selector">
        <p>练习课程</p>
        {courseList.map((course) => (
          <button
            type="button"
            className={course.id === selectedCourse.id ? "selected" : ""}
            onClick={() => onSelectCourse(course.id)}
            key={course.id}
            aria-pressed={course.id === selectedCourse.id}
          >
            <span style={{ backgroundColor: course.color }}>{initials(course.name)}</span>
            <div>
              <b>{course.name}</b>
              <small>
                {course.code} · {course.mastery > 0 ? `掌握度 ${course.mastery}%` : "尚无练习数据"}
              </small>
            </div>
          </button>
        ))}
      </aside>

      {!availableCount ? (
        <section className="onboarding-card">
          <p className="eyebrow">先有资料再有练习</p>
          <h2>先上传并分析一份资料</h2>
          <p>完成 AI 分析或课程综合后，这里会出现可提交、可保存的专属练习。</p>
        </section>
      ) : !questions.length ? (
        <section className="practice-start">
          <div className="onboarding-card">
            <p className="eyebrow">开始一次练习</p>
            <h2>{knowledgeFocus ? `围绕「${knowledgeFocus}」练习` : "抽取一组题目"}</h2>
            <p>
              系统会优先安排近期错题与掌握度较低的知识点，每次约 10
              题；提交后只更新这些知识点的掌握度。
            </p>
            <div className="practice-start-actions">
              <button
                className="primary"
                type="button"
                disabled={loading}
                onClick={() => onStart(knowledgeFocus || undefined)}
              >
                {loading ? "正在抽题…" : knowledgeFocus ? "开始专项练习" : "开始练习"}
              </button>
              {knowledgeFocus && (
                <button
                  className="outline"
                  type="button"
                  disabled={loading}
                  onClick={() => onStart(undefined)}
                >
                  改为全课程练习
                </button>
              )}
            </div>
            {focusTitles.length > 0 && (
              <div className="practice-focus-list">
                <small>按知识点练习：</small>
                {focusTitles.map((title) => (
                  <button
                    key={title}
                    type="button"
                    className="text-button"
                    disabled={loading}
                    onClick={() => onStart(title)}
                  >
                    {title}
                  </button>
                ))}
              </div>
            )}
          </div>
          <PracticeSidebar weakest={weakest} attempts={attempts} />
        </section>
      ) : (
        <div className="practice-layout">
          <section className="practice-panel">
            <div className="practice-top">
              <div>
                <span className="pulse" />
                本次练习 · 预计 {Math.max(8, questions.length * 4)} 分钟 · 共 {questions.length} 题
                {knowledgeFocus ? ` · ${knowledgeFocus}` : ""}
              </div>
              <small>未作答的题目提交后按错误计分；简答题需自评</small>
            </div>

            {questions.map((question, index) => (
              <QuestionItem
                key={question.id}
                index={index}
                question={question}
                answer={answers[question.id] ?? ""}
                grade={grades[question.id]}
                reveal={revealById.get(question.id)}
                submitted={submitted}
                onChange={onChange}
                onGradeChange={onGradeChange}
                onCorrectAnswer={onCorrectAnswer}
              />
            ))}

            <div className="practice-submit-row">
              <label className="self-rating">
                自评掌握度（仅记录）
                <select
                  value={rating ?? ""}
                  onChange={(event) =>
                    onRatingChange(event.target.value ? Number(event.target.value) : undefined)
                  }
                  disabled={submitted}
                >
                  <option value="">不填写</option>
                  <option value="1">1 · 完全不会</option>
                  <option value="2">2 · 需要帮助</option>
                  <option value="3">3 · 基本理解</option>
                  <option value="4">4 · 比较熟练</option>
                  <option value="5">5 · 可以讲解</option>
                </select>
              </label>
              <button
                className="primary submit-practice"
                type="button"
                onClick={onSubmit}
                disabled={submitted || submitting}
              >
                {submitting
                  ? "正在保存…"
                  : submitted
                    ? "已提交，掌握度已更新"
                    : essaysNeedingGrade
                      ? `提交（${essaysNeedingGrade} 道简答待自评）`
                      : unanswered
                        ? `提交全部 ${questions.length} 题（${unanswered} 题未作答）`
                        : "提交并更新复习计划"}
              </button>
              {submitted && (
                <button className="outline" type="button" onClick={onReset} disabled={loading}>
                  {loading ? "正在抽题…" : "↻ 再练一组"}
                </button>
              )}
            </div>
          </section>
          <PracticeSidebar weakest={weakest} attempts={attempts} />
        </div>
      )}
    </div>
  );
}

function PracticeSidebar({
  weakest,
  attempts,
}: {
  weakest: KnowledgeMasteryRecord[];
  attempts: AssessmentAttempt[];
}) {
  return (
    <aside className="practice-side">
      <div className="agent-note">
        <span>✦</span>
        <p>最需要巩固</p>
        <h3>
          {weakest.length
            ? weakest.map((record) => (
                <span key={record.key}>
                  {record.title} · {record.mastery}%<br />
                </span>
              ))
            : "完成第一次练习后，这里会显示掌握度最低的知识点"}
        </h3>
        <small>掌握度只由你的练习结果决定，重新分析资料不会重置它。</small>
      </div>
      <div className="practice-stat">
        <p>答题后，Agent 将</p>
        <ul>
          <li>只更新本次涉及知识点的掌握度</li>
          <li>把错题安排进后续回顾</li>
          <li>AI 计划保留，仅插入错题回顾</li>
        </ul>
      </div>
      {attempts.length > 0 && (
        <div className="practice-history">
          <p className="eyebrow">最近练习</p>
          {attempts.slice(0, 6).map((attempt) => (
            <article key={attempt.id}>
              <div>
                <b>{attempt.score} 分</b>
                <small>{attempt.createdAt.slice(0, 16).replace("T", " ")}</small>
              </div>
              <span>
                {attempt.correct}/{attempt.graded ?? attempt.total} 题
                {attempt.graded !== undefined && attempt.graded < attempt.total
                  ? ` · ${attempt.total - attempt.graded} 题未计分`
                  : ""}
                {attempt.selfRating ? ` · 自评 ${attempt.selfRating}/5` : ""}
              </span>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}
