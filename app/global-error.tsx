"use client";

// Root-layout crashes bypass app/error.tsx and the global stylesheet, so this
// fallback must render its own document with inline styles only.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{
        margin: 0,
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f7f7fb",
        color: "#232332",
        fontFamily: '"Noto Sans SC", Arial, sans-serif',
        fontSize: 14,
      }}>
        <section style={{
          maxWidth: 560,
          margin: 24,
          padding: 35,
          border: "1px solid #efcfcb",
          borderRadius: 20,
          background: "#fffafa",
          boxShadow: "0 18px 45px rgba(29,25,74,.08)",
        }}>
          <p style={{ margin: "0 0 6px", color: "#8d89b4", font: "10px monospace", letterSpacing: ".12em", textTransform: "uppercase" }}>RUNTIME ERROR</p>
          <h2 style={{ margin: "0 0 10px", fontSize: 26, lineHeight: 1.35 }}>应用暂时无法渲染</h2>
          <p style={{ margin: "0 0 4px", lineHeight: 1.7 }}>本地学习工作区的数据没有受到影响。请重试；如果反复出现，请重启服务。</p>
          {error.digest && <p style={{ margin: "0 0 4px", color: "#7a7a8c", fontSize: 12 }}>错误编号 {error.digest}</p>}
          <button type="button" onClick={() => retry()} style={{
            marginTop: 14,
            border: 0,
            cursor: "pointer",
            background: "#6d5dfc",
            color: "#fff",
            padding: "10px 15px",
            borderRadius: 10,
            fontWeight: 700,
            fontSize: 12,
          }}>重新加载</button>
        </section>
      </body>
    </html>
  );
}
