"use client";

// Next 16 error boundaries receive `retry`, not the legacy `reset` prop.
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="app-shell">
      <section className="workspace">
        <section className="onboarding-card error">
          <p className="eyebrow">RUNTIME ERROR</p>
          <h2>页面出现错误</h2>
          <p>{error.message || "发生了意外错误，请重试。"}</p>
          {error.digest && <p className="eyebrow">错误编号 {error.digest}</p>}
          <button className="primary" type="button" onClick={() => retry()}>重新加载</button>
        </section>
      </section>
    </main>
  );
}
