# 期末星图 · 现状评估与优化开发文档

> 评审范围：仓库全部源码（`lib/`、`app/`、`tests/`、`scripts/`、Docker/CI、README、`docs/production-optimization.md`）。
> 目标读者：项目维护者。本文先给出结论与问题清单，再给出分阶段的实施方案与验收标准。
> 状态标记：**P0** = 现有行为错误/数据受损，应尽快修；**P1** = 明显影响体验或可维护性；**P2** = 增强与长期演进。

---

## 实施进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| 阶段 1 学习数据正确性（P0-1~P0-4、P1-5） | ✅ 已完成 | 工作区 schema v2 + 迁移备份、独立 `knowledgeMastery`、练习会话与判分会话化、attempt 逐题快照、题目↔考点 `knowledgeId` 绑定、AI `mastery` 更名 `priority` |
| 阶段 2 运行时可靠性（P0-5~P0-7、P1-1~P1-4、P1-9~P1-13） | ✅ 已完成 | 启动/停机恢复中断任务、上传与 AI 分池（`FINALE_AI_CONCURRENCY`）、失败原因持久化并在界面显示、读缓存、孤儿文件定时清扫、`createdAt` 改 ISO、计划生成后台化、`/api/jobs` 轻量轮询、health 暴露用量与队列、统一重试 |
| 阶段 3 前端结构与工程规范 | ✅ 已完成 | ESLint（含 React Hooks 新规则）+ Prettier + CI lint、hooks 拆分（工作区/AI 会话/练习/模态框/页签）、组件拆分（资料卡/题卡/上传区/侧栏/模态宿主/视图路由）、浅路由、Playwright E2E + axe |
| 阶段 4 视觉与可访问性 | ✅ 已完成 | design token（中性色/品牌色/字号收敛）、正文下限 12px、深色模式、上传区与阶段总览布局调整、axe 对比度 0 违规；「确认结果」「忽略考点」「修正答案」「完整分析抽屉」「从备份恢复」 |
| 阶段 5 AI 能力与长期演进 | ✅ 已完成 | 长资料分块 map-reduce、OLE 抽取体积上限、按 SHA-256 复用分析、间隔复习排程（SM-2 简化版）、错过任务「补做全部」、阶段总览、备份保留与校验、CSP nonce |

验收命令：`npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run test:http && npm run test:e2e`

所有阶段的实施都已落地；`docs/optimization-roadmap.md` 中标记为 ✅ 的条目对应仓库中的实际代码与测试。

---

## 0. 一句话结论

项目的**安全基线、输入校验、AI 输出结构化校验、原子落盘与文档诚实度**做得很扎实，明显高于同类个人项目。当前最大的短板不在"安全"，而在三处：

1. **学习数据模型不稳固**：掌握度、错题记录挂在会被 AI 重新生成的 `insights/questions` 上，一次重新分析或课程综合就会把用户练出来的掌握度和错题历史清零。
2. **练习判分与"知识点过滤练习"互相矛盾**：从计划页"去练习"只展示一个知识点的题，但服务端按整门课全部题目判分，未展示的题全部记为答错并进入错题回顾。
3. **运行时与前端的工程结构已到临界点**：`workspace-store.ts` 1881 行、`home-client.tsx` 744 行 40 个 `useState`、视图文件单行 JSX、47 KB 单文件 CSS、无 lint。功能继续加下去会失控。

此外校内互助（community）在单工作区运行时里实际上是"自己贡献、自己审核、自己解锁"，占了约 1/3 的 store 代码和一个一级导航，但对用户没有真实价值，建议降级为可选模块。

---

## 1. 项目现状概览

### 1.1 架构

```
浏览器 (home-client.tsx 单页 + 4 个懒加载视图 + 4 个模态)
   │  fetch /api/*  （Origin 校验、进程内限流、Proxy 1MB 体积上限）
   ▼
Next.js 16 Route Handlers (nodejs runtime, force-dynamic)
   │
   ├─ lib/workspace-store.ts   单 JSON 文件 + uploads/ 目录，锁文件 + 写队列 + 原子 rename
   ├─ lib/ai-analysis.ts       OpenAI Responses API，JSON Schema strict，Files→Base64→本地文本多级回退
   ├─ lib/ai-jobs.ts           进程内后台任务（Set<Promise>），processingJobs 写回工作区
   ├─ lib/plan-engine.ts       纯函数排期 + AI 计划物化/容量钳制
   ├─ lib/office-extract.ts    自实现 ZIP/XML 解析抽 PPTX/DOCX 文本，OLE 字符串兜底
   ├─ lib/http-security.ts     Origin/限流/管理员 token
   └─ lib/auth-store.ts        邮箱 OTP（HMAC）
```

### 1.2 做得好的地方（保留，不要在优化中退化）

- 所有写接口有输入校验；所有 AI 输出经 JSON Schema strict + 二次手工解析（`parseDocumentAnalysis` 等）。
- 密钥策略清晰：会话 Key 只在 `sessionStorage`；自定义 Base URL 必须配会话 Key；生产环境 SSRF 防护含 DNS 钉扎、IPv6 映射地址判断。
- 落盘：`wx` 打开 + `fsync` + `rename`；上传流式写入边算 SHA-256 与文件签名；孤儿文件回收。
- 幂等积分账本、租约（`analysisLease` / `planGenerationLease`）防止旧结果覆盖新状态。
- 文档不夸大："未配置 AI 时明确降级"、`generatedBy` 字段诚实标注。
- 测试：13 个测试文件 61 条用例 + 基于 standalone 产物的 HTTP 冒烟；CI 覆盖 typecheck/test/build/smoke。

---

## 2. 问题清单

### 2.1 P0 —— 行为错误 / 数据受损

| # | 问题 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| P0-1 | **知识点过滤练习被整课判分**。计划页"去练习"传入 `knowledge`，前端只展示匹配题目；但 `recordPractice` 取 `state.questions.filter(courseId)` 全部题目计算 `score`、`revealed`、`attempt.questionIds`。未展示的题按空答案判错，并在 `recentMissedTopics` 中成为"错题"注入回顾任务。 | `lib/workspace-store.ts` `recordPractice`；`app/home-client.tsx` `questions` 派生 | 用户练 1 个知识点得 10 分，其他知识点全部被标为"答错"，掌握度与计划被污染 | 请求体携带 `questionIds`（本次实际展示的题），服务端只对该集合判分与记录；校验 `questionIds ⊆ 课程题目` |
| P0-2 | **简答/填空按精确字符串判分**。`answerMatches` 对非单选题只做 `normalize(actual) === normalize(expected)`。简答题几乎必错。 | `lib/workspace-store.ts` `answerMatches` | 简答题永远拉低掌握度、进入错题；"未作答计为错误"与"写下关键要点"提示矛盾 | 填空：接受多参考答案（`answer` 用 `|` 或数组）、去标点、数字/单位归一；简答：改为"自评正确/部分/错误"或调用模型判分（可选，走已有 AI 配置），未配置 AI 时只记录不计分 |
| P0-3 | **掌握度不持久**。`saveCourseSynthesis` 删除该课程**全部** insights（含 material 级）并用 AI 的"学习优先度"覆盖 `mastery`；`saveDocumentAnalysis` 又删除所有 `synthesis-*` insights。用户练出来的每个知识点掌握度在任何一次重分析/综合后归零或被覆盖。 | `saveDocumentAnalysis` / `saveCourseSynthesis` / `invalidateCourseSynthesis` | 学习进度不可信；"掌握度"字段语义混淆（AI 优先度 vs 练习掌握度） | 引入独立的 `knowledgeMastery: Record<courseId, Record<knowledgeKey, {mastery, attempts, lastPracticedAt}>>`，insight 只引用 key；AI 输出的 `mastery` 改名为 `priority` 且不写入掌握度。`db/schema.sql` 已有 `knowledge_mastery` 表设计，JSON 层对齐即可 |
| P0-4 | **错题历史随题目重建丢失**。`assessmentAttempts.questionIds` 引用 `material-{id}-question-{index}` 这类位置型 id；重分析后 id 集合变化，`recentMissedTopics` 中 `state.questions.find` 为 undefined 直接跳过。 | `recentMissedTopics` | 重分析后错题回顾消失 | attempt 中冗余保存 `knowledge`、`prompt` 快照与判定结果；`recentMissedTopics` 直接读 attempt 快照，不再回查 questions |
| P0-5 | **进程崩溃后 `processingJobs` 永久残留**。后台任务仅在 `finally` 里 `removeProcessingJob`；崩溃/`kill -9`/容器 OOM 后 `workspace.json` 里的 job 永不清理。前端 `useEffect` 只要 `processingJobs.length > 0` 就每 2 秒轮询整个工作区，`synthesizingId` 也从 job 推导出"正在综合"状态。 | `lib/ai-jobs.ts`、`instrumentation.ts`、`app/home-client.tsx` L265 | 重启后 UI 永远显示"正在综合"、永久 2s 轮询 | `instrumentation.register()` 启动时：清空 `processingJobs`，把 `分析中` 且租约属于旧进程的资料标为 `失败（服务重启，可重试）`。job 记录加 `pid`/`bootId` |
| P0-6 | **上传在任何分析进行中都会被 503 拒绝**。`acquireHeavyRequestSlot` 单槽位、不排队；后台分析持有槽位最长 180s（等待）+180s（模型）。 | `lib/runtime-capacity.ts`、`app/api/materials/route.ts` | 用户上传第 1 份后开始分析，上传第 2 份直接"服务器正在处理其他大文件"；批量整理资料体验极差 | 拆成两个池：`upload`（并发 1，短占用）与 `ai`（并发 1–2，可配置 `FINALE_AI_CONCURRENCY`）；上传只在写盘期间占用；等待用 Promise 队列代替 250ms 轮询 |
| P0-7 | **后台综合失败静默吞掉**。`runCourseSynthesis` 的 `catch {}` 不记录任何错误，用户点"综合"后 3 分钟内什么都没发生、也没有失败提示。 | `lib/ai-jobs.ts` L142 | 无法排障 | 在 `courseSyntheses[courseId]` 旁增加 `courseSynthesisStatus[courseId] = {state, error, updatedAt}`；UI 卡片显示失败原因与重试 |

### 2.2 P1 —— 体验 / 正确性 / 可维护性

**数据与运行时**

| # | 问题 | 建议 |
|---|---|---|
| P1-1 | 每次 `getWorkspace()` 都从磁盘读并 `JSON.parse` 整个文件，再 `clone()`（`JSON.parse(JSON.stringify)`），`toPublicWorkspace` 再 clone 一次；上传链路一次请求读 3 次。轮询期间每 2s 全量读。 | 进程内缓存 `{state, mtimeMs}`，读时 `stat` 比对 mtime；`toPublicWorkspace` 改为结构化拷贝仅剔除字段（`structuredClone` 或手写投影），避免双 clone |
| P1-2 | `GET /api/workspace` 下发全部 `documentAnalyses`、`courseSyntheses`、全部课程题目、500 条 auditLog 上限之外的其他大数组；随资料增多线性膨胀，且 2s 轮询重复下发。 | 拆分：`/api/workspace` 只给摘要（课程、任务、资料状态、jobs）；`/api/courses/:id/analysis` 按需拉分析详情；进度改用 `GET /api/jobs`（轻量）或 SSE `/api/events` |
| P1-3 | `reconcileUploadDirectoryOnce` 只在进程生命周期内跑一次，且不覆盖 `uploads/shared`。运行数周的实例中途产生的孤儿（如 `deleteCourse` 期间并发上传）不会被回收。 | 改为定时（每小时）+ 每次删除后触发；覆盖 shared 目录 |
| P1-4 | `material.createdAt` 用 `toLocaleString("zh-CN")` 持久化了展示字符串（依赖服务器时区）。 | 持久化 ISO；由前端按 profile 时区格式化（已有 `uploadedAt` 字段，`createdAt` 可直接派生） |
| P1-5 | 题目与考点仅靠 `question.knowledge === insight.title` 精确匹配；模型稍换措辞就断链，练习无法更新任何考点掌握度；当有 insights 但无一匹配时 `course.mastery` 完全不动。 | 在保存分析时建立显式映射：让模型输出 `keyPointId` 引用（schema 已有 `keyPoints[].id`），`generatedQuestions[].knowledgeId` 必须命中；服务端再做归一化标题的兜底匹配 |
| P1-6 | 一门课的练习页一次性渲染该课**全部**题目（20 份资料 × 10 题 + 综合 10 题 ≈ 210 题一个表单）；`isAssessmentSubmission` 上限 200 条会在极端情况下拒绝提交。 | 引入"练习会话"：按知识点/难度/上次错题抽 8–15 题；服务端 `POST /api/practice/sessions` 生成题集并返回 `sessionId`，提交时校验 |
| P1-7 | 长文档处理：`MAX_EXTRACTED_PDF_TEXT_CHARACTERS = 400_000`，且 Files API 成功时**仍然**把本地转写全文一起发送（A4 设计）。40 万汉字 + 原文件很可能超出上下文，被映射成笼统的"AI 服务未能处理这份资料"。超长文档只分析前段。 | 按页分块（例如每块 ≤ 60k 字符）→ 逐块 `keyPoints` → 合并去重（map-reduce）；Files 成功时转写只附前 N 页或省略；把 400/413 上下文错误明确提示"资料过长，已自动分块"或给出可操作信息 |
| P1-8 | `extractOleStrings` 对 50 MB 缓冲逐字节两遍同步扫描，`inflateRawSync`、`readZip` 亦同步，会阻塞事件循环数秒。 | 放到 `worker_threads`（Node 22 内建）；或至少对 OLE 兜底设置 ≤ 8 MB 上限 |
| P1-9 | AI 计划生成 (`/api/plan/generate`) 仍在请求内同步等待模型（最长 180s），未像分析/综合一样后台化；`ProcessingJob.type` 里的 `"plan"` 未使用。 | 统一走 `ai-jobs`，`202` + 轮询/SSE |
| P1-10 | `drainAiJobs` 只等待 12s，不把未完成任务标失败；`docs/production-optimization.md` B4/C8 声称"SIGTERM 时把未完成分析标失败"，代码与文档不一致。Next standalone 自身的 SIGTERM 处理可能先退出。 | 结合 P0-5 的启动时回收即可闭环；文档改为实际行为 |
| P1-11 | `/api/health` 返回 `processing: "inline"`，已过时；未暴露磁盘用量（有 8 GB 配额却无法在 UI 看到用量）、队列深度。 | health 增加 `processing: {mode:"in-process-queue", inflight, queued}`、`storage.usedBytes/quotaBytes`；个人资料页展示用量 |
| P1-12 | AI 用量账本未统计计划生成（`generateStudyPlan` 丢弃 usage）。 | 返回 usage 并 `applyAiUsage` |
| P1-13 | 自定义 Base URL 时 `maxRetries: 0`，瞬时 5xx/网络抖动直接失败；官方地址默认 2 次重试。 | 统一 `maxRetries: 2`，仅对 SSRF 相关（DNS 钉扎后）保持一次性；或对 5xx/ECONNRESET 手写指数退避 |
| P1-14 | 相同 SHA-256 的文件在不同课程重复分析（去重只在课程内）。 | 分析结果按 `sha256+model+promptVersion` 缓存，命中时复制分析并提示"复用已有分析" |

**前端与工程结构**

| # | 问题 | 建议 |
|---|---|---|
| P1-15 | `home-client.tsx` 744 行、40 个 `useState`、所有 fetch 与业务动作集中，向 4 个视图 prop-drilling 10–15 个回调。 | 拆分：`useWorkspace()`（数据+轮询）、`useAiSession()`（Key/BaseURL/model）、`usePractice()`、`useCourseActions()`；视图直接消费 hook 或 Context |
| P1-16 | 视图文件是单行超长 JSX（`analysis-view.tsx` 第 60 行一行约 8 KB；`practice-view.tsx` 第 11 行同理），无法 review、无法 diff。 | 引入 Prettier 并一次性格式化；拆出 `MaterialCard`、`InsightCard`、`QuestionItem`、`UploadZone` 等组件 |
| P1-17 | 无 ESLint/Prettier，`package.json` 无 `lint` 脚本，CI 不做 lint。 | `eslint-config-next` + `typescript-eslint` + Prettier；CI 增加 `npm run lint` |
| P1-18 | `globals.css` 47 KB 单文件、规则挤在一行；颜色硬编码（`#9998a9`、`#a1a0ae` 等 30+ 种灰）；仅 7 个 `@media`，无深色模式；**35 处 `font-size:9px`、50 处 `10px`**，灰字对比度（如 `#a1a0ae` on `#fff` ≈ 2.5:1）不满足 WCAG AA。 | 建立 design tokens（`--text-xs: 12px` 起、语义色变量）；最小正文 12px；补移动端布局（侧栏折叠）；`prefers-color-scheme`；按视图拆 CSS Modules |
| P1-19 | 切换页签用 `router.replace('/?view=…')`，App Router 会重新执行 `page.tsx`（`force-dynamic`）→ 每次切页都在服务端全量读一次 `workspace.json` 并重新序列化下发。 | 用 `window.history.replaceState`（Next 14.1+ 支持浅路由）或只在 `useEffect` 同步 URL |
| P1-20 | 轮询 `useEffect` 依赖 `workspace?.materials`/`processingJobs`，每次响应都换新引用 → 每 2s 清理并重建 interval。 | 依赖改为布尔 `hasActiveJobs`；或改 SSE |
| P1-21 | `需确认` 状态的资料没有"确认"动作，只能"重试分析"；AI 生成的错误考点/题目无法删除或修正答案。 | 资料卡增加"确认结果"；考点/题目卡增加"忽略/删除/编辑答案"（写入 `userOverrides`，重分析时保留） |
| P1-22 | 单资料的完整分析结果（全部考点证据、学习动作、warnings、题型规律）在 UI 中没有入口，仅显示最新一份的 summary 和前 4 条题型。 | 资料卡点开抽屉/页面展示完整 `DocumentAnalysis` |
| P1-23 | 有"导出 JSON"但无"导入/恢复"，恢复只能靠 README 中 Docker shell 流程。 | `POST /api/workspace/import`（校验 schema、版本、可选合并/覆盖，先备份当前） |
| P1-24 | 无浏览器级 E2E（仅 HTTP 冒烟）；`.ui-browser-regression-data/` 显示曾有临时浏览器测试但未纳入仓库。 | Playwright 覆盖：建课→上传→（mock provider）分析→练习→计划 4 条主链路；CI 跑 chromium |

**产品定位**

| # | 问题 | 建议 |
|---|---|---|
| P1-25 | 校内互助在单工作区里是自闭环（贡献者 = 审核员 = 解锁者），`profile.id` 恒为 `local-workspace`。约 600 行 store 代码 + 一级导航 + 6 个 API + OTP/邮件配置，对当前用户没有真实收益，却持续增加维护面。`sharedMaterials`（公开投影）与 `sharedMaterialRecords` 双份存储，`unlockSharedMaterial` 未同步刷新前者，已出现不一致。 | 短期：`FINALE_ENABLE_COMMUNITY=false` 默认隐藏导航与路由（501），代码保留；删除持久化的 `sharedMaterials` 投影，统一在读时计算。长期：多用户迁移时再启用 |

### 2.3 P2 —— 增强与长期演进

| # | 方向 | 说明 |
|---|---|---|
| P2-1 | 间隔重复 | 目前只有"7 天内错题→回顾任务"。为每个知识点维护 FSRS/SM-2 状态（`due`, `stability`, `reps`），计划引擎优先排"到期"知识点；练习会话优先抽到期与薄弱项 |
| P2-2 | 计划窗口 | 7 天固定窗口对 30–60 天后的考试不够；提供"到考试为止"的阶段总览（每周主题）+ 7 天细排 |
| P2-3 | 错过任务的处理 | `missedTasks` 只记录不重排；增加"一键顺延到今天/明天"与自动折叠为"补做"任务 |
| P2-4 | 多模态与 OCR | 扫描版 PDF 在 Files API 不可用时直接失败；可在本地用 `unpdf` 渲染页面为图片再走 `input_image`，或提示用户 |
| P2-5 | 分析质量评估 | 建立小型评测集（几份真实课件/试卷 + 期望考点），`npm run eval` 对比不同模型/提示词版本；为提示词加 `promptVersion` 并写入分析结果 |
| P2-6 | 流式/进度 | Responses API 支持 streaming；至少把 `calling-model` 阶段细化为"已接收 x tokens"，降低 3 分钟黑箱感 |
| P2-7 | 日历导出 | 计划导出 ICS，订阅到手机日历 |
| P2-8 | 可观测性 | 结构化日志（pino）+ request id；`onRequestError` 已有脱敏基础；可选 OpenTelemetry |
| P2-9 | 备份治理 | Compose `backup` 服务无保留策略（无限增长）、无校验、非加密；增加 `FINALE_BACKUP_KEEP=14`，备份后自动跑 `verify-backup.mjs`，可选 `age` 加密 |
| P2-10 | CSP 加固 | `script-src 'unsafe-inline'` 削弱 CSP；Next 16 支持 nonce（通过 proxy 注入 `x-nonce`） |
| P2-11 | 工作区 schema 版本化 | `version: 1` 但没有迁移机制，`normalizeWorkspaceState` 只做浅填充；为 P0-3/P0-4 的模型变更引入 `migrations/v1→v2` 并在读时执行、写前备份 `workspace.v1.bak.json` |
| P2-12 | 持久化状态值国际化解耦 | `"待分析"`、`"高"` 等中文枚举直接落盘；如需英文界面或重命名会牵连数据。可先保留，在 v2 迁移时改为英文 key + 显示映射 |

---

## 3. 实施方案（分阶段）

每阶段独立可发布，先做对用户学习结果影响最大的部分。

### 阶段 1（约 1 周）：学习数据正确性 —— 对应 P0-1 ~ P0-4、P1-5

**3.1.1 工作区 schema v2**

```ts
// lib/workspace-types.ts
export interface KnowledgeMasteryRecord {
  key: string;            // normalizeKnowledgeKey(title)
  title: string;
  mastery: number;        // 0–100，仅由练习驱动
  attempts: number;
  correct: number;
  lastPracticedAt?: string;
  // 阶段 4 再加 FSRS 字段：due/stability/difficulty
}

export interface WorkspaceState {
  version: 2;
  knowledgeMastery: Record<string /*courseId*/, Record<string /*key*/, KnowledgeMasteryRecord>>;
  // insights[].mastery 改为派生字段，读时从 knowledgeMastery 合并；不再持久化
  // assessmentAttempts[].items: { questionId, knowledgeKey, prompt, answer, correct }
}
```

- `lib/workspace-migrations.ts`：`migrateV1ToV2(state)`——遍历现有 `insights`，把 `mastery` 搬进 `knowledgeMastery`；把 `assessmentAttempts` 用当前 `questions` 补齐 `items` 快照。读取时若 `version === 1` 先写 `workspace.v1.bak.json` 再迁移。
- `normalizeKnowledgeKey(title)`：去空白/标点、全角转半角、小写；作为题目与考点的连接键。
- `saveDocumentAnalysis`/`saveCourseSynthesis`：只重建 insight 卡片，**不触碰** `knowledgeMastery`；AI 输出的 `mastery` 字段重命名为 `priority`（schema 与提示词同步改，说明是优先级而非掌握度）。
- `refreshCourseWeights` 之外新增 `deriveCourseMastery(state, courseId)`：有练习记录的知识点加权平均，没有则保持 0 并在 UI 标注"尚无练习数据"。

**3.1.2 练习会话与判分**

```
POST /api/practice/sessions   { courseId, knowledgeKey?, size?: 8–20 }
  → { sessionId, questions: PublicQuestion[] }   // 服务端抽题：到期/薄弱/错题优先
POST /api/assessments/submit  { sessionId, answers, selfRating?, selfGrades?: Record<qid,"correct"|"partial"|"wrong"> }
```

- 服务端保存 `practiceSessions[sessionId] = {courseId, questionIds, createdAt, expiresAt}`（30 分钟过期，保留最近 20 个）。
- 判分规则：
  - 单选：沿用 `choiceToken`/`choiceIndex`。
  - 填空：`answer` 支持 `答案A|答案B`；比较前去标点、全角半角、数字归一（`1,000`→`1000`），允许包含关系（用户答案包含参考答案或反之，长度差 ≤ 30%）。
  - 简答：不自动判对错；提交时要求 `selfGrades[qid]`（对/部分对/错）；若 AI 可用且用户勾选"让 AI 评分"，调用轻量 Responses（`{correct: boolean, feedback}` schema）——这是新增的 AI 用量，写入 `aiUsage`。
- 掌握度更新只针对会话内题目对应的 knowledgeKey；`recentMissedTopics` 改读 `attempt.items`。
- 兼容：旧 `POST /api/assessments/submit {courseId, answers}` 保留一个发布周期，内部转换为"全部课程题目"会话并在响应中带 `deprecated: true`。

**3.1.3 题目↔考点显式绑定**

- `questionSchema` 增加 `knowledgeId`（必填，须等于某个 `keyPoints[].id`）；`parseGeneratedQuestion` 校验命中，未命中回退到标题归一化匹配，仍未命中则 `knowledgeKey = normalizeKnowledgeKey(question.knowledge)` 并加 warning。

**验收**
- 新增测试：过滤练习只影响会话内知识点；重分析后 `knowledgeMastery` 与 `attempts` 不变；v1 数据迁移前后练习历史条数一致。
- `npm test`、`npm run typecheck` 通过；旧 `workspace.json` 启动后生成 `.bak` 且 UI 正常。

### 阶段 2（约 1 周）：运行时可靠性 —— 对应 P0-5 ~ P0-7、P1-1 ~ P1-3、P1-9 ~ P1-13

- `lib/ai-jobs.ts`
  - 任务记录加 `bootId`（进程启动时 `randomUUID()`）；`register()` 启动时调用 `recoverStaleJobs()`：清理 `processingJobs`，将 `分析中` 资料标 `失败：服务重启，请重试`，清 `planGenerationLease`。
  - 新增 `jobErrors: Record<jobId, {message, at}>`（保留 20 条），综合/计划失败写入并在 `/api/workspace` 摘要与 UI 卡片显示。
  - 计划生成后台化，`202` 语义与分析一致。
- `lib/runtime-capacity.ts`
  - 重写为 `class Semaphore(limit)`，Promise 队列 + `AbortSignal` 超时；导出 `uploadPool = new Semaphore(1)`、`aiPool = new Semaphore(env FINALE_AI_CONCURRENCY ?? 1)`。
  - 上传只在 `storeUploadedMaterial` 写盘阶段持有 `uploadPool`。
- `lib/workspace-store.ts`
  - 读缓存：模块级 `{state, mtimeMs, size}`；`readWorkspaceInternal` 先 `stat`，命中直接返回；写后更新缓存。
  - `toPublicWorkspace` 改用 `structuredClone` + 显式 `delete`，删除双 clone。
  - 定时孤儿回收（`setInterval` 1h，`unref()`）并覆盖 shared 目录；删除资料/课程后立即触发一次。
  - `material.createdAt` 改 ISO；前端用 `Intl.DateTimeFormat(profile.timezone)` 格式化。
- `/api/health`：`processing: {mode, inflight, queued}`、`storage.usedBytes/quotaBytes`；`processing: "inline"` 删除。
- `docs/production-optimization.md` B4/C8 描述改为实际行为。

**验收**
- 测试：模拟 `processingJobs` 残留 → `recoverStaleJobs` 后为空且资料状态为失败；上传在 AI 任务进行中返回 201 而非 503；`getWorkspace` 连续 100 次仅 1 次 `readFile`（用 mock 计数）。

### 阶段 3（约 1–1.5 周）：前端结构与工程规范 —— 对应 P1-15 ~ P1-20、P1-24

1. **工程规范先行**（半天）：`eslint.config.mjs`（`eslint-config-next` + `typescript-eslint` strict）、`.prettierrc`（printWidth 100）、`npm run lint`、`npm run format`；一次性格式化提交（单独 PR，便于 review）。
2. **状态拆分**：
   - `app/hooks/use-workspace.ts`：`workspace`、`load`、`apply`、`hasActiveJobs` 驱动的轮询（后续可换 SSE）。
   - `app/hooks/use-ai-session.ts`：sessionStorage 读写、`requestHeaders()`、`ensureAiReady()`。
   - `app/hooks/use-practice.ts`：会话、答案、提交。
   - `app/hooks/use-course-actions.ts`：增删改课程、上传、分析、综合。
   - `HomeClient` 只保留布局、导航与 Toast/Modal 编排。
3. **组件拆分**：`components/material-card.tsx`、`insight-card.tsx`、`question-item.tsx`、`upload-zone.tsx`、`task-row.tsx`、`day-column.tsx`。
4. **导航**：`navigate()` 改用 `history.replaceState`，`page.tsx` 只在首屏读取。
5. **Playwright**：`tests/e2e/*.spec.ts`，复用 `scripts/http-e2e-smoke.mjs` 的 mock provider；CI 新 job。

**验收**：`npm run lint` 零错误；`home-client.tsx` < 250 行；无单行 > 200 字符的 TSX；E2E 4 条主链路通过。

### 阶段 4（约 1 周）：视觉与可访问性 —— 对应 P1-18、P1-21 ~ P1-23

- Design tokens：`--fs-xs:12px / --fs-sm:13px / --fs-md:14px / --fs-lg:16px`；`--text-muted` 对比度 ≥ 4.5:1；语义色（success/warn/danger/brand）。
- 全局替换 9/10/11px；`eyebrow` 类允许 11px 但需 700 字重与足够对比。
- 响应式：≤ 960px 侧栏改为顶部抽屉；`hero-grid`/`insight-list`/`schedule-grid` 单列。
- `prefers-color-scheme: dark` 一套 token 覆盖。
- 新 UI：资料分析详情抽屉（P1-22）、"确认结果"/"忽略考点"/"编辑答案"（P1-21，写 `userOverrides`）、导入工作区（P1-23）。
- axe 检查（Playwright `@axe-core/playwright`）纳入 E2E。

### 阶段 5（持续）：AI 能力与长期演进 —— 对应 P1-7、P1-8、P1-14、P2-*

- 分块 map-reduce 分析、worker_threads 抽文本、按 sha256 复用分析、`promptVersion`。
- FSRS 知识点调度 + 阶段总览计划。
- 备份保留策略与自动校验；CSP nonce；结构化日志。
- 校内互助置于 `FINALE_ENABLE_COMMUNITY` 之后（默认关闭）。

---

## 4. 优先级速览

```
P0（本周）   P0-1 过滤练习判分   P0-2 简答判分   P0-3 掌握度持久化   P0-4 错题快照
             P0-5 重启回收 jobs  P0-6 上传/AI 分池   P0-7 综合失败可见
P1（2–3 周） 读缓存与接口瘦身 · 前端拆分 + lint/prettier · 题目↔考点绑定 · 计划后台化
             需确认/编辑/详情 UI · 字号与对比度 · Playwright
P2（滚动）   FSRS · 分块分析 · 备份治理 · CSP nonce · community 开关 · schema 迁移框架
```

---

## 5. 风险与兼容性说明

- **schema v2 迁移**是一次性、不可逆变更，必须：读前备份 `.bak`，迁移函数有独立测试，`exportWorkspaceData` 输出 v2，`verify-backup.mjs` 不受影响（只校验文件哈希）。
- **练习接口变更**保留旧入参一个版本，前端先切到会话模式。
- **CSS 全量格式化与 token 替换**会产生巨大 diff，建议独立 PR 且不与逻辑改动混合。
- **community 关闭开关**默认值若为 `false`，README 与 `.env.example` 要同步说明；已有 `sharedMaterialRecords` 数据保留不删。

---

## 6. 附：本次评审确认的小问题（顺手修）

- `home-client.tsx`：`beginMaterialAnalysis` 写入的 `source = "已发送给 AI 分析，请勿关闭页面。"` 与后台模式提示"可以离开此页"矛盾——后台模式下应写"分析已在后台进行"。
- `analyze/route.ts` 与 `ai-jobs.ts` 各自调用一次 `upsertProcessingJob`（重复写盘一次）。
- `practice-view.tsx` 选项 `key={choice}`，模型给出重复选项时 React 会警告；应用 index 组合。
- `formatCourseContext` 的"距考试天数"用 `Date.now()`（服务器时区），应按 profile 时区取日期差。
- `next-env.d.ts` 由 Next 16 自动生成，建议加入 `.gitignore`（官方推荐）。
- `.env.example` 中 `DATABASE_URL/STORAGE_BUCKET/EMAIL_FROM` 标注"未读取"，但 `/api/health` 会读 `DATABASE_URL` 做状态展示，说明需一致。
- `README` "API" 章节缺少 `GET /api/ai/status`。
