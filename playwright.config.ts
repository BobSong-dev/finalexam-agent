import { defineConfig, devices } from "@playwright/test";

/**
 * 浏览器级端到端测试。跑的是 standalone 产物（与 Docker 镜像同一个入口），
 * 并用一个本地 mock provider 顶替真实 AI，因此不需要任何密钥。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    // 视图切换有 0.28s 的淡入动画；axe 若在动画中途采样，会把半透明的中间色
    // 当成最终配色（对比度误报）。统一按“减少动态效果”偏好运行，动画被跳过。
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node tests/e2e/support/server.mjs",
    url: "http://127.0.0.1:4173/api/live",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      FINALE_E2E_PORT: "4173",
      FINALE_E2E_PROVIDER_PORT: "4174",
    },
  },
});
