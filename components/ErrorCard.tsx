"use client";

/**
 * Styled error card with retry button.
 */
export default function ErrorCard({
  message,
  onRetry,
  accentColor = "#475EC7",
}: {
  message: string;
  onRetry?: () => void;
  accentColor?: string;
}) {
  const isTimeout = message.toLowerCase().includes("too long") || message.toLowerCase().includes("timeout");
  const isRateLimit = message.toLowerCase().includes("too many") || message.toLowerCase().includes("wait");

  return (
    <div className="flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-red-50 flex items-center justify-center shrink-0 mt-0.5">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round">
              <circle cx="8" cy="8" r="7" />
              <path d="M8 5v3" />
              <circle cx="8" cy="11" r="0.5" fill="#dc2626" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--foreground)] mb-1">
              {isTimeout ? "Query timed out" : isRateLimit ? "Rate limited" : "Something went wrong"}
            </p>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              {message}
            </p>
            {isTimeout && (
              <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
                Try narrowing your question — a specific city, state, or shorter time range will run faster.
              </p>
            )}
          </div>
        </div>
        {onRetry && !isRateLimit && (
          <button
            onClick={onRetry}
            className="mt-4 w-full py-2 text-sm font-medium rounded-lg cursor-pointer transition-colors"
            style={{
              color: accentColor,
              backgroundColor: accentColor + '0d',
              border: `1px solid ${accentColor}30`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = accentColor + '1a'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = accentColor + '0d'; }}
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
