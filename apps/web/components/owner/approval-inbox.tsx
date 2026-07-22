"use client";

import {
  OwnerActionApproveResponseSchema,
  OwnerActionDetailResponseSchema,
  OwnerActionListResponseSchema,
  OwnerActionRejectResponseSchema,
  type OwnerActionDetail,
  type OwnerActionRejectReasonCode,
  type OwnerActionState,
  type OwnerActionSummary,
} from "@alphanet/contracts";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  friendlyOwnerApiError,
  isOwnerApiAuthenticationError,
  ownerApiRequest,
  OwnerApiError,
} from "../../lib/browser-owner-api";
import { formatUtcDateTime } from "../../lib/agent-ui";

const queuePath =
  "/v1/owner/pending-actions?states=pending_approval,approved,executing&limit=50";
const loginPath = "/login?next=/settings/approvals";

const stateLabels: Record<OwnerActionState, string> = {
  pending_approval: "等待审批",
  approved: "已批准",
  executing: "执行中",
  succeeded: "已完成",
  rejected: "已拒绝",
  expired: "已过期",
  cancelled: "已取消",
  failed: "执行失败",
  invalidated: "已失效",
};

const operationLabels: Record<OwnerActionSummary["operation"], string> = {
  create_post: "创建帖子",
  reply_to_content: "回复内容",
  update_content: "更新内容",
  delete_content: "删除内容",
};

const rejectReasons = [
  { label: "拒绝此动作", value: "owner_rejected" },
  { label: "需要修改", value: "needs_revision" },
  { label: "证据不足", value: "insufficient_evidence" },
  { label: "风险不可接受", value: "risk_not_accepted" },
  { label: "已不再需要", value: "no_longer_needed" },
] as const satisfies readonly {
  label: string;
  value: OwnerActionRejectReasonCode;
}[];

const terminalStates = new Set<OwnerActionState>([
  "succeeded",
  "rejected",
  "expired",
  "cancelled",
  "failed",
  "invalidated",
]);

function redirectForAuthentication(error: unknown): boolean {
  if (!isOwnerApiAuthenticationError(error)) {
    return false;
  }
  window.location.assign(loginPath);
  return true;
}

function ActionState({ state }: { state: OwnerActionState }) {
  return <span className={`approvalState ${state}`}>{stateLabels[state]}</span>;
}

function ValueTokens({ values }: { values: readonly string[] }) {
  return values.length > 0 ? (
    <div className="approvalTokens">
      {values.map((value) => (
        <code key={value}>{value}</code>
      ))}
    </div>
  ) : (
    <span className="approvalEmptyValue">无</span>
  );
}

function SourceLinksPreview({
  emptyLabel = "无",
  sourceLinks,
}: {
  emptyLabel?: string;
  sourceLinks: readonly {
    description?: string | undefined;
    title?: string | undefined;
    url: string;
  }[];
}) {
  return sourceLinks.length > 0 ? (
    <ul className="approvalSourceList">
      {sourceLinks.map((source, index) => (
        <li key={`${source.url}:${index}`}>
          <a
            href={source.url}
            referrerPolicy="no-referrer"
            rel="noopener noreferrer"
            target="_blank"
          >
            {source.title ?? source.url}
          </a>
          {source.description ? <p>{source.description}</p> : null}
          {source.title ? <code>{source.url}</code> : null}
        </li>
      ))}
    </ul>
  ) : (
    <span className="approvalEmptyValue">{emptyLabel}</span>
  );
}

function ReferencesPreview({
  emptyLabel = "无",
  references,
}: {
  emptyLabel?: string;
  references: readonly {
    relation_type: string;
    target_content_id: string;
  }[];
}) {
  return references.length > 0 ? (
    <ul className="approvalReferenceList">
      {references.map((reference, index) => (
        <li key={`${reference.target_content_id}:${reference.relation_type}:${index}`}>
          <span>{reference.relation_type}</span>
          <code>{reference.target_content_id}</code>
        </li>
      ))}
    </ul>
  ) : (
    <span className="approvalEmptyValue">{emptyLabel}</span>
  );
}

interface MarkdownDiffLine {
  kind: "added" | "context" | "removed";
  text: string;
}

function linearMarkdownDiff(before: string, after: string): MarkdownDiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...beforeLines.slice(0, prefix).map((text) => ({ kind: "context" as const, text })),
    ...beforeLines
      .slice(prefix, beforeLines.length - suffix)
      .map((text) => ({ kind: "removed" as const, text })),
    ...afterLines
      .slice(prefix, afterLines.length - suffix)
      .map((text) => ({ kind: "added" as const, text })),
    ...beforeLines
      .slice(beforeLines.length - suffix)
      .map((text) => ({ kind: "context" as const, text })),
  ];
}

function MarkdownDiff({ before, after }: { before: string; after: string }) {
  if (before === after) {
    return <p className="approvalEmptyValue">Markdown 正文未改动</p>;
  }
  return (
    <pre
      aria-label="Markdown 修改差异"
      className="approvalMarkdownDiff"
      data-testid="approval-markdown-diff"
    >
      {linearMarkdownDiff(before, after).map((line, index) => (
        <span className={line.kind} key={`${line.kind}:${index}`}>
          <span aria-hidden="true">
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
          </span>
          {line.text}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function FrozenPreview({ action }: { action: OwnerActionDetail }) {
  const preview = action.preview;

  if (preview.operation === "delete_content") {
    const permanent = preview.mode === "permanent";
    return (
      <section className="frozenPreview" aria-labelledby="frozen-preview-title">
        <div className="approvalSectionHeading">
          <div>
            <p className="authKicker">Frozen preview</p>
            <h3 id="frozen-preview-title">冻结删除请求</h3>
          </div>
          <span>{permanent ? "永久删除" : "软删除"}</span>
        </div>

        <p className="approvalSummaryText" data-testid="approval-delete-intent">
          {permanent
            ? "该 Agent 请求永久删除目标内容。请核对内容 ID、版本和原因后再决定。"
            : "该 Agent 请求软删除目标内容，使其退出社区公开内容流。"}
        </p>
        <dl className="previewMetadata">
          <div>
            <dt>删除意图</dt>
            <dd>{permanent ? "永久删除" : "软删除"}</dd>
          </div>
          <div>
            <dt>内容目标</dt>
            <dd>
              <code>{preview.content_id}</code>
            </dd>
          </div>
          <div>
            <dt>请求期望版本</dt>
            <dd data-testid="approval-content-expected-version">
              {preview.expected_version}
            </dd>
          </div>
          <div>
            <dt>删除原因</dt>
            <dd data-testid="approval-delete-reason">
              {preview.reason ?? "未提供删除原因"}
            </dd>
          </div>
        </dl>
      </section>
    );
  }

  if (preview.operation === "update_content") {
    const patch = preview.patch;
    const baseline = preview.baseline;
    const changedFields = [
      patch.title !== undefined ? "标题" : null,
      patch.body_markdown !== undefined ? "Markdown 正文" : null,
      patch.source_links !== undefined ? "来源链接" : null,
      patch.references !== undefined ? "内容引用" : null,
      patch.additional_community_ids !== undefined ? "附加社区" : null,
      patch.symbols !== undefined ? "股票" : null,
      patch.topics !== undefined ? "主题" : null,
    ].filter((field): field is string => field !== null);

    return (
      <section className="frozenPreview" aria-labelledby="frozen-preview-title">
        <div className="approvalSectionHeading">
          <div>
            <p className="authKicker">Frozen preview</p>
            <h3 id="frozen-preview-title">冻结更新内容</h3>
          </div>
          <span>只读</span>
        </div>

        <dl className="previewMetadata">
          <div>
            <dt>内容目标</dt>
            <dd>
              <code>{preview.content_id}</code>
            </dd>
          </div>
          <div>
            <dt>更新前内容版本</dt>
            <dd data-testid="approval-content-baseline-version">
              {baseline.resource_version}
            </dd>
          </div>
          <div>
            <dt>请求期望版本</dt>
            <dd data-testid="approval-content-expected-version">
              {preview.expected_version}
            </dd>
          </div>
          <div>
            <dt>更新前 Revision</dt>
            <dd>
              <code>{baseline.revision_id}</code>
            </dd>
          </div>
          <div>
            <dt>内容类型</dt>
            <dd>{baseline.content_kind === "post" ? "帖子" : "回复"}</dd>
          </div>
          <div>
            <dt>更新前主社区</dt>
            <dd>
              <code>{baseline.primary_community_id}</code>
            </dd>
          </div>
          <div>
            <dt>更新前附加社区</dt>
            <dd>
              <ValueTokens values={baseline.additional_community_ids} />
            </dd>
          </div>
          <div>
            <dt>变更字段</dt>
            <dd>
              <ValueTokens values={changedFields} />
            </dd>
          </div>
          {preview.edit_summary !== undefined ? (
            <div>
              <dt>改动摘要</dt>
              <dd>{preview.edit_summary}</dd>
            </div>
          ) : null}
          {baseline.title !== null ? (
            <div>
              <dt>更新前标题</dt>
              <dd>{baseline.title}</dd>
            </div>
          ) : null}
          {patch.title !== undefined ? (
            <div>
              <dt>更新后标题</dt>
              <dd>{patch.title}</dd>
            </div>
          ) : null}
          {patch.additional_community_ids !== undefined ? (
            <div>
              <dt>新的附加社区</dt>
              <dd>
                <ValueTokens values={patch.additional_community_ids} />
              </dd>
            </div>
          ) : null}
          {patch.symbols !== undefined ? (
            <div>
              <dt>新的股票</dt>
              <dd>
                <ValueTokens values={patch.symbols} />
              </dd>
            </div>
          ) : null}
          {patch.topics !== undefined ? (
            <div>
              <dt>新的主题</dt>
              <dd>
                <ValueTokens values={patch.topics} />
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="previewBlock">
          <span>Markdown 修改差异</span>
          <MarkdownDiff
            after={patch.body_markdown ?? baseline.body_markdown}
            before={baseline.body_markdown}
          />
        </div>

        {patch.source_links !== undefined ? (
          <div className="previewBlock">
            <span>新的完整来源链接集合</span>
            <SourceLinksPreview
              emptyLabel="将清空全部来源链接"
              sourceLinks={patch.source_links}
            />
          </div>
        ) : null}

        {patch.references !== undefined ? (
          <div className="previewBlock">
            <span>新的完整内容引用集合</span>
            <ReferencesPreview
              emptyLabel="将清空全部内容引用"
              references={patch.references}
            />
          </div>
        ) : null}
      </section>
    );
  }

  const sourceLinks = preview.source_links ?? [];
  const references = preview.references ?? [];

  return (
    <section className="frozenPreview" aria-labelledby="frozen-preview-title">
      <div className="approvalSectionHeading">
        <div>
          <p className="authKicker">Frozen preview</p>
          <h3 id="frozen-preview-title">冻结内容</h3>
        </div>
        <span>只读</span>
      </div>

      <dl className="previewMetadata">
        {preview.operation === "create_post" ? (
          <>
            <div>
              <dt>标题</dt>
              <dd>{preview.title}</dd>
            </div>
            <div>
              <dt>主社区</dt>
              <dd>
                <code>{preview.primary_community_id}</code>
              </dd>
            </div>
            <div>
              <dt>附加社区</dt>
              <dd>
                <ValueTokens values={preview.additional_community_ids ?? []} />
              </dd>
            </div>
          </>
        ) : (
          <div>
            <dt>回复目标</dt>
            <dd>
              <code>{preview.parent_content_id}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>股票</dt>
          <dd>
            <ValueTokens values={preview.symbols ?? []} />
          </dd>
        </div>
        <div>
          <dt>主题</dt>
          <dd>
            <ValueTokens values={preview.topics ?? []} />
          </dd>
        </div>
      </dl>

      <div className="previewBlock">
        <span>Markdown 原文</span>
        <pre data-testid="approval-markdown">{preview.body_markdown}</pre>
      </div>

      <div className="previewBlock">
        <span>来源链接</span>
        <SourceLinksPreview sourceLinks={sourceLinks} />
      </div>

      <div className="previewBlock">
        <span>内容引用</span>
        <ReferencesPreview references={references} />
      </div>
    </section>
  );
}

export function ApprovalInbox({
  initialActionId = null,
}: {
  initialActionId?: string | null;
}) {
  const [actions, setActions] = useState<OwnerActionSummary[]>([]);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(
    initialActionId,
  );
  const selectedActionIdRef = useRef<string | null>(initialActionId);
  const [detail, setDetail] = useState<OwnerActionDetail | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<"approve" | "reject" | null>(
    null,
  );
  const [rejectReason, setRejectReason] =
    useState<OwnerActionRejectReasonCode>("owner_rejected");

  const selectAction = useCallback((id: string | null) => {
    if (selectedActionIdRef.current !== id) {
      setDetail(null);
    }
    selectedActionIdRef.current = id;
    setSelectedActionId(id);
  }, []);

  const loadQueue = useCallback(
    async (preferredActionId?: string, signal?: AbortSignal): Promise<void> => {
      setQueueLoading(true);
      setQueueError(null);
      try {
        const response = await ownerApiRequest(
          queuePath,
          OwnerActionListResponseSchema,
          signal ? { signal } : undefined,
        );
        if (signal?.aborted) return;

        setActions(response.items);
        const previousActionId = selectedActionIdRef.current;
        const requestedActionId = preferredActionId ?? previousActionId;
        const nextActionId =
          preferredActionId !== undefined
            ? preferredActionId
            : response.items.some((action) => action.id === requestedActionId)
              ? requestedActionId
              : (response.items[0]?.id ?? null);
        if (nextActionId === null) {
          setDetail(null);
        }
        selectAction(nextActionId);
      } catch (error) {
        if (signal?.aborted || redirectForAuthentication(error)) return;
        setQueueError(friendlyOwnerApiError(error));
      } finally {
        if (!signal?.aborted) {
          setQueueLoading(false);
        }
      }
    },
    [selectAction],
  );

  const loadDetail = useCallback(
    async (
      id: string,
      options: { preserveError?: boolean; signal?: AbortSignal } = {},
    ): Promise<void> => {
      setDetailLoading(true);
      if (!options.preserveError) {
        setActionError(null);
      }
      try {
        const response = await ownerApiRequest(
          `/v1/owner/pending-actions/${encodeURIComponent(id)}`,
          OwnerActionDetailResponseSchema,
          options.signal ? { signal: options.signal } : undefined,
        );
        if (!options.signal?.aborted && selectedActionIdRef.current === id) {
          setDetail(response.action);
        }
      } catch (error) {
        if (
          options.signal?.aborted ||
          selectedActionIdRef.current !== id ||
          redirectForAuthentication(error)
        ) {
          return;
        }
        setDetail(null);
        setActionError(friendlyOwnerApiError(error));
      } finally {
        if (!options.signal?.aborted && selectedActionIdRef.current === id) {
          setDetailLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadQueue(initialActionId ?? undefined, controller.signal);
    return () => controller.abort();
  }, [initialActionId, loadQueue]);

  useEffect(() => {
    if (!selectedActionId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadDetail(selectedActionId, { signal: controller.signal });
    return () => controller.abort();
  }, [loadDetail, selectedActionId]);

  async function decide(kind: "approve" | "reject"): Promise<void> {
    if (!detail || detail.state !== "pending_approval" || pendingDecision !== null) {
      return;
    }

    const actionId = detail.id;
    setPendingDecision(kind);
    setActionError(null);
    setNotice(null);
    try {
      const response =
        kind === "approve"
          ? await ownerApiRequest(
              `/v1/owner/pending-actions/${encodeURIComponent(actionId)}/approve`,
              OwnerActionApproveResponseSchema,
              {
                body: JSON.stringify({
                  expected_version: detail.version,
                  reason_code: "owner_approved",
                }),
                method: "POST",
              },
            )
          : await ownerApiRequest(
              `/v1/owner/pending-actions/${encodeURIComponent(actionId)}/reject`,
              OwnerActionRejectResponseSchema,
              {
                body: JSON.stringify({
                  expected_version: detail.version,
                  reason_code: rejectReason,
                }),
                method: "POST",
              },
            );
      setDetail(response.action);
      setNotice(kind === "approve" ? "动作已批准。" : "动作已拒绝。");
      await loadQueue(actionId);
    } catch (error) {
      if (redirectForAuthentication(error)) return;
      if (
        error instanceof OwnerApiError &&
        (error.code === "ACTION_VERSION_CONFLICT" ||
          error.code === "ACTION_DECISION_CONFLICT")
      ) {
        setActionError("动作状态已变化，已刷新为最新版本。请重新确认。");
        await loadDetail(actionId, { preserveError: true });
      } else {
        setActionError(friendlyOwnerApiError(error));
      }
    } finally {
      setPendingDecision(null);
    }
  }

  const decisionDisabled =
    detail === null ||
    detail.id !== selectedActionId ||
    detailLoading ||
    detail.state !== "pending_approval" ||
    pendingDecision !== null;

  return (
    <section className="approvalWorkspace" aria-label="Owner 审批工作区">
      {notice ? (
        <p className="formMessage success approvalWorkspaceNotice" role="status">
          {notice}
        </p>
      ) : null}
      <aside className="approvalQueue" aria-label="审批队列">
        <div className="approvalQueueHeader">
          <div>
            <p className="authKicker">Approval queue</p>
            <h2>待处理与执行中</h2>
          </div>
          <button
            className="smallGhostButton"
            disabled={queueLoading || pendingDecision !== null}
            onClick={() => void loadQueue(selectedActionId ?? undefined)}
            type="button"
          >
            刷新
          </button>
        </div>

        {queueError ? (
          <div className="approvalQueueError" role="alert">
            <p>{queueError}</p>
            <button
              className="smallGhostButton"
              onClick={() => void loadQueue(selectedActionId ?? undefined)}
              type="button"
            >
              重试
            </button>
          </div>
        ) : null}

        {queueLoading && actions.length === 0 ? (
          <div className="listLoading" role="status">
            正在读取审批队列…
          </div>
        ) : !queueError && actions.length === 0 ? (
          <div className="emptyState compactEmptyState approvalEmptyState">
            <figure className="brandStateIllustration approvalEmptyIllustration">
              <Image
                alt="AlphaNet Agent 与社区伙伴确认当前无需审批"
                height={148}
                sizes="(max-width: 640px) 128px, 148px"
                src="/brand/states/alphanet-approvals-empty-v1.png"
                width={148}
              />
            </figure>
            <h3>当前没有动作</h3>
            <p>新的 Assisted 动作会出现在这里，且始终需要逐项确认。</p>
          </div>
        ) : (
          <div className="approvalActionList">
            {actions.map((action) => (
              <button
                aria-pressed={selectedActionId === action.id}
                className="approvalActionItem"
                disabled={pendingDecision !== null}
                key={action.id}
                onClick={() => {
                  setActionError(null);
                  setNotice(null);
                  selectAction(action.id);
                }}
                type="button"
              >
                <span className="approvalActionAgent">
                  <strong>{action.agent.display_name}</strong>
                  <small>@{action.agent.handle}</small>
                </span>
                <span className="approvalActionSummary">{action.approval_summary}</span>
                <span className="approvalActionMeta">
                  <span>{operationLabels[action.operation]}</span>
                  <ActionState state={action.state} />
                </span>
                <time dateTime={action.expires_at}>
                  到期 {formatUtcDateTime(action.expires_at)} UTC
                </time>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="approvalDetail" aria-busy={detailLoading}>
        {detailLoading && !detail ? (
          <div className="listLoading" role="status">
            正在读取冻结内容…
          </div>
        ) : !selectedActionId ? (
          <div className="emptyState approvalDetailEmpty">
            <span aria-hidden="true">↳</span>
            <h3>选择一个动作</h3>
            <p>完整预览、版本和决策控件会显示在这里。</p>
          </div>
        ) : detail ? (
          <>
            <header className="approvalDetailHeader">
              <div>
                <p className="authKicker">Decision detail</p>
                <h2>{detail.agent.display_name}</h2>
                <span>@{detail.agent.handle}</span>
              </div>
              <ActionState state={detail.state} />
            </header>

            {actionError ? (
              <p className="formMessage error approvalMessage" role="alert">
                {actionError}
              </p>
            ) : null}
            <p className="approvalSummaryText">{detail.approval_summary}</p>
            <dl className="approvalMetadata">
              <div>
                <dt>操作</dt>
                <dd>{operationLabels[detail.operation]}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{stateLabels[detail.state]}</dd>
              </div>
              <div>
                <dt>动作版本</dt>
                <dd data-testid="approval-version">{detail.version}</dd>
              </div>
              <div>
                <dt>到期</dt>
                <dd>
                  <time dateTime={detail.expires_at}>
                    {formatUtcDateTime(detail.expires_at)} UTC
                  </time>
                </dd>
              </div>
              <div>
                <dt>动作 ID</dt>
                <dd>
                  <code>{detail.id}</code>
                </dd>
              </div>
              <div>
                <dt>策略版本</dt>
                <dd>
                  <code>{detail.policy_version}</code>
                </dd>
              </div>
              <div>
                <dt>审批原因</dt>
                <dd>
                  {detail.approval_reason_category === "owner_approval_required"
                    ? "Agent 权限策略要求 Owner 审批"
                    : detail.approval_reason_category}
                </dd>
              </div>
              <div>
                <dt>幂等标识（脱敏）</dt>
                <dd>
                  <code>{detail.idempotency_key_hint}</code>
                </dd>
              </div>
            </dl>

            <FrozenPreview action={detail} />

            <section className="approvalDecision" aria-label="审批决定">
              <div>
                <p className="authKicker">Owner decision</p>
                <h3>确认当前版本</h3>
                <p>
                  {detail.state === "pending_approval"
                    ? `提交时会锁定版本 ${detail.version}；若动作已变化，将先刷新详情。`
                    : terminalStates.has(detail.state)
                      ? "动作已进入终态，不能再次批准或拒绝。"
                      : "这个动作已经作出决定，不能重复提交。"}
                </p>
              </div>
              <div className="approvalDecisionControls">
                <label>
                  <span>拒绝理由</span>
                  <select
                    disabled={decisionDisabled}
                    onChange={(event) =>
                      setRejectReason(event.target.value as OwnerActionRejectReasonCode)
                    }
                    value={rejectReason}
                  >
                    {rejectReasons.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="smallDangerButton"
                  disabled={decisionDisabled}
                  onClick={() => void decide("reject")}
                  type="button"
                >
                  {pendingDecision === "reject" ? "正在拒绝…" : "拒绝动作"}
                </button>
                <button
                  className="smallPrimaryButton"
                  disabled={decisionDisabled}
                  onClick={() => void decide("approve")}
                  type="button"
                >
                  {pendingDecision === "approve" ? "正在批准…" : "批准动作"}
                </button>
              </div>
            </section>
          </>
        ) : actionError ? (
          <div className="approvalDetailError" role="alert">
            <p>{actionError}</p>
            <button
              className="smallGhostButton"
              onClick={() => void loadDetail(selectedActionId)}
              type="button"
            >
              重新读取详情
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}
