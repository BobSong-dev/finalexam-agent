import Link from "next/link";

export default function NotFound() {
  return (
    <main className="app-shell">
      <section className="workspace">
        <section className="onboarding-card">
          <p className="eyebrow">404 NOT FOUND</p>
          <h2>这个页面不存在</h2>
          <p>请从应用首页开始，或检查地址是否正确。</p>
          <Link className="primary" href="/">返回首页 →</Link>
        </section>
      </section>
    </main>
  );
}
