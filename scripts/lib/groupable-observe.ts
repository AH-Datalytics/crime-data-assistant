/**
 * Everything observable about the compiler's grouping table (GROUPABLE in lib/nibrs-plan/compile.ts), as plain data: for each counting unit and dimension, the column
 * expression, the flags, the join text for a fixed table reader, and the binned expression for fixed bins. Used to write the golden file from the hand-written table
 * (scripts/gen-groupable-golden.ts, run once before the table became data) and by scripts/test-groupable-table.ts to prove the table built from data is byte-identical.
 */
import { GROUPABLE } from "../../lib/nibrs-plan/compile";

const AGE_BINS = [{ label: "0 to 17", from: 0, to: 17 }, { label: "18 to 64", from: 18, to: 64 }, { label: "65 and over", from: 65, to: 99 }];
const HOUR_BINS = [{ label: "Night", from: 0, to: 5 }, { label: "Morning", from: 6, to: 11 }, { label: "Afternoon", from: 12, to: 17 }, { label: "Evening", from: 18, to: 23 }];
const read = (t: string) => `READ(${t})`;

export type Observed = Record<string, Record<string, { col: string; multi: boolean; age: boolean; join: string | null; binned: string | null; binnedHour: string | null }>>;
export function observeGroupable(table: typeof GROUPABLE = GROUPABLE): Observed {
  const out: Observed = {};
  for (const [entity, dims] of Object.entries(table)) {
    out[entity] = {};
    for (const [dim, g] of Object.entries(dims)) {
      out[entity][dim] = { col: g.col, multi: !!g.multi, age: !!g.age, join: g.join ? g.join(read) : null, binned: g.binned ? g.binned(AGE_BINS) : null, binnedHour: g.binned ? g.binned(HOUR_BINS) : null };
    }
  }
  return out;
}
