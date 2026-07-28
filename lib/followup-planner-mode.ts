import type { SourceId } from './source-contracts';

export type FollowupPlannerMode = 'off' | 'compare' | 'authoritative';

/** Read the mode for each request so deploy configuration changes take effect on restart. */
export function plannerModeForSource(source: SourceId): FollowupPlannerMode {
  const mode = (process.env.FOLLOWUP_PLANNER_MODE ?? 'off').trim().toLowerCase();
  if (mode === 'compare') return 'compare';
  if (mode === 'authoritative') {
    const sources = (process.env.FOLLOWUP_PLANNER_SOURCES ?? '')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    return sources.includes(source) ? 'authoritative' : 'compare';
  }
  return 'off';
}
