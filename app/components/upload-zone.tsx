"use client";

import { useRef, useState, type ChangeEvent } from "react";
import type { Course } from "@/lib/types";
import type { AnalysisAttempt, AnalysisStartStatus } from "../ui-types";
import { formatFileSize, materialKindForFile, validateUploadFile } from "../ui-helpers";

type UploadZoneProps = {
  course: Course;
  busy: boolean;
  onUploadAndAnalyze: (file: File, course: Course) => Promise<AnalysisAttempt>;
  onRetryAnalysis: (materialId: string) => Promise<AnalysisStartStatus>;
};

/**
 * 文件选择 + 上传 + 首次分析。父组件按课程 id 传入 key，切换课程时
 * 组件整体重建，因此不需要「用副作用重置本地状态」。
 */
export default function UploadZone({
  course,
  busy,
  onUploadAndAnalyze,
  onRetryAnalysis,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pendingMaterialId, setPendingMaterialId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState("");

  const pickLocally = (file: File) => {
    const error = validateUploadFile(file);
    if (error) {
      setSelectedFile(null);
      setSelectionError(error);
      return;
    }
    setSelectionError("");
    setPendingMaterialId(null);
    setSelectedFile(file);
  };

  const onSelectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) pickLocally(file);
  };

  const onStartAnalysis = async () => {
    if (busy) return;
    if (pendingMaterialId) {
      // 分析已开始或已完成时文件卡就该收起；只有真正失败才保留以便重试。
      if ((await onRetryAnalysis(pendingMaterialId)) !== "failed") {
        setPendingMaterialId(null);
        setSelectedFile(null);
      }
      return;
    }
    if (!selectedFile) return;
    const result = await onUploadAndAnalyze(selectedFile, course);
    if (result.analyzed || result.started) setSelectedFile(null);
    else if (result.persisted && result.materialId) setPendingMaterialId(result.materialId);
  };

  return (
    <>
      <section
        className="upload-zone"
        aria-busy={busy}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (!file || busy) return;
          pickLocally(file);
        }}
      >
        <input
          ref={inputRef}
          data-testid="material-file-input"
          className="file-picker-input"
          id={`material-upload-${course.id}`}
          type="file"
          accept=".pdf,.ppt,.pptx,.doc,.docx,.jpg,.jpeg,.png,.webp"
          onChange={onSelectFile}
          disabled={busy}
          aria-label="从本机选择资料文件"
        />
        <div className="upload-copy">
          <span aria-hidden="true">{busy ? "◌" : "↑"}</span>
          <div>
            <b>{busy ? "AI 正在处理资料" : "添加一份私有资料"}</b>
            <p>PDF、PPT、Word 或图片 · 单份不超过 50 MB</p>
          </div>
        </div>
        <div className="upload-actions">
          <button
            data-testid="choose-local-file"
            className="outline"
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {selectedFile ? "重新选择文件" : "从本机选择文件"}
          </button>
          <button
            data-testid="start-ai-analysis"
            className="primary"
            type="button"
            onClick={() => void onStartAnalysis()}
            disabled={(!selectedFile && !pendingMaterialId) || busy}
          >
            {busy ? "AI 分析中…" : pendingMaterialId ? "继续 AI 分析" : "保存并开始分析"}
          </button>
          <small>
            {pendingMaterialId
              ? "文件已保存；配置 AI 后点击“继续 AI 分析”即可继续，文件不会重复上传。"
              : "点击后会先保存文件；如果 AI 配置缺失，资料仍会保留并可稍后重试。"}
          </small>
        </div>
      </section>

      {(selectedFile || selectionError) && (
        <section
          className={`selected-file-card ${selectionError ? "error" : ""}`}
          aria-live="polite"
        >
          {selectedFile ? (
            <>
              <div className="selected-file-icon">
                {FILE_TAGS[materialKindForFile(selectedFile)]}
              </div>
              <div>
                <b>{selectedFile.name}</b>
                <p>
                  {formatFileSize(selectedFile.size)} · 将归入「{course.name}」
                </p>
                <small>
                  {pendingMaterialId
                    ? "文件已保存。配置 AI 后点击“继续 AI 分析”即可继续，文件不会重复上传。"
                    : "选择文件后尚未上传；点击“保存并开始分析”才会创建持久化资料。"}
                </small>
              </div>
              <button
                type="button"
                className="clear-selected-file"
                onClick={() => {
                  setSelectedFile(null);
                  setPendingMaterialId(null);
                }}
                aria-label={`移除 ${selectedFile.name}`}
              >
                ×
              </button>
            </>
          ) : (
            <>
              <span>!</span>
              <div>
                <b>无法选择该资料</b>
                <p>{selectionError}</p>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}

const FILE_TAGS: Record<string, string> = { 课件: "PPT", 题库: "DOC", 讲义: "IMG", 试卷: "PDF" };
