"use client";

export function LoadingState() {
  return (
    <section className="onboarding-card">
      <p className="eyebrow">LOCAL WORKSPACE</p>
      <h2>正在读取你的学习工作区…</h2>
      <p>课程、资料、计划和练习结果都从本地持久化数据中恢复。</p>
    </section>
  );
}

export function WorkspaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="onboarding-card error">
      <p className="eyebrow">WORKSPACE UNAVAILABLE</p>
      <h2>暂时无法读取学习工作区</h2>
      <p>{message}</p>
      <button className="primary" onClick={onRetry}>
        重新连接
      </button>
    </section>
  );
}

export function Onboarding({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="onboarding-card">
      <p className="eyebrow">WELCOME TO FINALEXAM</p>
      <h2>先创建你的第一门课程</h2>
      <p>课程创建后，即可上传本机资料，进行真实 AI 分析，并生成可持久化的复习计划与练习。</p>
      <button className="primary" onClick={onCreate}>
        创建第一门课程 <span>→</span>
      </button>
    </section>
  );
}

export function DeferredViewLoading({ label }: { label: string }) {
  return (
    <section className="onboarding-card" role="status" aria-live="polite" aria-busy="true">
      <p className="eyebrow">LOADING VIEW</p>
      <h2>正在载入{label}…</h2>
      <p>页面资源正在按需加载，请稍候。</p>
    </section>
  );
}

export function DeferredModalLoading({ label }: { label: string }) {
  return (
    <div className="modal-backdrop" role="status" aria-live="polite" aria-busy="true">
      <section className="modal compact">
        <p className="eyebrow">OPENING</p>
        <h2>正在打开{label}…</h2>
      </section>
    </div>
  );
}
