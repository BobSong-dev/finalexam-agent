"use client";

import type { PracticeGrade } from "@/lib/types";
import type { PracticeReveal, PublicQuestion } from "@/lib/workspace-types";

const GRADE_LABEL: Record<PracticeGrade, string> = {
  correct: "回答正确",
  partial: "部分正确",
  wrong: "需要再看依据",
  pending: "待自评（未计分）",
};

const SELF_GRADES: Array<{ grade: PracticeGrade; label: string }> = [
  { grade: "correct", label: "答对了" },
  { grade: "partial", label: "答对一部分" },
  { grade: "wrong", label: "没答对" },
];

export default function QuestionItem({
  index,
  question,
  answer,
  grade,
  reveal,
  submitted,
  onChange,
  onGradeChange,
  onCorrectAnswer,
}: {
  index: number;
  question: PublicQuestion;
  answer: string;
  grade?: PracticeGrade;
  reveal?: PracticeReveal;
  submitted: boolean;
  onChange: (id: string, value: string) => void;
  onGradeChange: (id: string, grade: PracticeGrade | undefined) => void;
  /** 修正这道题的正确答案（提交后才可编辑）。 */
  onCorrectAnswer: (id: string, answer: string) => void;
}) {
  const titleId = `question-${question.id}-title`;
  return (
    <article className="question">
      <div className="question-number">{String(index + 1).padStart(2, "0")}</div>
      <div className="question-body">
        <div className="question-top">
          <span>{question.type}</span>
          {question.difficulty ? <span>难度 {question.difficulty}/5</span> : null}
          <b>{question.knowledge}</b>
        </div>
        <h3 id={titleId}>{question.prompt}</h3>

        {question.choices?.length ? (
          <div className="choices" role="radiogroup" aria-labelledby={titleId}>
            {question.choices.map((choice, choiceIndex) => (
              <label
                key={`${question.id}-${choiceIndex}`}
                className={answer === choice ? "chosen" : ""}
              >
                <input
                  type="radio"
                  name={question.id}
                  value={choice}
                  checked={answer === choice}
                  disabled={submitted}
                  onChange={(event) => onChange(question.id, event.target.value)}
                />
                {choice}
              </label>
            ))}
          </div>
        ) : (
          <textarea
            aria-labelledby={titleId}
            value={answer}
            disabled={submitted}
            onChange={(event) => onChange(question.id, event.target.value)}
            placeholder={question.type === "填空" ? "填写答案" : "写下关键步骤或要点"}
          />
        )}

        {question.type === "简答" && !submitted && answer.trim() && (
          <div className="self-grade" role="radiogroup" aria-label="简答题自评">
            <small>写完后对照要点自评：</small>
            {SELF_GRADES.map((option) => (
              <label key={option.grade} className={grade === option.grade ? "chosen" : ""}>
                <input
                  type="radio"
                  name={`grade-${question.id}`}
                  checked={grade === option.grade}
                  onChange={() => onGradeChange(question.id, option.grade)}
                />
                {option.label}
              </label>
            ))}
          </div>
        )}

        {submitted && reveal && (
          <div
            className={`feedback ${reveal.grade === "correct" ? "" : reveal.grade === "pending" ? "pending" : "incorrect"}`}
          >
            <b>{GRADE_LABEL[reveal.grade]}</b>
            <p>{reveal.answer}</p>
            <button
              className="text-button answer-fix"
              type="button"
              onClick={() => {
                const next = window.prompt(
                  "修正这道题的正确答案（留空则恢复模型原答案）",
                  reveal.answer,
                );
                if (next !== null) onCorrectAnswer(question.id, next);
              }}
            >
              答案不对？修正
            </button>
            <small>{reveal.explanation}</small>
            {question.pitfalls ? <small>易错：{question.pitfalls}</small> : null}
            <span className="source-link">⌁ {question.source}</span>
          </div>
        )}
      </div>
    </article>
  );
}
