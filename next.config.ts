import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Proxy only covers small JSON API calls; uploads bypass it to avoid a
    // second in-memory copy of a potentially 50 MB multipart request.
    proxyClientMaxBodySize: "1mb",
  },
  // Create a minimal Node server for the self-hosted Docker image.
  output: "standalone",
  // Next.js 16 protects dev-only assets and HMR by default.  The desktop
  // launcher and local health checks commonly open the app through 127.0.0.1,
  // so allow that loopback origin as well as the built-in localhost default.
  // This setting affects `next dev` only; it does not relax production CORS.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    // CSP 由 proxy.ts 逐请求下发（脚本策略需要 per-request nonce），
    // 这里只保留与请求无关的静态安全头。
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          // Only sent in production builds; browsers ignore HSTS received over
          // plain HTTP, so local development over loopback is unaffected.
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
