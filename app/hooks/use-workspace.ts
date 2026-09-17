"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicWorkspaceState } from "@/lib/workspace-types";
import { responseError } from "../client-api";

const POLL_INTERVAL_MS = 2500;
// 兜底重拉：约每 15 秒一次，防止某次状态跃迁未被观察到。
const FORCE_RELOAD_EVERY_TICKS = 6;

/**
 * 工作区数据与后台进度。
 *
 * 进度轮询走轻量的 /api/jobs：只有 signal 变化（任务阶段或资料状态变了）才重新
 * 拉取整份工作区。轮询依赖是布尔值，不会因为每次响应产生新引用而反复重建定时器。
 */
export function useWorkspace(initialWorkspace: PublicWorkspaceState | null, initialError: string) {
  const [workspace, setWorkspace] = useState<PublicWorkspaceState | null>(initialWorkspace);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState(initialError);
  const progressSignal = useRef("");
  const ticksSinceReload = useRef(0);

  const applyWorkspace = useCallback((next: PublicWorkspaceState) => {
    setWorkspace(next);
    setWorkspaceError("");
  }, []);

  const loadWorkspace = useCallback(async () => {
    setWorkspaceLoading(true);
    try {
      const response = await fetch("/api/workspace", { cache: "no-store" });
      if (!response.ok) throw new Error(await responseError(response, "无法读取本地学习工作区"));
      ticksSinceReload.current = 0;
      applyWorkspace((await response.json()) as PublicWorkspaceState);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "无法读取本地学习工作区");
    } finally {
      setWorkspaceLoading(false);
    }
  }, [applyWorkspace]);

  const hasActiveJobs = Boolean(
    workspace?.processingJobs?.length ||
    workspace?.materials.some((material) => material.status === "分析中"),
  );

  useEffect(() => {
    if (!hasActiveJobs) {
      progressSignal.current = "";
      ticksSinceReload.current = 0;
      return;
    }
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch("/api/jobs", { cache: "no-store" });
          if (!response.ok) return;
          const snapshot = (await response.json()) as { signal?: string; active?: boolean };
          const next = snapshot.active === false ? "inactive" : (snapshot.signal ?? "");
          if (next === progressSignal.current) {
            // 即使 signal 没变，也定期兜底重拉一次，避免漏掉某次状态跃迁后界面卡住。
            ticksSinceReload.current += 1;
            if (ticksSinceReload.current >= FORCE_RELOAD_EVERY_TICKS) await loadWorkspace();
            return;
          }
          const isFirstTick = progressSignal.current === "";
          progressSignal.current = next;
          // 首次 tick 若服务端已无进行中的任务，说明任务在我们开始轮询前就结束了，
          // 此时必须立刻拉取结果，否则界面会一直停在「分析中」。
          if (!isFirstTick || snapshot.active === false) await loadWorkspace();
        } catch {
          // 轮询失败不打扰用户；下一次 tick 会重试。
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, loadWorkspace]);

  return {
    workspace,
    workspaceLoading,
    workspaceError,
    applyWorkspace,
    loadWorkspace,
    hasActiveJobs,
  };
}
