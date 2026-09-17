"use client";

import type { DocumentAnalysis } from "@/lib/ai-types";
import ModalShell from "../modals/modal-shell";

const CONFIDENCE_LABEL: Record<DocumentAnalysis["confidence"], string> = {
  high: "识别质量高",
  medium: "识别质量中等",
  low: "识别质量低，建议人工复核",
};

/**
 * 单份资料的完整 AI 分析结果（P1-22）：考点证据、题型规律、学习动作与警告。
 * 之前这些内容只在服务端保存，界面上只能看到一句摘要。
 */
export default function AnalysisDetail({
  title,
  analysis,
  onClose,
}: {
  title: string;
  analysis: DocumentAnalysis;
  onClose: () => void;
}) {
  return (
    <ModalShell className="analysis-detail" labelledBy="analysis-detail-title" onClose={onClose}>
      <p className="eyebrow">完整分析结果</p>
      <h2 id="analysis-detail-title">{title}</h2>
      <p className="modal-intro">
        {analysis.documentTitle} · {analysis.materialKind}
        {analysis.pageCount ? ` · ${analysis.pageCount} 页` : ""} ·{" "}
        {CONFIDENCE_LABEL[analysis.confidence]}
      </p>

      <section className="detail-block">
        <h3>摘要</h3>
        <p>{analysis.summary}</p>
      </section>

      <section className="detail-block">
        <h3>考点与来源（{analysis.keyPoints.length}）</h3>
        {analysis.keyPoints.length ? (
          <ul className="detail-list">
            {analysis.keyPoints.map((point) => (
              <li key={point.id}>
                <div className="detail-list-head">
                  <b>{point.title}</b>
                  <span>
                    重要度 {point.importance}/5
                    {point.examLikelihood ? ` · 期末相关度 ${point.examLikelihood}/5` : ""}
                  </span>
                </div>
                {point.pitfalls ? <small>易错：{point.pitfalls}</small> : null}
                <blockquote>
                  {point.evidence.quote || "（无摘录）"}
                  <cite>
                    {[point.evidence.label, point.evidence.location].filter(Boolean).join(" · ") ||
                      "来源位置待确认"}
                  </cite>
                </blockquote>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">这份资料没有抽到可追溯的考点。</p>
        )}
      </section>

      {analysis.questionPatterns.length > 0 && (
        <section className="detail-block">
          <h3>题型规律（{analysis.questionPatterns.length}）</h3>
          <ul className="detail-list">
            {analysis.questionPatterns.map((pattern) => (
              <li key={`${pattern.title}-${pattern.evidence.location}`}>
                <div className="detail-list-head">
                  <b>{pattern.title}</b>
                  <span>{pattern.type}</span>
                </div>
                <p>{pattern.description}</p>
                <span className="source-link">
                  ⌁{" "}
                  {[pattern.evidence.label, pattern.evidence.location].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {analysis.studyActions.length > 0 && (
        <section className="detail-block">
          <h3>建议的学习动作</h3>
          <ul className="detail-actions">
            {analysis.studyActions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="detail-block">
        <h3>生成练习题（{analysis.generatedQuestions.length}）</h3>
        {analysis.generatedQuestions.length ? (
          <ul className="detail-list">
            {analysis.generatedQuestions.map((question) => (
              <li key={question.id}>
                <div className="detail-list-head">
                  <b>{question.prompt}</b>
                  <span>
                    {question.type}
                    {question.difficulty ? ` · 难度 ${question.difficulty}/5` : ""}
                  </span>
                </div>
                {question.choices.length > 0 && <small>{question.choices.join("　")}</small>}
                <small>答案：{question.answer}</small>
                {question.explanation ? <small>{question.explanation}</small> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">这份资料没有生成练习题。</p>
        )}
      </section>

      {analysis.warnings.length > 0 && (
        <section className="detail-block">
          <h3>模型标注的注意事项</h3>
          <ul className="detail-actions warning">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="session-note">
        以上内容由 AI 依据上传资料生成，可能不准确；答案与考点都可以在练习页或资料卡上修正。
      </p>
    </ModalShell>
  );
}
