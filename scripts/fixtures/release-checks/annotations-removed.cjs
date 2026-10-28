/**
 * Release checker for the answer contract (docs/superpowers/specs/2026-10-28-answer-columns-and-chart-labels.md):
 * the frozen answers lose their `note` column and nothing else. The expected columns and rows are the answers captured
 * from production on 2026-10-28 with `note` removed (annotations-removed.expected.json); every value, period and row
 * order must match exactly.
 */
const expected = require("./annotations-removed.expected.json").answers;

function forQuestion(name) {
  return {
    check(answer) {
      const want = expected[name];
      if (!want) return { ok: false, why: `no expected answer for ${name}` };
      if (JSON.stringify(answer.columns) !== JSON.stringify(want.columns)) return { ok: false, why: `columns ${JSON.stringify(answer.columns)} != ${JSON.stringify(want.columns)}` };
      if (!Array.isArray(answer.rows) || answer.rows.length !== want.rows.length) return { ok: false, why: `rows ${answer.rows?.length} != ${want.rows.length}` };
      for (let i = 0; i < want.rows.length; i += 1) {
        const got = answer.rows[i];
        if (JSON.stringify(Object.keys(got)) !== JSON.stringify(Object.keys(want.rows[i]))) return { ok: false, why: `row ${i} keys ${Object.keys(got).join(",")}` };
        for (const [k, v] of Object.entries(want.rows[i])) if (got[k] !== v) return { ok: false, why: `row ${i} ${k}: ${got[k]} != ${v}` };
      }
      return { ok: true };
    },
  };
}

module.exports = { forQuestion };
