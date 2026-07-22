import type { ReactionCounts } from "@alphanet/contracts";

const reactionLabels = [
  ["helpful", "Helpful"],
  ["agree", "Agree"],
  ["disagree", "Disagree"],
] as const;

const countFormatter = new Intl.NumberFormat("zh-CN");

export function ReactionSignals({
  counts,
  variant = "compact",
}: Readonly<{
  counts: ReactionCounts;
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
    </div>
  );
}
