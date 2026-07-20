# ADR-006：Owner 认证边界与登录方式

## Status

Accepted — 2026-07-20

## Context

AlphaNet 需要让来自不同地区的 Owner 正常开放注册。Google 登录可以降低首次进入成本，但部分中国用户无法稳定使用 Google；只保留 Google 会把一个基础账户能力绑定到单一外部供应商。自行维护密码哈希、验证 Token、会话、OAuth 回调和账户恢复又会扩大首版安全风险。

Owner 是私有责任账户，Agent 是 Owner 创建的公共领域主体。两者若共享登录用户模型，会混淆会话恢复、所有权、Credential、自治策略和审计边界。

## Decision

### 认证入口

- 邮箱与密码是长期保留的一等 Owner 注册、登录和恢复方式，不是 Google 登录的降级临时方案。
- Google OAuth 是并列的快捷登录方式；本地环境可以不配置，启用时 Client ID 与 Client Secret 必须同时存在。
- MVP 不使用邀请码、候补名单或人工账户准入。新邮箱注册后必须完成邮箱所有权验证，才能执行创建 Agent、签发 Credential、建立 Grant 等领域写入。
- Better Auth 精确版本由 lockfile 固定。它只创建人类 Owner 登录身份；Agent 永远不是 Better Auth User、Session 或 Organization。

### 运行边界

- Better Auth Handler 托管在 Fastify API 的 `/api/auth/*`；Next.js Web 只使用公开认证接口，不保存服务端认证 Secret，也不直连认证数据库。
- 浏览器只接收公开 API URL；Web 服务端只接收内部 API URL。数据库、Redis、邮件和 Google Client Secret 只属于 API 运行环境。
- 生产入口使用同一公开 Origin 的路径路由：`BETTER_AUTH_URL`、Web Origin 与 `NEXT_PUBLIC_API_URL` 指向同一外部 Origin，Ingress 将 `/api/auth/*` 和 `/v1/*` 转发给 API，其余路径转发给 Web。这样 Host-only Session Cookie 会随 `/home` 请求到达 Web，并可由 Web 服务端原样转发给内部 API；不依赖跨子域 Cookie。
- API 只信任 `API_TRUSTED_PROXY_CIDRS` 明确列出的 Ingress IP/CIDR，并在这一边界解析客户端地址；传给 Better Auth 的限流地址由 API 覆盖，非可信 socket 即使伪造 `X-Forwarded-For` 或内部 Header 也只能使用自身地址作为限流键。Ingress 必须覆盖而非透传外部 XFF，API 不能绕过 Ingress 暴露到公网。
- `GOOGLE_AUTH_ENABLED` 只是控制 Web 是否显示 Google 按钮的非敏感运行配置，默认 `false`，必须与 API 是否配置完整 Google Client 凭据保持一致。它由 Web 服务端读取后作为布尔属性传给登录组件，不会把 Google Client Secret 放入 Web 镜像或浏览器。
- API 根据 Better Auth Session 的 User ID 查询唯一 `platform.owners.auth_user_id`，再返回稳定 `OwnerSessionResponse`。Owner API 不接受客户端提供的 `owner_id`，也不向 Web 返回 Better Auth 内部 User ID、Token 或 Provider 记录。
- Better Auth 的公开路径收缩到首版实际需要的注册、登录、验证、恢复、退出和 Google 回调；账户关联、账户枚举、Session 枚举／撤销、更新用户与直接 `get-session` 等内建路径默认关闭。邮箱注册和登录响应在 Fastify 边界剥离 Better Auth User ID 与 bearer Session Token，只保留 HttpOnly Cookie 和成功状态。
- `auth.users` 与 `platform.owners` 保持显式一对一映射。邮箱在认证表中是登录事实，在 Owner 表中只作受数据库约束同步的投影。
- Owner Session 只证明人类身份并返回实时 Owner 状态，不等于领域写入授权。后续 Owner API 必须在每次请求按 `active/restricted/suspended/closed` 的当前状态走集中式授权；不得只判断“存在 Session”。

### 账户关联

- 禁止依据相同邮箱隐式合并 Google 与邮箱密码账户，也禁止关联不同邮箱。
- MVP 不提供自动账户合并。用户应使用最初注册方式登录；未来若增加显式关联，必须在一个新鲜的 Owner Session 中重新验证两个 Provider，并写入安全审计。
- Provider Token 加密存储，不放入浏览器 Session DTO 或运营日志。Google scope 仅为 `openid`、`email`、`profile`。

### 邮件与成本控制

- 生产邮件通过可替换的 Provider Adapter 发送；首个 Provider 为 Resend。验证码/链接发送成本不会随社区读取流量增长，只随真实注册、重发和恢复动作增长。
- 验证与恢复端点分别做分布式限流；邮件层再执行收件人冷却、收件人小时上限和全局每日硬上限。达到上限时失败关闭，并留下不含邮箱或 Token 的可观测事件，不能无限重试或无限发送。
- 本地 `local-preview` 只允许非生产进程和 loopback `BETTER_AUTH_URL`，用于把测试链接写到本地日志；它不能在测试/预览公网上代替真实邮件。
- 验证邮件 24 小时过期，密码恢复 30 分钟过期；密码重置后撤销既有 Session。
- 密码恢复邮件直接链接到 Web 的 `/reset-password#token=…`。Fragment 不发送给 Web、Ingress 或 Referer；客户端读取后立即用 `history.replaceState` 清除，再只把 Token 放入重置 POST body。旧的 `/api/auth/reset-password/:token` GET 回调不公开。
- 密码登录与密码重置从邮箱或 Token 定位 Owner 后，共用独立数据库连接上的 per-Owner PostgreSQL advisory lock。它把“旧密码校验与 Session 创建”和“Token 消费、密码写入与 Session 撤销”排成单一顺序，避免并发登录跨过凭证更新边界。未知但格式合理的登录邮箱执行同等查询和锁流程，并使用服务密钥派生的匿名锁键，避免重新引入账户枚举时序差异。锁池与认证查询池隔离，等待者不会耗尽认证连接；并发的兄弟 Token 只能有一个成功。凭证写入触发器在同一数据库事务中清除其余恢复 Token 和全部旧 Session，进程即使在随后步骤崩溃也不会保留基于旧密码创建的会话。API 拒绝 query-string Token。
- 认证与 Owner Session 响应统一使用 `Cache-Control: no-store, private`。Ingress/CDN/托管平台还必须禁止记录 `/api/auth/*` 的 query string，并把认证路径按模板记录，避免验证 Token、OAuth code/state 或未来凭证进入上游访问日志。

### 启动期安全约束

API 在监听端口前验证：

- `BETTER_AUTH_URL` 是显式、规范、无 path/query/fragment/credentials/wildcard 的静态 origin；
- `AUTH_TRUSTED_ORIGINS` 是去重后的精确 origin allowlist，并被 CORS allowlist 完整覆盖；
- `BETTER_AUTH_SECRET` 长度和随机性达到要求，且生产不使用仓库公开的本地 Secret；
- 生产 URL 与所有可信浏览器 Origin 使用 HTTPS，Secure Cookie 必须开启；
- 生产必须显式配置至少一个非 catch-all 的可信 Ingress IP/CIDR，并通过网络策略阻止客户端直连 API；
- Resend 模式同时具备 API Key 与合法 From 地址；
- Google Client ID/Secret 要么同时存在，要么同时缺失；
- 数据库连接池和全局每日邮件额度处于代码定义的有界范围。

违反任一条件时 API 拒绝启动，不以警告后继续运行。

## Consequences

正面结果：

- Google 快捷登录与中国用户可用的邮箱密码入口可以并存；
- Web 不掌握认证、邮件、数据库或 OAuth Provider Secret；
- 平台 Owner 状态可以独立于认证 Provider 执行限制、暂停与关闭；
- 邮件成本有明确硬上限，批量注册不会直接变成无界 Provider 账单；
- 静态 URL、可信 Origin 与 Secure Cookie 在部署错误时提前失败。

代价与约束：

- 相同邮箱分别使用两种登录方式时不会自动合并，支持流程必须清楚解释这一点；
- 生产必须配置邮件 Provider，不能依赖控制台链接；
- API 是登录与领域 Session 的统一可用性边界，需要独立容量、限流和告警；
- 新增其他 OAuth Provider 或显式关联流程时必须新增安全评审和迁移，不得只打开 Better Auth 默认选项。

## Rejected alternatives

### 只提供 Google 登录

拒绝。它会直接排除或显著阻碍无法使用 Google 的用户，并把账户恢复能力绑定到单一供应商。

### 自行实现密码、验证 Token 和 Session

拒绝。首版没有理由承担密码学、Token 生命周期、Provider 回调和账户恢复的完整自研攻击面。

### 在 Next.js 与 Fastify 各托管一部分认证

拒绝。它会产生两套 Cookie、Origin、错误和 Session 边界，并让 Web 获得不必要的服务端 Secret。

### 按相同邮箱自动合并 Provider

拒绝。邮箱字符串相同不等于已经完成两个账户的显式控制权证明；隐式合并会制造账户接管路径。
