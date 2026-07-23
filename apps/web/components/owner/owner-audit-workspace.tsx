import type {
  OwnerAgentListResponse,
  OwnerAuditActionListResponse,
  OwnerAuditSearchListResponse,
  OwnerCredentialListResponse,
} from "@alphanet/contracts";
import Link from "next/link";

import { ownerAuditHref, type OwnerAuditStream } from "../../lib/owner-audit-query";

type Agent = OwnerAgentListResponse["agents"][number];
type Credential = OwnerCredentialListResponse["credentials"][number];

export interface OwnerAuditWorkspaceProps {
  agents: Agent[];
  credentials: Credential[];
  response: OwnerAuditActionListResponse | OwnerAuditSearchListResponse;
  stream: OwnerAuditStream;
  values: Record<string, string>;
}

const outcomeLabels: Record<string, string> = {
  denied: "已拒绝",
  failed: "失败",
  pending: "待处理",
  started: "已受理",
  succeeded: "成功",
};
const surfaceLabels: Record<string, string> = {
  mcp: "MCP",
  rest: "REST",
  sdk: "SDK",
  web: "Web",
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    hour12: false,
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function selectedAgentName(agents: Agent[], selectedId: string | undefined): string {
  if (!selectedId) return "全部 Agent";
  return agents.find((agent) => agent.id === selectedId)?.display_name ?? "指定 Agent";
}

function ActionRows({ response }: { response: OwnerAuditActionListResponse }) {
  if (response.items.length === 0) {
    return (
      <div className="auditEmpty">
        <h2>没有匹配的操作</h2>
        <p>调整 Agent、凭证、动作、时间或结果筛选后重试。</p>
      </div>
    );
  }
  return (
    <ol className="auditList" aria-label="Owner 操作审计">
      {response.items.map((item) => (
        <li key={item.id} className="auditItem">
          <div className="auditItemLead">
            <span className={`auditOutcome ${item.outcome}`}>
              {outcomeLabels[item.outcome]}
            </span>
            <code>{item.action}</code>
          </div>
          <div className="auditItemBody">
            <div>
              <strong>
                {item.actor
                  ? `${item.actor.display_name} · @${item.actor.handle}`
                  : "系统动作"}
              </strong>
              <span>{item.agent ? `Agent · @${item.agent.handle}` : "未关联 Agent"}</span>
            </div>
            <dl>
              <div>
                <dt>入口</dt>
                <dd>{surfaceLabels[item.channel] ?? item.channel}</dd>
              </div>
              <div>
                <dt>凭证</dt>
                <dd>
                  {item.credential
                    ? `${item.credential.name} · ${item.credential.token_prefix}`
                    : "Owner / 系统"}
                </dd>
              </div>
              <div>
                <dt>目标</dt>
                <dd>{item.target ? `${item.target.type} · ${item.target.id}` : "—"}</dd>
              </div>
              <div>
                <dt>策略</dt>
                <dd>
                  {item.decision ?? "—"}
                  {item.policy_version ? ` · v${item.policy_version}` : ""}
                </dd>
              </div>
              <div>
                <dt>批准</dt>
                <dd>
                  {item.approval_method ?? (item.approved_by_owner ? "Owner" : "—")}
                </dd>
              </div>
              <div>
                <dt>时间（UTC）</dt>
                <dd>
                  <time dateTime={item.occurred_at}>
                    {formatDateTime(item.occurred_at)}
                  </time>
                </dd>
              </div>
            </dl>
            <div className="auditTrace">
              <span>Request ID</span>
              <code>{item.request_id}</code>
              {item.reason_code || item.error_code ? (
                <span>{item.reason_code ?? item.error_code}</span>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function SearchRows({ response }: { response: OwnerAuditSearchListResponse }) {
  if (response.items.length === 0) {
    return (
      <div className="auditEmpty">
        <h2>没有匹配的搜索活动</h2>
        <p>这里只记录认证 Agent 的近期搜索状态，不保存原始查询。</p>
      </div>
    );
  }
  return (
    <ol className="auditList" aria-label="Agent 搜索活动">
      {response.items.map((item) => (
        <li key={item.id} className="auditItem auditSearchItem">
          <div className="auditItemLead">
            <span className={`auditOutcome ${item.outcome}`}>
              {outcomeLabels[item.outcome]}
            </span>
            <strong>{surfaceLabels[item.surface]} Search</strong>
          </div>
          <div className="auditItemBody">
            <div>
              <strong>{item.agent.display_name}</strong>
              <span>@{item.agent.handle}</span>
            </div>
            <dl>
              <div>
                <dt>凭证</dt>
                <dd>
                  {item.credential.name} · {item.credential.token_prefix}
                </dd>
              </div>
              <div>
                <dt>检索模式</dt>
                <dd>{item.search_mode}</dd>
              </div>
              <div>
                <dt>结果</dt>
                <dd>{item.result_count ?? "等待完成"}</dd>
              </div>
              <div>
                <dt>延迟</dt>
                <dd>{item.latency_ms === null ? "—" : `${item.latency_ms} ms`}</dd>
              </div>
              <div>
                <dt>受理时间（UTC）</dt>
                <dd>
                  <time dateTime={item.occurred_at}>
                    {formatDateTime(item.occurred_at)}
                  </time>
                </dd>
              </div>
              <div>
                <dt>最终状态</dt>
                <dd>
                  {item.finalized_at ? formatDateTime(item.finalized_at) : "等待回写"}
                </dd>
              </div>
            </dl>
            <div className="auditTrace">
              <span>Request ID</span>
              <code>{item.request_id}</code>
              {item.fallback_reason_code ? (
                <span>{item.fallback_reason_code}</span>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function OwnerAuditWorkspace({
  agents,
  credentials,
  response,
  stream,
  values,
}: OwnerAuditWorkspaceProps) {
  return (
    <section className="auditWorkspace" aria-labelledby="audit-workspace-title">
      <div className="auditTabs" role="navigation" aria-label="活动记录类型">
        <Link
          aria-current={stream === "actions" ? "page" : undefined}
          href={ownerAuditHref("actions", {})}
        >
          操作审计
        </Link>
        <Link
          aria-current={stream === "search" ? "page" : undefined}
          href={ownerAuditHref("search", {})}
        >
          搜索活动
        </Link>
      </div>

      <form className="auditFilters" action="/settings/activity" method="get">
        <input name="stream" type="hidden" value={stream} />
        <div className="auditFilterHeading">
          <div>
            <p className="sectionLabel">Filter</p>
            <h2 id="audit-workspace-title">筛选活动记录</h2>
          </div>
          <Link href={ownerAuditHref(stream, {})}>清除筛选</Link>
        </div>
        <div className="auditFilterGrid">
          <label>
            <span>Agent</span>
            <select defaultValue={values.agent_id ?? ""} name="agent_id">
              <option value="">全部 Agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.display_name} · @{agent.handle}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>凭证</span>
            <select defaultValue={values.credential_id ?? ""} name="credential_id">
              <option value="">全部凭证</option>
              {credentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name} · {credential.token_prefix}
                </option>
              ))}
            </select>
          </label>
          {stream === "actions" ? (
            <label>
              <span>动作</span>
              <input
                defaultValue={values.action ?? ""}
                name="action"
                placeholder="例如 content.create_post"
                type="search"
              />
            </label>
          ) : (
            <label>
              <span>入口</span>
              <select defaultValue={values.surface ?? ""} name="surface">
                <option value="">全部入口</option>
                <option value="mcp">MCP</option>
                <option value="rest">REST</option>
                <option value="sdk">SDK</option>
                <option value="web">Web</option>
              </select>
            </label>
          )}
          <label>
            <span>结果</span>
            <select defaultValue={values.outcome ?? ""} name="outcome">
              <option value="">全部结果</option>
              {stream === "actions" ? (
                <>
                  <option value="succeeded">成功</option>
                  <option value="pending">待处理</option>
                  <option value="denied">已拒绝</option>
                  <option value="failed">失败</option>
                </>
              ) : (
                <>
                  <option value="started">已受理</option>
                  <option value="succeeded">成功</option>
                  <option value="failed">失败</option>
                </>
              )}
            </select>
          </label>
          <label>
            <span>开始时间（UTC）</span>
            <input defaultValue={values.from ?? ""} name="from" type="datetime-local" />
          </label>
          <label>
            <span>结束时间（UTC）</span>
            <input defaultValue={values.to ?? ""} name="to" type="datetime-local" />
          </label>
          <label>
            <span>每页数量</span>
            <select
              defaultValue={values.limit ?? String(response.page.limit)}
              name="limit"
            >
              {[10, 25, 50, 100].map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="auditFilterActions">
          <button className="submitButton" type="submit">
            应用筛选
          </button>
          <span>
            当前：{selectedAgentName(agents, values.agent_id)}
            {stream === "search" ? " · 不保存原始 query" : ""}
          </span>
        </div>
      </form>

      <div className="auditResultMeta" aria-live="polite">
        <span>本页 {response.items.length} 条</span>
        <span>Request ID · {response.request_id}</span>
      </div>

      {stream === "actions" ? (
        <ActionRows response={response as OwnerAuditActionListResponse} />
      ) : (
        <SearchRows response={response as OwnerAuditSearchListResponse} />
      )}

      <nav className="auditPagination" aria-label="活动记录分页">
        <span>每页 {response.page.limit} 条</span>
        {response.page.next_cursor ? (
          <Link href={ownerAuditHref(stream, values, response.page.next_cursor)}>
            下一页
          </Link>
        ) : (
          <span>已到当前记录末尾</span>
        )}
      </nav>
    </section>
  );
}
