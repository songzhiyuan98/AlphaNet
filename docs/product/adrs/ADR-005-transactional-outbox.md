# ADR-005：Transactional Outbox 与幂等 Worker

## Status

Accepted — 2026-07-19

## Context

内容写入时，每个不可变 Revision 的 PostgreSQL generated FTS `search_document` 与正文同步提交；写入后仍需异步生成语义 embedding／pgvector chunk、通知、重复与滥用检测和分析聚合。在请求内同步完成这些外部或派生副作用会增加写入延迟并让其故障阻止正常发帖。直接在数据库提交后向队列发布存在双写窗口：数据库成功但事件丢失，或事件已发布而事务回滚。

MVP 使用 PostgreSQL，要求 99% 索引与通知在 60 秒内完成，同时需要在 Worker 重启和备份恢复后安全重放。

## Decision

所有需要异步处理的领域事务在同一个 PostgreSQL 事务中写入 `outbox_events`。API 只在领域写入、ActionLog 和 OutboxEvent 全部提交后返回成功。

每个 aggregate 的首个事件序列必须为 1，之后严格 `+1`。`outbox_events` 的 `BEFORE INSERT` trigger 先按 `(aggregate_type,aggregate_id)` 获取 transaction advisory lock，再读取并推进持久的 `outbox_aggregate_heads`。因此未提交的低序号生产者会阻塞同 aggregate 的高序号生产者，高序号不能先提交或先被消费；不同 aggregate 不互相阻塞。低序号事务提交后，高序号继续；低序号事务回滚且预期序号不再成立时，高序号插入以约束错误失败，调用方必须重新读取 head 并重试整个领域事务。Head 不随历史事件压缩删除。

每个命名消费者先在 `outbox_consumers` 持久注册订阅，再为命中的事件建立独立的 `outbox_consumer_deliveries` 进度行，按 `available_at,occurred_at,id` 锁定自己的批次并使用 `FOR UPDATE SKIP LOCKED` 支持同消费者的多 Worker 并发。投递语义为至少一次：

- 每个事件包含稳定 UUID、aggregate、event type、event version、创建时间和版本化 payload。
- `consumer_name` 必须版本化（例如 `search-indexer:v2`）。首次 claim 会持久化排序去重后的 event type 集合与包含式 `replay_from`；水位比较 `outbox_events.created_at`，而不是可由领域语义回填的 `occurred_at`。两者此后不可变；增加或删除 handler 必须使用新 consumer 版本并显式选择新水位。同一版本的所有副本必须使用完全相同的配置，禁止用进程启动时间动态生成水位。
- 每个消费者拥有独立的 lease、`attempts/max_attempts`、可用时间和终态；一个消费者完成不会吞掉其他消费者的事件。
- 每个消费者用 `outbox_consumer_receipts(consumer_name,event_id)` 或目标表唯一键保证副作用幂等；外部副作用必须使用 event ID 作为幂等键。
- 成功处理后在同一数据库语句中记录 delivery 的 `delivered_at` 和 receipt；失败采用有界指数退避并增加 `attempts`。
- Worker 在长处理期间续租；claim 必须返回 PostgreSQL 实际写入的 `lease_expires_at`，不能在请求返回后用本地时间重建首次 deadline。单次续租异常在保守的本地 lease deadline 前允许重试，明确返回 false 或本地到期后立即停止确认。最终仍由 PostgreSQL 的 owner 与未过期 lease 条件做权威 fencing，续租或确认被拒绝时不得假定自己仍拥有事件。
- 连续失败达到策略阈值后在该消费者的 delivery 上设置 `dead_lettered_at`、保留错误摘要并告警，不静默丢弃。最后一次租约期间崩溃时，由下一次 claim 原子转入 dead letter，不允许尝试计数越界。
- 管理员可以在修复原因后重放单个或一批事件；重放不改变原事件内容。

语义索引、通知、检测和分析使用独立消费者进度。同一消费者只可 claim 每个 `(aggregate_type,aggregate_id)` 最早尚未成功的 sequence；dead letter 默认阻塞该 aggregate 的后续事件，直到管理员作出受审计的 redrive 或 skip 决策。`aggregate_sequence` 是 PostgreSQL `bigint`，进入 JavaScript 后保持十进制字符串并用 `BigInt` 比较，禁止转换为 `number`。删除或隐藏事件获得更高消费优先级，API 查询仍以事实表做最终可见性校验。

## Consequences

正面结果：

- 消除数据库与消息发布之间的双写丢失窗口。
- 语义索引、通知或检测故障不阻止内容事务；generated FTS 随 Revision 事务同步可用。
- Worker 可水平扩展、重启和安全重放。
- 事件积压、重试和 dead-letter 状态可直接查询与告警。
- 初期无需运行独立消息代理，降低运维复杂度。

代价与约束：

- 异步结果最终一致，客户端需要接受短暂的语义索引和通知延迟；FTS 不属于该异步窗口。
- Worker 与每个消费者必须真正幂等，不能假设只处理一次。
- 同 aggregate 的生产者会串行等待；约束失败时必须重试完整领域事务，不能只补写 OutboxEvent。
- Outbox 会持续增长，需要归档、索引维护和分区计划。
- 新消费者版本的起始水位与历史回放范围必须显式配置；同名版本的 handler 集合漂移会启动失败，不能因滚动部署而无意回放全部历史。
- 高频轮询数据库会增加负载，需批处理、退避和监控。
- Event Schema 发布后必须兼容旧事件，不能依赖当前数据库行结构。

## Rejected alternatives

### 数据库提交后直接发布到消息队列

拒绝。没有分布式事务时存在不可恢复的事件丢失窗口。

### 在 API 请求内同步完成全部副作用

拒绝。无法满足写入延迟目标，且派生系统故障会扩大为发布故障。

### 定时扫描业务表推断变化

拒绝。难以准确识别事件、顺序与版本，删除和状态变化尤其容易遗漏。

### 首日引入 Kafka

拒绝。当前吞吐量不需要其集群成本。未来若 Outbox 消费成为瓶颈，可用 Outbox/CDC 向 Kafka 发布，领域事务语义保持不变。

### 最多一次投递

拒绝。故障时会永久丢失通知、索引或治理事件；至少一次加幂等消费者更符合社区记忆要求。
