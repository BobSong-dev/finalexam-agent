"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * sessionStorage 里的设置读取。
 *
 * 用 useSyncExternalStore 而不是「挂载后再 setState」的副作用：SSR 快照固定为
 * 空字符串（服务端本来就没有这个存储），客户端首帧直接读到真实值，既不会产生
 * hydration 不一致，也不会触发一次多余的级联渲染。
 */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 其他标签页写入时同步。
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function writeSessionSetting(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // 隐私模式下 sessionStorage 可能不可写；配置会退回服务端环境值。
  }
  emit();
}

export function useSessionSetting(key: string): string {
  const read = useCallback(() => {
    try {
      return window.sessionStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  }, [key]);
  return useSyncExternalStore(subscribe, read, () => "");
}
