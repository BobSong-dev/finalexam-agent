"use client";

import type { Material } from "@/lib/types";
import { formatDateTime } from "../ui-helpers";

const FILE_LABEL: Record<Material["kind"], string> = {
  试卷: "PDF",
  课件: "PPT",
  题库: "DOC",
  讲义: "IMG",
};

export default function MaterialCard({
  material,
  busy,
  hasAnalysis,
  onDownload,
  onRetry,
  onConfirm,
  onOpenDetail,
  onDelete,
}: {
  material: Material;
  busy: boolean;
  /** 存在完整分析结果时展示「完整分析」。 */
  hasAnalysis: boolean;
  onDownload: (material: Material) => void;
  onRetry: (id: string) => void;
  onConfirm: (id: string) => void;
  onOpenDetail: (material: Material) => void;
  onDelete: (material: Material) => void;
}) {
  return (
    <article className="material-card">
      <div className={`file-icon ${material.kind}`}>{FILE_LABEL[material.kind]}</div>
      <div>
        <div className="material-title">
          <b>{material.name}</b>
        </div>
        <p>
          {material.pages ? `${material.pages} 页 · ` : ""}
          {formatDateTime(material.createdAt)}
        </p>
        <small className={`status ${material.status}`}>{material.status}</small>
        <em>{material.source}</em>
        {material.error && <em className="material-error">{material.error}</em>}
      </div>
      <div className="material-actions">
        <button className="material-action" type="button" onClick={() => onDownload(material)}>
          下载
        </button>
        {hasAnalysis && (
          <button className="material-action" type="button" onClick={() => onOpenDetail(material)}>
            完整分析
          </button>
        )}
        {material.status === "需确认" && (
          <button
            className="material-action"
            type="button"
            disabled={busy}
            onClick={() => onConfirm(material.id)}
          >
            确认结果
          </button>
        )}
        {material.status !== "已分析" && material.status !== "需确认" && (
          <button
            className="material-action"
            type="button"
            disabled={busy}
            onClick={() => onRetry(material.id)}
          >
            {material.status === "分析中" ? "分析中…" : "重试分析"}
          </button>
        )}
        <button
          className="material-action danger-button"
          type="button"
          onClick={() => onDelete(material)}
        >
          删除
        </button>
      </div>
    </article>
  );
}
