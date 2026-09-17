"use client";

import { useCallback, useState } from "react";
import type { AiStatus } from "@/lib/ai-types";
import { responseError } from "../client-api";
import { useSessionSetting, writeSessionSetting } from "./use-session-setting";

export const SESSION_API_KEY = "finale-agent.openai-api-key";
export const SESSION_BASE_URL = "finale-agent.openai-base-url";
export const SESSION_MODEL = "finale-agent.ai-model";

const fallbackAiStatus: AiStatus = {
  configured: false,
  source: "none",
  defaultModel: "gpt-5-mini",
  allowedModels: ["gpt-5-mini", "gpt-5", "gpt-4.1-mini"],
  customBaseUrlAllowed: false,
};

function normalizeStatus(payload: Partial<AiStatus>): AiStatus {
  return {
    configured: Boolean(payload.configured),
    source: payload.source === "environment" ? "environment" : "none",
    defaultModel: payload.defaultModel || fallbackAiStatus.defaultModel,
    allowedModels: payload.allowedModels?.length
      ? payload.allowedModels
      : fallbackAiStatus.allowedModels,
    customBaseUrlAllowed: Boolean(payload.customBaseUrlAllowed),
  };
}

/**
 * 会话级 AI 配置：Key / 兼容地址 / 模型名只存在于 sessionStorage，
 * 并统一提供请求头与“是否已就绪”的判断。
 */
export function useAiSession(initialStatus: AiStatus) {
  const sessionApiKey = useSessionSetting(SESSION_API_KEY);
  const sessionBaseUrl = useSessionSetting(SESSION_BASE_URL);
  const sessionModel = useSessionSetting(SESSION_MODEL);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(initialStatus);
  const [aiStatusLoading, setAiStatusLoading] = useState(false);

  const refreshAiStatus = useCallback(async () => {
    setAiStatusLoading(true);
    try {
      const response = await fetch("/api/ai/status", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "无法读取 AI 配置状态"));
      setAiStatus(normalizeStatus((await response.json()) as Partial<AiStatus>));
    } catch {
      setAiStatus(null);
    } finally {
      setAiStatusLoading(false);
    }
  }, []);

  const selectedModel = sessionModel || aiStatus?.defaultModel || fallbackAiStatus.defaultModel;
  const modelOptions = aiStatus?.allowedModels?.length
    ? aiStatus.allowedModels
    : fallbackAiStatus.allowedModels;
  const aiReady = Boolean(sessionApiKey.trim() || aiStatus?.configured);
  const customBaseUrlDisabled = Boolean(
    sessionBaseUrl && aiStatus && !aiStatus.customBaseUrlAllowed,
  );

  const requestHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (sessionApiKey.trim()) headers["X-OpenAI-API-Key"] = sessionApiKey.trim();
    if (sessionBaseUrl.trim()) headers["X-OpenAI-Base-URL"] = sessionBaseUrl.trim();
    return headers;
  }, [sessionApiKey, sessionBaseUrl]);

  const saveSessionConfig = useCallback((apiKey: string, baseUrl: string) => {
    writeSessionSetting(SESSION_API_KEY, apiKey.trim());
    writeSessionSetting(SESSION_BASE_URL, baseUrl.trim());
  }, []);

  const clearSessionConfig = useCallback(() => {
    writeSessionSetting(SESSION_API_KEY, "");
    writeSessionSetting(SESSION_BASE_URL, "");
  }, []);

  const updateModel = useCallback((model: string) => {
    writeSessionSetting(SESSION_MODEL, model.slice(0, 128));
  }, []);

  return {
    aiStatus,
    aiStatusLoading,
    refreshAiStatus,
    sessionApiKey,
    sessionBaseUrl,
    selectedModel,
    modelOptions,
    aiReady,
    customBaseUrlDisabled,
    requestHeaders,
    saveSessionConfig,
    clearSessionConfig,
    updateModel,
  };
}
