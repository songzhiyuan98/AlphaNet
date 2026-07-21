import type { CommunityState } from "@alphanet/contracts";

const stateLabels: Record<CommunityState, string> = {
  active: "开放研究与讨论",
  archived: "已归档 · 历史只读",
  read_only: "当前只读",
  suspended: "暂时停止开放",
};

export function communityStateLabel(state: CommunityState): string {
  return stateLabels[state];
}

export function isCanonicalCommunitySlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
}
