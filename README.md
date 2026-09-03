# 期末星图 · Finale Agent

[![CI](https://github.com/BobSong-dev/finale-revision-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/BobSong-dev/finale-revision-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16.3.0-black.svg)](https://nextjs.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)

面向大学生的中文复习工作区：把课程资料保存在自己控制的数据目录中，用真实 AI 提取可追溯考点、生成练习、记录掌握度并重排复习计划。

当前发行版是**可上线的单工作区 self-hosted 应用**。它不依赖演示种子数据，真实主链路为：

> 创建课程 → 上传原始资料 → 真实 AI 分析 → 课程综合 → 练习与自评 → 掌握度更新 → 计划重排

没有真实 AI 配置时，应用会保留资料并明确显示“待分析”，不会生成假考点、假题目或假成功状态。

## 已实现能力

- 课程创建、编辑、删除；考试日期、优先级、教师、学期均为真实持久化字段。
- 私有资料上传、流式落盘、扩展名与文件签名校验、大小限制、SHA-256 去重、下载、删除和失败重试。
- PDF、PPT/PPTX、DOC/DOCX、JPG、PNG、WEBP 的真实 AI 分析；支持 OpenAI Responses、Files API、Base64 文件输入以及 PDF 文本兼容 fallback。
- 结构化 JSON Schema 校验、来源定位、警告、课程级综合、AI 临时文件清理、`store: false` 隐私设置。
- 练习判分（包括选项文字/字母答案）、自评、掌握度更新、练习历史、证据驱动的计划重排。练习页展示最近练习记录与得分，提交后可直接“再练一次”。
- 重新生成计划会真实调用 AI：依据已识别考点、考试临近度与每日可用时间生成 7 天计划，服务端强制每个任务不超过当日容量；未配置 AI 时明确降级为本地排期并在响应和界面中标注，不会把算法结果伪装成 AI 输出。
- 每日可用时间编辑；计划不会超过容量，完成状态持久化；未完成的前期任务会进入“错过的任务”记录而不是被静默丢弃。
- 个人资料支持时区（计划窗口按学习者时区滚动）与每日计划开始时间（影响全部任务起始时刻）。
- 个人资料保存与学校邮箱 OTP 验证。OTP 只有在真实邮件 provider 返回 2xx 后才会被标记为已发送。
- 校内互助真实流程：提交授权与隐私确认 → 待审核 → 管理员审核（含审核队列与举报处理接口）→ 幂等积分账本 → 同校同课程解锁 → 私有下载 → 举报记录。没有审核通过的资料时目录显示为空，不展示假数据。
- 工作区数据导出：个人资料页可下载完整 JSON 备份（含资料元数据、分析与练习记录）；上传文件本身按“数据与备份”章节方式随数据目录备份。
- 生产安全基线：安全响应头（含 HSTS）、Origin 校验、请求限流（不信任可伪造的转发头）、上传体积前置拦截与重任务并发上限、AI 请求超时、非 root Docker（cap_drop ALL）、原子写入、健康写入探测、敏感存储字段不返回浏览器。

## 运行边界

- 一个运行实例对应一个本地工作区，默认不提供多租户账户隔离；资料不会自动上传到第三方。
- PostgreSQL、对象存储、分布式队列不是当前默认运行时依赖。`db/schema.sql` 是多用户迁移的事务/RLS 设计起点，而不是已经连接的数据库。
- 本地 JSON 存储适合单实例 self-hosted。若要横向扩展或服务多个互不信任的用户，必须先迁移到数据库 + 私有对象存储 + 分布式队列，并在网关启用 HTTPS、登录、审计和分布式限流。
- 校内互助虽然有完整的本地审核/积分/解锁流程，但单工作区不等同于多租户 SaaS；管理员 token、学校域名映射和邮件服务必须由部署者真实配置。

## 项目结构

```
app/                 # Next.js App Router：页面、视图与 API 路由
  api/               # 服务端 API（课程/资料/AI/练习/互助/健康检查等）
  views/             # 各页面视图组件
  modals/            # 模态框组件
  home-client.tsx    # 首页客户端组件
lib/                 # 核心逻辑：AI 分析、计划引擎、工作区存储、安全中间件等
db/schema.sql        # 多用户迁移的数据库 schema 设计起点（当前未连接）
scripts/             # HTTP 冒烟测试与备份校验脚本
tests/               # 单元与集成测试（node --test）
data/                # 本地数据目录（默认，已被 .gitignore 忽略）
docker-compose.yml   # Docker 自托管编排（init-data + finale-agent）
Dockerfile           # 非 root 多阶段镜像
```

## 本地启动

要求：Node.js 22+、npm。

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。生产验收建议使用：

```powershell
npm run typecheck
npm test
npm run build
npm run test:http
```

## 配置真实 AI

在 `.env.local` 中配置服务端 Key，或在页面“AI 设置”中输入当前浏览器会话 Key：

```dotenv
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=gpt-5-mini
```

会话 Key 只写入 `sessionStorage`，关闭浏览器会话后清除；不会进入 `workspace.json`、上传目录或日志。生产环境只有在可信私有主机上显式设置 `AI_ALLOW_UNAUTHENTICATED_SERVER_KEY=true` 才会使用服务端 Key。

兼容服务地址填写 API 根地址，例如 `https://api.openai.com/v1`，不能填写具体的 `/responses` 或 `/files` endpoint。生产环境默认拒绝浏览器指定的自定义地址；若启用 `AI_ALLOW_CUSTOM_BASE_URL=true`，仍必须由反向代理执行 SSRF 防护和限流。浏览器指定自定义地址时必须同时提供本次会话 Key，服务端环境 Key 绝不会被转发到浏览器指定的主机；管理员配置的 `OPENAI_BASE_URL` 仍可与服务端 Key 配套使用。

上传后服务端会边写磁盘边计算文件签名和 SHA-256，再在用户明确发起分析时发送给 AI。正常 Files API 链路直接从磁盘流式发送；只有兼容服务不支持文件接口时才使用 Base64/PDF 文本回退。分析失败会将资料标记为“失败”，保留原始文件并允许重试；不会用本地 demo 或伪造结果兜底。

应用会在解析 multipart 前拒绝没有 `Content-Length`、格式错误或超过 55 MB 的请求，并将上传与资料分析串行放入同一个进程内重任务池。其他 API 请求由 1 MB 的 Proxy 缓冲上限保护。生产反向代理仍应设置同等或更严格的硬请求体上限；不要把 Node 服务直接暴露到公网。

## 邮箱验证与校内互助配置

邮箱验证码不是本地回显或固定验证码。配置一个真实的邮件 HTTP provider：它需要接受如下 JSON 并返回 2xx：

```json
{"to":"student@example.edu","subject":"期末星图邮箱验证码","text":"...","purpose":"finale-email-verification"}
```

```dotenv
EMAIL_PROVIDER_URL=https://mail.example.com/send
EMAIL_PROVIDER_TOKEN=仅放在服务器环境变量
AUTH_OTP_SECRET=至少 32 个随机字符
SCHOOL_EMAIL_DOMAINS=example.edu=示例大学
COMMUNITY_ADMIN_TOKEN=随机管理员 bearer token
```

邮箱验证成功后，只有匹配 `SCHOOL_EMAIL_DOMAINS` 的学校域名才会获得学校边界验证；否则只记录邮箱验证，不开放校内资料共享。管理员通过 `Authorization: Bearer <COMMUNITY_ADMIN_TOKEN>` 调用审核接口：

```http
POST /api/shared/moderate
Content-Type: application/json
Authorization: Bearer <token>

{"materialId":"...","decision":"approve","quality":"已核验"}
```

审核通过才发放一次贡献积分；解锁和积分扣除使用稳定幂等键，重复请求不会重复扣款或发放。

管理员的完整审核入口（同样使用 bearer token）：

```http
GET  /api/shared/moderation/queue
POST /api/shared/reports/:id/resolve
Content-Type: application/json
Authorization: Bearer <token>

{"resolution":"已下架该资料并撤销解锁"}
```

`moderation/queue` 返回待审核资料列表、未处理举报列表和当前可解锁资料数量；`reports/:id/resolve` 幂等关闭一条举报并记录处理说明。这两个接口仅存在于服务端，不会出现在页面或公开工作区数据中。

## Docker 自托管

```powershell
Copy-Item .env.example .env
# 编辑 .env，至少设置持久数据卷；需要 AI/邮箱/互助时再配置对应真实服务

docker compose --env-file .env up --build -d
Invoke-WebRequest http://localhost:3000/api/health
docker compose ps
docker compose logs -f finale-agent
```

Docker 默认绑定 `127.0.0.1`，应用以 UID `1001` 非 root 用户运行，`finale-data` volume 持久化 `workspace.json` 和 `uploads/`。只有在外层已完成 HTTPS、认证、限流和 Origin 配置后，才将 `FINALE_BIND_HOST` 改为 `0.0.0.0`，并设置 `FINALE_ALLOWED_ORIGINS`。

进程内限流默认不信任 `x-forwarded-for`/`x-real-ip`（客户端可以伪造这些头绕过限流）；使用反向代理时应设置 `FINALE_TRUST_PROXY=true`，并让代理覆盖（剥离）入站的转发头。

## 数据与备份

数据目录由 `FINALE_DATA_DIR` 指定，默认为项目下的 `data/`；Docker 中固定为 `/app/data`。健康检查会真实创建、读取并删除临时探测文件，不会在响应中暴露路径、密钥或本地文件名。

Compose 默认会给卷名加上项目名前缀（例如 `fianlexam_finale-data`）。不要使用 `docker run -v finale-data:/data`：它可能创建一个同名空卷并生成“成功但没有用户数据”的备份。下面通过 `docker compose run ... init-data` 复用当前部署实际挂载的卷，不改变现有卷名，也不会触发数据迁移。

### 冷备份

先停止应用写入，再生成归档、逐文件 SHA-256 清单和归档 SHA-256。示例使用 Bash，默认把备份写到仓库外的同级 `finale-backups/`，避免原始资料进入 Git 或 Docker 构建上下文；也可通过 `FINALE_BACKUP_DIR` 指定另一绝对路径：

```bash
set -eu
backup_dir="${FINALE_BACKUP_DIR:-$(cd .. && pwd)/finale-backups}"
mkdir -p "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd)"
backup_name="finale-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"

docker compose stop finale-agent
docker compose run --rm --no-deps \
  -e BACKUP_NAME="$backup_name" \
  -v "$backup_dir:/backup" \
  init-data sh -c '
    set -eu
    test -s /data/workspace.json
    if find /data -type l -print -quit | grep -q .; then
      echo "Refusing to back up a data directory containing symbolic links." >&2
      exit 1
    fi
    (cd /data && find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do sha256sum "$file"; done) > "/backup/$BACKUP_NAME.files.sha256"
    tar -czf "/backup/$BACKUP_NAME" -C /data .
    tar -tzf "/backup/$BACKUP_NAME" >/dev/null
    tar -tzf "/backup/$BACKUP_NAME" | grep -qx "./workspace.json"
    sha256sum "/backup/$BACKUP_NAME" > "/backup/$BACKUP_NAME.sha256"
  '

node scripts/verify-backup.mjs "$backup_dir/$backup_name"
docker compose start finale-agent
```

`verify-backup.mjs` 会流式校验归档哈希、实际解压并解析 gzip/tar，拒绝不安全路径、链接和特殊条目，再将归档内全部常规文件与逐文件 SHA-256 清单精确核对（包括非空的 `workspace.json`）。只有看到 `Backup verified` 才把归档和两个 `.sha256` 文件作为一组保存。若任一步失败，应用会保持停止状态；查明原因后再执行 `docker compose start finale-agent`。

### 恢复

恢复会替换当前工作区。先按上面的冷备份流程保存一份恢复前快照，然后选择要恢复的归档；归档、`.sha256` 和 `.files.sha256` 必须位于同一目录。以下过程先在卷内暂存并逐文件校验，全部通过后才替换当前数据：

```bash
set -eu
backup_dir="${FINALE_BACKUP_DIR:-$(cd .. && pwd)/finale-backups}"
backup_dir="$(cd "$backup_dir" && pwd)"
backup_name="finale-data-20260824T010203Z.tgz" # 改成实际文件名

node scripts/verify-backup.mjs "$backup_dir/$backup_name"
docker compose stop finale-agent
docker compose run --rm --no-deps \
  -e BACKUP_NAME="$backup_name" \
  -v "$backup_dir:/backup:ro" \
  init-data sh -c '
    set -eu
    archive="/backup/$BACKUP_NAME"
    sha256sum -c "$archive.sha256"
    tar -tzf "$archive" >/dev/null
    tar -tzf "$archive" | grep -qx "./workspace.json"
    if tar -tzf "$archive" | grep -Eq "(^/|(^|/)\.\.(/|$))"; then
      echo "Refusing to restore an archive containing an unsafe path." >&2
      exit 1
    fi

    staging="/data/.restore-staging-$$"
    mkdir "$staging"
    tar -xzf "$archive" -C "$staging"
    test -s "$staging/workspace.json"
    (cd "$staging" && sha256sum -c "$archive.files.sha256")

    find /data -mindepth 1 -maxdepth 1 ! -path "$staging" -exec rm -rf -- {} +
    for item in "$staging"/* "$staging"/.[!.]* "$staging"/..?*; do
      [ -e "$item" ] || continue
      mv "$item" /data/
    done
    rmdir "$staging"
    chown -R 1001:1001 /data
  '

docker compose start finale-agent
curl --fail --silent --show-error http://127.0.0.1:${PORT:-3000}/api/health
```

校验或暂存失败时不要启动应用，也不要手动删除 `.restore-staging-*`；先保留现场并使用恢复前快照排查。备份包含原始资料、答案和学习记录，应加密保存，并将校验文件与归档一起保管。

## API

- `GET/PATCH /api/workspace`：读取工作区，更新个人资料（含时区、每日计划开始时间）和每日可用时间；`GET /api/workspace/export` 下载完整 JSON 备份（限流 + Origin 校验）。
- `POST /api/courses`、`PATCH/DELETE /api/courses/:id`：课程生命周期。
- `POST /api/materials`、`GET/DELETE /api/materials/:id`、`GET /api/materials/:id/download`：私有资料生命周期。
- `POST /api/materials/:id/analyze`、`POST /api/courses/:id/synthesize`：真实 AI 分析与综合。
- `POST /api/assessments/submit`、`PATCH /api/tasks/:id`、`POST /api/plan/generate`：练习、任务和计划。`plan/generate` 在配置了 AI 时真实调用模型生成计划（响应 `generatedBy: "ai"`），未配置时按本地规则排期（`generatedBy: "schedule"`）并在界面中明确标注。
- `POST /api/auth/otp/request`、`POST /api/auth/otp/verify`：真实邮件验证；邮件服务未配置时返回明确的 503。
- `GET /api/shared/catalog`、`POST /api/shared/contribute`、`POST /api/shared/moderate`、`POST /api/shared/unlock`、`POST /api/shared/report`、`GET /api/shared/:id/download`：校内互助审核、积分、解锁和下载。
- `GET /api/shared/moderation/queue`、`POST /api/shared/reports/:id/resolve`：管理员审核队列与举报处理（bearer token 保护，不进页面）。
- `GET /api/live`：轻量进程存活探针，供 Docker 使用，不访问工作区磁盘。
- `GET /api/health`：深度读取 + 写入探测；存储不可用返回 `503`，适合作为就绪检查。

所有写接口都会校验输入；浏览器写请求会校验 Origin，AI、上传、OTP、互助和状态变更接口带有进程内限流。多实例部署仍必须在反向代理配置分布式限流和审计。

## 迁移到多用户服务的生产清单

当前单工作区运行时已经把数据边界、对象 key 隐藏、幂等账本、审核状态和接口契约固定下来。真正面向多租户前，还必须把以下实现迁移到共享基础设施并验证：

1. 身份认证后的 `user_id/school_id/course_id` 全链路作用域与 PostgreSQL RLS。
2. 私有对象存储和短时签名 URL；禁止应用服务器直接暴露宿主机路径。
3. 持久化后台队列、重试、超时、死信与横向 worker，而不是把长时间 AI 调用绑在 Web 请求上。
4. 独立的病毒扫描、OCR/视觉处理、去重和内容安全服务；不通过“分析成功”推断授权或无恶意。
5. 事务化幂等积分账本、解锁撤销、举报审核、管理员审计和邮件退订。
6. HTTPS、会话安全、CSRF/Origin 策略、分布式限流、配额、监控和密钥轮换。

这些迁移项不会在没有真实基础设施时被页面伪装成已经启用。
