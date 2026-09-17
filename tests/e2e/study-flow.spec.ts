import AxeBuilder from "@axe-core/playwright";
import type { AxeResults } from "axe-core";
import { expect, test, type Page } from "@playwright/test";

/**
 * 主链路：建课 → 上传 → 真实（mock provider）分析 → 综合 → 练习会话 → 计划。
 * 这些断言只依赖用户看得见的界面文字，不读取内部状态。
 */
/** 断言失败时给出「哪个元素、为什么」的摘要，而不是一长串 axe 原始对象。 */
function summarizeViolations(results: Pick<AxeResults, "violations">) {
  return results.violations.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.slice(0, 6).map((node) => ({
      target: node.target.join(" "),
      why: (node.failureSummary ?? "").replace(/\s+/g, " ").slice(-120),
    })),
  }));
}

async function createCourse(page: Page, code: string) {
  await page
    .getByRole("button", { name: /创建第一门课程|＋ 新增课程/ })
    .first()
    .click();
  await page.getByLabel("课程名称").fill("E2E 高等数学");
  await page.getByLabel("课程代码").fill(code);
  await page.getByLabel("任课教师").fill("端到端老师");
  await page.getByLabel("学期").fill("2026 秋");
  await page.getByLabel("考试日期").fill("2026-12-30");
  await page.getByRole("button", { name: /创建课程并开始上传资料|保存课程修改/ }).click();
  await expect(page.getByText("现在可以上传资料")).toBeVisible({ timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

test("完整复习链路：上传 → 分析 → 综合 → 练习 → 计划", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "先创建你的第一门课程" })).toBeVisible();

  await createCourse(page, `E2E-${Date.now().toString().slice(-6)}`);

  // 上传一份资料并触发生成分析。
  const uploadInput = page.getByTestId("material-file-input");
  await uploadInput.setInputFiles({
    name: "e2e-期末卷.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n% e2e fixture\n"),
  });
  await expect(page.getByText("e2e-期末卷.pdf").first()).toBeVisible();
  await page.getByTestId("start-ai-analysis").click();

  // 分析完成后考点出现在资料分析页。
  await expect(page.getByText("极限的计算").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("已分析").first()).toBeVisible();

  // 课程综合。
  await page.getByRole("button", { name: /综合 1 份资料/ }).click();
  await expect(page.getByText(/已综合 1 份资料|后台开始/)).toBeVisible({ timeout: 30_000 });

  // 练习：抽题 → 作答 → 提交 → 得分与掌握度更新。
  await page.getByRole("button", { name: "练习测验：带着依据练习" }).click();
  await page.getByRole("button", { name: "开始练习" }).click();
  await expect(page.getByText(/本次练习 · 预计/)).toBeVisible({ timeout: 20_000 });
  // 逐题作答：填空题写入包含参考答案的表述，选择题选第一项。
  const questionCount = await page.locator(".question").count();
  expect(questionCount).toBeGreaterThan(0);
  for (let index = 0; index < questionCount; index += 1) {
    const question = page.locator(".question").nth(index);
    const textarea = question.locator("textarea");
    if (await textarea.count()) await textarea.fill("表达式结构");
    else await question.locator(".choices label").first().click();
  }
  await page.getByRole("button", { name: /^提交/ }).click();
  await expect(page.getByText(/练习结果已保存/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("回答正确").first()).toBeVisible();

  // 掌握度只由练习结果驱动：全部答对时，第一次练习记为 60%。
  await page.getByRole("button", { name: "总览：今天的复习重点" }).click();
  const masteryRow = page.locator(".mastery-row").first();
  await expect(masteryRow).toContainText("60%");

  // 计划页展示任务与容量。
  await page.getByRole("button", { name: "学习计划：可完成的复习节奏" }).click();
  await expect(page.getByText("每日可用时间")).toBeVisible();
  await expect(page.locator(".plan-task").first()).toBeVisible();

  // 浅路由：切换页签不触发整页导航，URL 与标题同步更新。
  await expect(page).toHaveURL(/view=practice|view=plan/);
  await expect(page).toHaveTitle(/期末星图/);
});

test("键盘可达且关键页面通过自动可访问性检查", async ({ page }) => {
  // 复用上一个用例建立的工作区（同一个数据目录），因此这里已有课程。
  await page.goto("/");
  await expect(page.locator(".nav-item").first()).toBeVisible();
  // 等布局稳定（字体载入、首屏动画结束）后再做可访问性检查。
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules([])
    .analyze();
  expect(summarizeViolations(results), JSON.stringify(summarizeViolations(results))).toEqual([]);

  // 侧栏导航可以用键盘访问。
  await page.getByRole("button", { name: "资料分析：从资料提取考点" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "从资料里找到真正重要的内容" })).toBeVisible();

  const analysisResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules([])
    .analyze();
  expect(
    summarizeViolations(analysisResults),
    JSON.stringify(summarizeViolations(analysisResults)),
  ).toEqual([]);
});

test("CSP 使用逐请求 nonce 且脚本策略不再允许 unsafe-inline", async ({ page }) => {
  const response = await page.goto("/");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src");
  expect(csp).toContain("'strict-dynamic'");
  const nonce = /'nonce-([0-9a-f]+)'/.exec(csp)?.[1];
  expect(nonce, csp).toMatch(/^[0-9a-f]{32}$/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);

  // 页面自身的脚本标签带上了同一个 nonce。
  const scriptNonces = await page
    .locator("script[nonce]")
    // 浏览器会把 nonce 内容属性清空以防外泄，必须读 IDL 属性。
    .evaluateAll((nodes) => nodes.map((node) => node.nonce));
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(new Set(scriptNonces)).toEqual(new Set([nonce]));

  // 注：这里不校验浏览器是否真的拦下违规脚本——Playwright 自带的 Chromium 在
  // 本环境下不执行 CSP（已验证：带 nonce 的脚本与 eval 都会运行）。断言的是我们自己
  // 下发的策略契约：nonce 存在、strict-dynamic 生效、脚本策略不再包含 unsafe-inline。

  // 两次请求使用不同的 nonce。
  const second = await page.request.get("/");
  const secondCsp = second.headers()["content-security-policy"] ?? "";
  expect(/'nonce-([0-9a-f]+)'/.exec(secondCsp)?.[1]).not.toBe(nonce);
});
