import type { Course, MaterialKind } from "@/lib/types";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_UPLOAD_EXTENSIONS = new Set(["pdf", "ppt", "pptx", "doc", "docx", "jpg", "jpeg", "png", "webp"]);

export function courseById(id: string, courses: Course[]): Course | undefined {
  return courses.find((course) => course.id === id);
}

export function initials(value: string): string {
  return value.trim().slice(0, 1) || "我";
}

export function formatExamDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function formatWeekday(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
}

export function materialKindForFile(file: File): MaterialKind {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "ppt" || extension === "pptx") return "课件";
  if (extension === "doc" || extension === "docx") return "题库";
  if (extension === "jpg" || extension === "jpeg" || extension === "png" || extension === "webp") return "讲义";
  return "试卷";
}

export function validateUploadFile(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) return "仅支持 PDF、PPT/PPTX、Word、JPG、PNG 和 WEBP 文件。";
  if (file.size === 0) return "该文件为空，请选择一份包含内容的资料。";
  if (file.size > MAX_UPLOAD_BYTES) return "单份资料不能超过 50 MB。";
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
