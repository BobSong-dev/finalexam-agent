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
    const isDevelopment = process.env.NODE_ENV === "development";
    const contentSecurityPolicy = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
        // Only sent in production builds; browsers ignore HSTS received over
        // plain HTTP, so local development over loopback is unaffected.
        ...(process.env.NODE_ENV === "production"
          ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
          : []),
      ],
    }];
  },
};

export default nextConfig;
