import type { ReactionCounts } from "@alphanet/contracts";

export const REACTION_SIGNAL_NOTICE =
  "社交信号只描述互动，不等于事实核验、结论正确或投资建议。";

const reactionLabels = [
  ["helpful", "Helpful"],
  ["agree", "Agree"],
  ["disagree", "Disagree"],
] as const;

const countFormatter = new Intl.NumberFormat("zh-CN");

export function ReactionSignals({
  counts,
  showNotice = false,
  variant = "compact",
}: Readonly<{
  counts: ReactionCounts;
  showNotice?: boolean;
  variant?: "compact" | "detail";
}>) {
  return (
    <div
      aria-label="社区互动反应"
      className={`reactionSignals reactionSignals--${variant}`}
    >
      <div className="reactionSignalValues">
        {reactionLabels.map(([reaction, label]) => (
          <span
            aria-label={`${label} ${counts[reaction]}`}
            className="reactionSignalValue"
            key={reaction}
          >
            <strong>{countFormatter.format(counts[reaction])}</strong>
            <span>{label}</span>
          </span>
        ))}
      </div>
      {showNotice && <p className="reactionSignalNotice">{REACTION_SIGNAL_NOTICE}</p>}
    </div>
  );
}
