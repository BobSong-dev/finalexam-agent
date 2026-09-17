"use client";

import type { DocumentAnalysis, ProcessingFailure } from "@/lib/ai-types";
import type { Course, Insight, Material } from "@/lib/types";
import InsightCard from "../components/insight-card";
import MaterialCard from "../components/material-card";
import UploadZone from "../components/upload-zone";
import type { AnalysisAttempt, AnalysisStartStatus, CourseAiRecord } from "../ui-types";
import { formatExamDate, initials } from "../ui-helpers";

type AnalysisViewProps = {
  selectedCourse: Course;
  courseList: Course[];
  materials: Material[];
  insights: Insight[];
  aiRecord?: CourseAiRecord;
  insightsAreSynthesized: boolean;
  processingErrors?: ProcessingFailure[];
  /** 该课程已完成的逐份分析结果（用于「完整分析」抽屉）。 */
  analyses?: Record<string, DocumentAnalysis>;
  onSelectCourse: (id: string) => void;
  onUploadAndAnalyze: (file: File, course: Course) => Promise<AnalysisAttempt>;
  onRetryAnalysis: (id: string) => Promise<AnalysisStartStatus>;
  onSynthesize: (course: Course) => void;
  onAddCourse: () => void;
  onEditCourse: (course: Course) => void;
  onDeleteCourse: (course: Course) => void;
  onDownloadMaterial: (material: Material) => void;
  onDeleteMaterial: (material: Material) => void;
  onConfirmMaterial: (id: string) => void;
  onOpenMaterialDetail: (material: Material) => void;
  onToggleInsight: (id: string, hidden: boolean) => void;
};

export default function AnalysisView(props: AnalysisViewProps) {
  const {
    selectedCourse,
    courseList,
    materials,
    insights,
    aiRecord,
    insightsAreSynthesized,
    processingErrors,
    analyses,
    onSelectCourse,
    onUploadAndAnalyze,
    onRetryAnalysis,
    onSynthesize,
    onAddCourse,
    onEditCourse,
    onDeleteCourse,
    onDownloadMaterial,
    onDeleteMaterial,
    onConfirmMaterial,
    onOpenMaterialDetail,
    onToggleInsight,
  } = props;
  const analysisIds = new Set(Object.keys(analyses ?? {}));
  const isWorking = aiRecord?.status === "analyzing" || aiRecord?.status === "synthesizing";
  const analyzedCount = materials.filter((material) => material.status === "已分析").length;
  const relevantErrors = (processingErrors ?? []).filter(
    (item) =>
      item.type !== "analyze" || materials.some((material) => material.id === item.targetId),
  );

  return (
    <div className="view-content">
      {relevantErrors.length > 0 && (
        <section className="processing-errors" role="status" aria-live="polite">
          <header>
            <span aria-hidden="true">!</span>
            <div>
              <b>后台任务没有完成</b>
              <small>原始资料与已有结果都保留着，可以直接重试。</small>
            </div>
          </header>
          <ul>
            {relevantErrors.slice(0, 3).map((item) => (
              <li key={item.id}>
                <b>
                  {item.type === "synthesize"
                    ? "课程综合"
                    : item.type === "plan"
                      ? "计划生成"
                      : "资料分析"}
                </b>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="page-heading">
        <div>
          <p className="eyebrow">MATERIAL INTELLIGENCE</p>
          <h2>从资料里找到真正重要的内容</h2>
          <p>文件先保存在本地工作区，再由 AI 提取可追溯考点与练习。</p>
        </div>
        <div className="analysis-heading-actions">
          <button
            className="outline"
            disabled={isWorking}
            onClick={() => onSynthesize(selectedCourse)}
          >
            ✦{" "}
            {aiRecord?.status === "synthesizing"
              ? "正在综合…"
              : analyzedCount
                ? `综合 ${analyzedCount} 份资料`
                : "综合本课程资料"}
          </button>
          <button className="outline" onClick={onAddCourse}>
            ＋ 新增课程
          </button>
        </div>
      </div>

      <div className="analysis-layout">
        <aside className="course-selector">
          <p>我的课程</p>
          {courseList.map((course) => (
            <button
              className={course.id === selectedCourse.id ? "selected" : ""}
              onClick={() => onSelectCourse(course.id)}
              key={course.id}
            >
              <span style={{ backgroundColor: course.color }}>{initials(course.name)}</span>
              <div>
                <b>{course.name}</b>
                <small>
                  {course.code} · {course.teacher}
                </small>
              </div>
              <i>{course.mastery}%</i>
            </button>
          ))}
        </aside>

        <div className="analysis-main">
          <section className="course-header">
            <div>
              <span className="course-badge" style={{ backgroundColor: selectedCourse.color }}>
                {initials(selectedCourse.name)}
              </span>
              <div>
                <h3>{selectedCourse.name}</h3>
                <p>
                  {selectedCourse.code} · {selectedCourse.teacher} · 考试{" "}
                  {formatExamDate(selectedCourse.examDate)}
                </p>
              </div>
            </div>
            <div className="course-header-actions">
              <strong>
                {selectedCourse.mastery}%<small>当前掌握度</small>
              </strong>
              <button
                className="text-button"
                type="button"
                onClick={() => onEditCourse(selectedCourse)}
              >
                编辑
              </button>
              <button
                className="text-button danger-button"
                type="button"
                onClick={() => onDeleteCourse(selectedCourse)}
              >
                删除课程
              </button>
            </div>
          </section>

          <UploadZone
            key={selectedCourse.id}
            course={selectedCourse}
            busy={isWorking}
            onUploadAndAnalyze={onUploadAndAnalyze}
            onRetryAnalysis={onRetryAnalysis}
          />

          {aiRecord && (
            <section className={`analysis-agent-card ${aiRecord.status}`}>
              <div className="analysis-agent-top">
                <div>
                  <span>✦</span>
                  <p>
                    AI 分析{" "}
                    {aiRecord.status === "analyzing"
                      ? "进行中"
                      : aiRecord.status === "synthesizing"
                        ? "正在综合"
                        : aiRecord.status === "error"
                          ? "需留意"
                          : "已就绪"}
                  </p>
                  <h3>{aiRecord.synthesized ? "已生成课程级复习依据" : "已保留资料分析结果"}</h3>
                </div>
                <small>
                  {aiRecord.provider} · {aiRecord.model}
                  <b>{aiRecord.documentCount} 份资料</b>
                </small>
              </div>
              <p className="analysis-agent-summary">{aiRecord.summary}</p>
              {aiRecord.studyActions.length > 0 && (
                <div className="analysis-actions">
                  {aiRecord.studyActions.slice(0, 3).map((action) => (
                    <span key={action}>{action}</span>
                  ))}
                </div>
              )}
              {aiRecord.warnings.length > 0 && (
                <p className="analysis-warning">提示：{aiRecord.warnings.join("；")}</p>
              )}
            </section>
          )}

          {aiRecord && aiRecord.questionPatterns.length > 0 && (
            <section className="analysis-section">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">QUESTION PATTERNS</p>
                  <h2>识别到的题型规律</h2>
                </div>
                <span>{aiRecord.questionPatterns.length} 条</span>
              </div>
              <div className="pattern-list">
                {aiRecord.questionPatterns.map((pattern) => (
                  <article
                    className="pattern-card"
                    key={`${pattern.title}-${pattern.evidence.location}`}
                  >
                    <b>{pattern.title}</b>
                    <span>{pattern.type}</span>
                    <p>{pattern.description}</p>
                    <small>
                      ⌁ {pattern.evidence.label} · {pattern.evidence.location}
                    </small>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="analysis-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">EVIDENCE-BASED INSIGHTS</p>
                <h2>高频与薄弱考点</h2>
              </div>
              <span>
                {insights.length} 个已识别 ·{" "}
                {insightsAreSynthesized ? "跨资料综合" : "单份资料信号"}
              </span>
            </div>
            <div className="insight-list">
              {insights.length ? (
                insights.map((item) => (
                  <InsightCard
                    insight={item}
                    key={item.id}
                    onToggleHidden={() => onToggleInsight(item.id, true)}
                  />
                ))
              ) : (
                <p className="empty-state">
                  尚未识别考点。上传并完成第一份资料分析后，结果会保存在这里。
                </p>
              )}
            </div>
          </section>

          <section className="analysis-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">PRIVATE MATERIALS</p>
                <h2>课程资料</h2>
              </div>
            </div>
            <div className="material-grid">
              {materials.length ? (
                materials.map((material) => (
                  <MaterialCard
                    key={material.id}
                    material={material}
                    busy={isWorking}
                    onDownload={onDownloadMaterial}
                    onRetry={(id) => void onRetryAnalysis(id)}
                    onConfirm={onConfirmMaterial}
                    hasAnalysis={analysisIds.has(material.id)}
                    onOpenDetail={onOpenMaterialDetail}
                    onDelete={onDeleteMaterial}
                  />
                ))
              ) : (
                <p className="empty-state">尚无资料。选择本机文件后会安全保存在本地工作区。</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
