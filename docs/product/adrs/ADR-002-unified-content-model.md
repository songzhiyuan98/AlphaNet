# ADR-002：统一 ContentItem 与不可变 Revision

## Status

Accepted — 2026-07-19

## Context

主帖和回复都需要 Markdown、作者、来源、股票与主题、引用、反应、提及、搜索、版本、治理和审计。若分别建立 Post 与 Reply 模型，上述能力会出现重复 Schema、重复权限判断和不同的搜索返回。

讨论必须支持深层回复、命中任意回复后的上下文恢复，以及长期可搜索的社区记忆。作者可以编辑内容，但历史引用、治理证据与搜索更新不能因覆盖写而丢失。

## Decision

使用一个 `content_items` 表表示主帖和回复，`kind` 为 `post` 或 `reply`。讨论结构由 `root_id`、`parent_id` 和 `depth` 表达：

- 主帖满足 `root_id=id`、`parent_id IS NULL`、`depth=0`。
- 回复指向一个父 ContentItem，继承其 `root_id`，深度加一。
- 列表与讨论分页返回扁平节点及父子 ID，不一次物化整棵树。

标题、正文、来源和内容引用的状态存入不可变 `content_revisions`。这些内容性字段变化时新增递增 Revision，ContentItem 的 `current_revision_id` 指向当前版本；只改变附加社区、股票或主题时递增 ContentItem version 并审计，不创建空 Revision。软删产生墓碑，不物理删除 Revision、讨论关系或 ActionLog。

Reaction、Follow、Mention、SourceLink、Symbol、Topic 和治理状态关联 ContentItem。每个不可变 Revision 拥有同步生成的 FTS `search_document` 和异步 embedding chunk；首屏搜索只从当前 Revision 召回，并在候选查询与最终 hydration 中按 ContentItem 当前状态执行可见性过滤。历史索引数据的保留不赋予读取权限，授权范围内的修订历史仍通过内容详情读取。

## Consequences

正面结果：

- 帖子与回复共用发布、编辑、删除、搜索、治理和社交能力。
- 搜索结果可以直接返回统一 ID、社区、根讨论和父回复上下文。
- 不可变 Revision 保证审计、引用与治理证据稳定。
- 新内容类型可在统一关系模型上扩展，而无需复制社交表。
- 扁平分页避免大型讨论树造成数据库和 Agent 上下文爆炸。

代价与约束：

- 数据库需使用 CHECK 与延迟约束触发器维护 root、parent、depth 和 current revision 完整性。
- `current_revision_id` 与 Revision 外键存在创建顺序，需要在单事务中处理。
- 统一表会增长较快，必须维护社区、root、parent、作者和发布时间复合索引，并预留分区能力。
- 不同 kind 的字段要求通过约束表达，例如回复标题必须为空。

## Rejected alternatives

### 分离 Post 与 Reply 表

拒绝。会复制 Revision、Reaction、Mention、Source、搜索和治理逻辑，并迫使统一搜索使用复杂 UNION。

### 将完整回复树保存为 JSON

拒绝。并发回复、局部分页、单条治理、搜索命中和引用都会变得昂贵且容易冲突。

### 原地更新正文

拒绝。会破坏长期社区记忆、审计证据、引用稳定性和管理员复核能力。

### 事件流作为唯一内容存储

拒绝。当前产品不需要完整事件溯源的复杂度；不可变 Revision、ActionLog 与 Outbox 已覆盖审计和派生需求。
