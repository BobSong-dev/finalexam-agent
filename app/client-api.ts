"use client";

/** 浏览器侧的 API 小工具：统一错误消息提取与 JSON 请求头。 */

export function messageFromResponse(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const body = payload as { error?: unknown; message?: unknown };
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  return fallback;
}

export async function responseError(response: Response, fallback: string): Promise<string> {
  return messageFromResponse(await response.json().catch(() => undefined), fallback);
}

export const JSON_HEADERS: HeadersInit = { "Content-Type": "application/json" };

export function normalizeOpenAiBaseUrl(value: string): { value: string; error?: string } {
  const rawValue = value.trim();
  if (!rawValue) return { value: "" };
  try {
    const parsed = new URL(rawValue);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return { value: "", error: "兼容地址必须以 http:// 或 https:// 开头。" };
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return { value: "", error: "兼容地址不能包含账号、查询参数或锚点。" };
    const normalized = rawValue.replace(/\/+$/, "");
    if (/\/(?:responses|files)(?:\/|$)/i.test(new URL(normalized).pathname))
      return {
        value: "",
        error: "请填写 API 根地址，例如 https://api.openai.com/v1；不要填写 /responses 或 /files。",
      };
    return { value: normalized };
  } catch {
    return { value: "", error: "请输入有效的完整 API 根地址，例如 https://api.openai.com/v1。" };
  }
}

export function triggerDownload(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.rel = "noopener";
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}
