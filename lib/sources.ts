/**
 * Centralized source registry.
 *
 * Every UI component, router function, and API route-picker reads from here.
 * Feature flags (e.g. NEXT_PUBLIC_ENABLE_HATE_CRIME) control which sources
 * are active. Disabled sources are invisible: not selectable, not suggested,
 * not routed to, and not displayed.
 */

/** All possible source IDs — the superset. */
export type SourceId = "current" | "historical" | "nibrs" | "shr" | "hate_crime";

/** Source IDs the user can pick from, including "auto". */
export type PickerSourceId = "auto" | SourceId;

/** Metadata for a single source — used by UI cards, dropdowns, etc. */
export interface SourceMeta {
  id: SourceId;
  label: string;
  color: string;
  lightBg: string;
  borderColor: string;
}

// ── Full catalog (static, never filtered) ──────────────────────────

const ALL_SOURCES: SourceMeta[] = [
  { id: "current",    label: "Current Trends",    color: "#475EC7", lightBg: "#eef1fb", borderColor: "#c5cdf0" },
  { id: "historical", label: "Historical Library", color: "#8B5E3C", lightBg: "#f5f0eb", borderColor: "#ddd0c2" },
  { id: "nibrs",      label: "NIBRS Explorer",     color: "#2d8659", lightBg: "#ecf5f0", borderColor: "#b8dcc8" },
  { id: "shr",        label: "SHR (Homicide)",     color: "#B8860B", lightBg: "#fdf8e8", borderColor: "#e8d48b" },
  { id: "hate_crime", label: "Hate Crime",         color: "#4A4A4A", lightBg: "#f2f2f2", borderColor: "#d0d0d0" },
];

// ── Feature flags ──────────────────────────────────────────────────

function isHateCrimeEnabled(): boolean {
  // NEXT_PUBLIC_ prefix makes this available in both server and client bundles.
  // Default: enabled in dev, disabled if explicitly set to "false".
  const val = process.env.NEXT_PUBLIC_ENABLE_HATE_CRIME;
  if (val === undefined || val === "") return true; // dev default
  return val.toLowerCase() !== "false" && val !== "0";
}

// ── Enabled source set ─────────────────────────────────────────────

/** Set of source IDs currently enabled. */
export function enabledSourceIds(): Set<SourceId> {
  const ids = new Set<SourceId>(["current", "historical", "nibrs", "shr"]);
  if (isHateCrimeEnabled()) ids.add("hate_crime");
  return ids;
}

/** Whether a specific source is enabled. */
export function isSourceEnabled(id: SourceId): boolean {
  return enabledSourceIds().has(id);
}

/** Enabled sources with metadata, in display order. */
export function enabledSources(): SourceMeta[] {
  const enabled = enabledSourceIds();
  return ALL_SOURCES.filter(s => enabled.has(s.id));
}

/** Picker options: "Auto source" + each enabled source. */
export function pickerOptions(): { id: PickerSourceId; label: string; color: string }[] {
  return [
    { id: "auto" as PickerSourceId, label: "Auto source", color: "#475EC7" },
    ...enabledSources().map(s => ({ id: s.id as PickerSourceId, label: s.label, color: s.color })),
  ];
}

/** Count of enabled sources (for display strings like "four sources"). */
export function enabledSourceCount(): number {
  return enabledSources().length;
}
