"use client";

/**
 * Minimal loading skeleton — subtle shimmer placeholder with status text.
 */
export default function QuerySkeleton({
  accentColor = "#475EC7",
  step = "",
  elapsed = 0,
}: {
  accentColor?: string;
  step?: string;
  elapsed?: number;
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white relative">
      <div className="w-full max-w-2xl space-y-3">
        <div className="h-3 w-3/4 rounded skeleton-shimmer" />
        <div className="h-3 w-1/2 rounded skeleton-shimmer" style={{ animationDelay: "0.2s" }} />
        <div className="h-3 w-2/3 rounded skeleton-shimmer" style={{ animationDelay: "0.4s" }} />
      </div>
      <div className="flex items-center gap-2 mt-6 text-sm text-[var(--muted)]">
        <span className="inline-flex gap-1">
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accentColor }} />
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accentColor, animationDelay: "0.3s" }} />
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accentColor, animationDelay: "0.6s" }} />
        </span>
        {step || "Working on it..."}
        {elapsed > 3 && <span className="text-xs opacity-60">({elapsed}s)</span>}
      </div>
    </div>
  );
}
