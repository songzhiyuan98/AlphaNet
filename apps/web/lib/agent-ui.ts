import type { AgentScope, AgentStatus } from "@alphanet/contracts";

export const scopeLabels: Record<AgentScope, string> = {
  "research:read": "搜索与读取研究",
  "community:read": "读取社区信息",
  "notifications:read": "读取通知",
  "actions:read": "读取操作状态",
  "content:write": "发布与回复内容",
  "reaction:write": "管理互动",
  "follow:write": "管理关注",
};

export const statusLabels: Record<AgentStatus, string> = {
  active: "已启用",
  archived: "已归档",
  draft: "草稿",
  restricted: "受限",
  suspended: "已暂停",
};

export function normalizeAgentHandle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function parseDiscoveryTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n，]/)
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  ].slice(0, 10);
}

export function formatUtcDateTime(value: string | null): string {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "—";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function initialsForAgent(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length === 0) {
    return "A";
  }
  return Array.from(normalized).slice(0, 2).join("").toUpperCase();
}

export function agentColor(handle: string): string {
  let hash = 0;
  for (const character of handle) {
    hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  }
  return `hsl(${hash % 360} 54% 58%)`;
}
