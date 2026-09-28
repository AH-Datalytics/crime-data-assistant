/**
 * Shared harness: execute the ACTUAL no-SQL terminal statement from each route, in isolation.
 *
 * WHY EXTRACTION RATHER THAN A ROUTE CALL. The previous harness invoked the real `POST`, which meant
 * it read working databases and — worse — it sent `tab` where the route reads `body?.mode`, so every
 * request it called "Historical" actually selected Current Trends (review 2026-09-09, R1). This
 * harness instead lifts the real `if (!claude.sql) { … }` statement out of each route with the
 * installed TypeScript parser and runs that exact text. No product database is opened, no network,
 * no model, no server, and the shared source is never written.
 *
 * WHY THIS IS NOT AN IMITATION. The executed code IS the route's own source text: located by the
 * parser, type annotations erased by `ts.transpileModule` (a syntactic transform — no statement is
 * retyped here), then run. `assertTargetIntact` fails if the statement moves or stops containing the
 * selector, so the proof cannot quietly drift onto a copy.
 *
 * WHAT IT DOES NOT PROVE. It is not an HTTP request. Everything before the branch — routing,
 * contract, capability selection, the model call — is out of frame, and this file never claims
 * otherwise. What it proves is what the branch itself does with a given `claude` object.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { INTERNAL_LEAK_SAFE_MESSAGE, containsInternalLeak } from "../lib/scaffold-helpers";
import {
  buildNoSqlFallbackMessage,
  courtProcessNoSqlIsTerminal,
  neutralizeUnverifiedAvailabilityClaim,
  selectNoSqlRefusal,
} from "../lib/refusal-safety";
import { partialCoverageRetryPrompt } from "../lib/source-year-overlap";
import { shouldRetryUnexplainedNoSql, UNEXPLAINED_NO_SQL_RETRY_PROMPT } from "../lib/no-sql-retry";
import { pastCompleteCalendarYearsRange } from "../lib/time-conventions";

export type RouteKey = "query" | "nibrs" | "shr";

const ROUTE_FILES: Record<RouteKey, string> = {
  query: "app/api/query/route.ts",
  nibrs: "app/api/nibrs-query/route.ts",
  shr: "app/api/shr-query/route.ts",
};

/** The extracted statement plus where it came from. */
export type ExtractedBranch = { route: RouteKey; file: string; text: string; line: number };

/**
 * Find the no-SQL terminal `if` statement that carries the Decision 1 selector.
 *
 * Both routes contain more than one `if (!claude.sql)`; the one under test is the terminal exit that
 * calls `selectNoSqlRefusal`. Requiring the selector is what pins the target.
 *
 * `source` is for the mutation check, which supplies a modified copy IN MEMORY. Nothing here writes.
 */
export function extractNoSqlBranch(route: RouteKey, source?: string): ExtractedBranch {
  const file = ROUTE_FILES[route];
  const text = source ?? fs.readFileSync(path.resolve(file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

  let found: ts.IfStatement | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIfStatement(node)) {
      const cond = node.expression.getText(sf).replace(/\s+/g, "");
      // Pinned by the terminal exit's own proof intent, NOT by the selector: the mutation check
      // removes the selector from its in-memory copy and must still locate this same statement.
      // The other `if (!claude.sql)` blocks are model-retry blocks and carry no such exit.
      if (cond === "!claude.sql" && node.getText(sf).includes('intendedAction: "decline_capability"')) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!found) {
    throw new Error(`${file}: no terminal \`if (!claude.sql)\` statement was found`);
  }
  const node: ts.IfStatement = found;
  return {
    route,
    file,
    text: node.getText(sf),
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  };
}

/**
 * Fail loudly if the extraction target is not the statement this proof is about.
 *
 * The selector requirement lives HERE rather than in the search predicate on purpose: the mutation
 * check removes `selectNoSqlRefusal` from its in-memory copy, and it must still find and run the
 * same statement in order to observe the resulting failure.
 */
export function assertTargetIntact(branch: ExtractedBranch): string[] {
  const problems: string[] = [];
  if (!/^if\s*\(\s*!claude\.sql\s*\)/.test(branch.text)) {
    problems.push(`${branch.file}: extracted statement is not the \`!claude.sql\` branch`);
  }
  if (!branch.text.includes("selectNoSqlRefusal")) {
    problems.push(`${branch.file}: extracted branch no longer consults selectNoSqlRefusal`);
  }
  if (!/\breturn\b/.test(branch.text)) {
    problems.push(`${branch.file}: extracted branch is not a terminal exit (no return)`);
  }
  return problems;
}

/** What the executed branch actually did. */
export type BranchOutcome = {
  entered: boolean;
  /** Reached only if the branch did NOT return, i.e. it was bypassed. */
  sentinelReached: boolean;
  explanation: string | null;
  /** The route-level array the query route pushes its reason into. */
  firedGuardrails: string[];
  /** Every string argument handed to the logger, so a signature change cannot hide the narrative. */
  loggedStrings: string[];
  /** The last string-array argument handed to the logger — the recorded reasons. */
  loggedGuardrails: string[] | null;
  /** The guardrail list handed to `finalizeExit`, i.e. what the proof records. */
  proofGuardrails: string[] | null;
  emitted: Record<string, unknown> | null;
};

export type BranchInput = {
  /** Empty string means the model produced no SQL. A nonempty value must bypass the branch. */
  sql: string;
  question: string;
  mode: "historical" | "current";
  modelExplanation: string;
  /** Only consulted by the Current/Historical route; the NIBRS branch declares its own. */
  serverAuthoredNoSql?: boolean;
};

/**
 * Run one extracted branch with stubbed I/O.
 *
 * REAL, because they are what the assertions are about: `selectNoSqlRefusal`,
 * `neutralizeUnverifiedAvailabilityClaim`, `containsInternalLeak`, `buildNoSqlFallbackMessage`,
 * `INTERNAL_LEAK_SAFE_MESSAGE`.
 * STUBBED, because they are storage, proof plumbing or transport: the loggers, the proof builder,
 * the SSE encoder/controller, the payload emitter and the stream close.
 */
export function runBranch(
  branch: ExtractedBranch, input: BranchInput
): BranchOutcome {
  const outcome: BranchOutcome = {
    entered: false,
    sentinelReached: false,
    explanation: null,
    firedGuardrails: [],
    loggedStrings: [],
    loggedGuardrails: null,
    proofGuardrails: null,
    emitted: null,
  };

  const claude: Record<string, unknown> = {
    sql: input.sql,
    explanation: input.modelExplanation,
    title: "Response",
  };
  const firedGuardrails: string[] = [];

  const captureLog = (...args: unknown[]) => {
    outcome.loggedStrings = args.filter((a): a is string => typeof a === "string");
    const arrays = args.filter(
      (a): a is string[] => Array.isArray(a) && a.every((x) => typeof x === "string")
    );
    outcome.loggedGuardrails = arrays.length > 0 ? arrays[arrays.length - 1] : null;
    return 1;
  };

  const finalizeExit = (o: { guardrails?: string[] }) => {
    outcome.proofGuardrails = Array.isArray(o?.guardrails) ? o.guardrails : null;
    return { proof: o };
  };

  const emitFactualPayload = (_proof: unknown, payload: Record<string, unknown>) => {
    outcome.emitted = payload;
    return payload;
  };

  const catalog: Record<string, unknown> = {
    claude,
    firedGuardrails,
    tab: input.mode,
    guardrailQuestion: input.question,
    question: input.question,
    serverAuthoredNoSql: input.serverAuthoredNoSql ?? false,
    sessionId: "isolated-terminal-proof",
    totalStart: Date.now(),
    claudeStart: Date.now(),
    rawFirstNoSql: input.modelExplanation,
    rawRetryNoSql: null,
    activeModelLabel: "stub",
    // real — these are the behavior under test
    selectNoSqlRefusal,
    neutralizeUnverifiedAvailabilityClaim,
    containsInternalLeak,
    buildNoSqlFallbackMessage,
    INTERNAL_LEAK_SAFE_MESSAGE,
    // stubbed I/O
    writeLog: captureLog,
    writeNibrsLog: captureLog,
    finalizeExit,
    boundedModelResponseJson: () => null,
    emitFactualPayload,
    jsonResp: (payload: unknown) => ({ payload }),
    sseEvent: (payload: unknown) => JSON.stringify(payload),
    encoder: { encode: (s: string) => s },
    controller: { enqueue: () => undefined },
    close: () => undefined,
    authoritativeIdentity: (explanation: string, title: string) => ({ explanation, title }),
  };

  /*
   * The NIBRS branch declares `const serverAuthoredNoSql = false` inside itself. Binding a parameter
   * of the same name would be a redeclaration SyntaxError, so any name the branch declares for
   * itself is dropped from the binding list rather than shadowed.
   */
  const names = Object.keys(catalog).filter(
    (n) => !new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`).test(branch.text)
  );
  const values = names.map((n) => catalog[n]);

  /*
   * Type annotations are erased so the statement can be executed as JavaScript. This is the
   * compiler's own syntactic transform applied to the route's own text — nothing is rewritten by
   * hand. The branch ends in `return`, so reaching the sentinel after it means it was bypassed.
   */
  const wrapped = `function __branch() {\n${branch.text}\n__sentinel();\n}\n__branch();`;
  const js = ts.transpileModule(wrapped, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;

  const sentinel = () => { outcome.sentinelReached = true; };
  const fn = new Function(...names, "__sentinel", js) as (...a: unknown[]) => unknown;

  fn(...values, sentinel);

  outcome.entered = !outcome.sentinelReached;
  outcome.explanation = typeof claude.explanation === "string" ? claude.explanation : null;
  outcome.firedGuardrails = firedGuardrails;
  return outcome;
}

export const COURT_EXPLANATION = /tracks reported crime incidents, not court outcomes/i;
export const REPHRASE_INVITATION = /restate it with the place, offense, and date range/i;

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * THE RETRY-SELECTION BLOCKS (added 2026-09-25 for the Cause A batch)
 *
 * The terminal exit above says what the reader is TOLD. It says nothing about whether a
 * second generation call was spent first, because the decision to retry is taken earlier, in
 * a different statement. Proving "no unnecessary retry" by reading the terminal exit would be
 * a check that cannot fail for the thing it claims to measure, so these run the retry
 * statements themselves, by the same extraction rule: the route's own source text, located by
 * the parser, executed with a counting provider stub in place of the model.
 *
 * WHAT IS REAL HERE. The policies that decide: `courtProcessNoSqlIsTerminal`,
 * `partialCoverageRetryPrompt`, `shouldRetryUnexplainedNoSql`, the query contract. WHAT IS
 * STUBBED: the provider call, the budget check, the agency preflight and the database handle.
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

/** Which statement to lift out: matched on the `if` condition plus a phrase only it contains. */
export type BranchSelector = { condStartsWith: string; mustInclude: string };

export const RETRY_SELECTORS = {
  /** The block that picks a retry prompt after the model returned no SQL. Both routes have one. */
  noSqlRetry: { condStartsWith: "!claude.sql", mustInclude: "const retryPrompt" } as BranchSelector,
  /** Current Trends only: the preflight that forces a retry when the agency is verifiably present. */
  verifiedAgency: { condStartsWith: "!claude.sql", mustInclude: "findVerifiedCurrentAgency" } as BranchSelector,
};

export function extractBranch(route: RouteKey, selector: BranchSelector, source?: string): ExtractedBranch {
  const file = ROUTE_FILES[route];
  const text = source ?? fs.readFileSync(path.resolve(file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

  let found: ts.IfStatement | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIfStatement(node)) {
      const cond = node.expression.getText(sf).replace(/\s+/g, "");
      const body = node.getText(sf);
      if (cond.startsWith(selector.condStartsWith) && body.includes(selector.mustInclude)) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (!found) {
    throw new Error(`${file}: no \`if (${selector.condStartsWith}…)\` statement containing \`${selector.mustInclude}\` was found`);
  }
  const node: ts.IfStatement = found;
  return {
    route,
    file,
    text: node.getText(sf),
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  };
}

/** One model reply, in the shape the routes' translators return. */
export type StubReply = { sql: string | null; explanation: string; title?: string };

/** Every provider call the executed statement made, and the state it left behind. */
export type RetrySelectionOutcome = {
  /** One entry per generation call the statement spent. Empty means it did not retry. */
  calls: Array<{ prompt: string | null }>;
  sqlAfter: string | null;
  explanationAfter: string;
  retryCount: number;
  serverAuthoredNoSql: boolean;
  rawRetryNoSql: string | null;
};

export type RetrySelectionInput = {
  question: string;
  /** The route's own tab value. The NIBRS statement ignores it. */
  tab: "current" | "historical" | "nibrs";
  /** The saved first reply, i.e. the one that carried no SQL. */
  first: StubReply;
  /** What the provider would return IF a retry were spent. */
  second: StubReply;
  /** Injected so a control can show the preflight firing; `null` means no verified agency. */
  verifiedAgency?: { agency: string; state: string; dataRows: number } | null;
  /** Injected rather than derived, so a contract-dependent retry can be exercised either way. */
  promptContract?: unknown;
};

/**
 * Execute one extracted retry-selection statement.
 *
 * `claude` and the route's mutable locals are declared in a preamble rather than bound as
 * parameters, because the statements REASSIGN them (`claude = retryResult`) and a rebound
 * parameter would hide the result. The preamble names are excluded from the binding list for
 * the same reason a name the statement declares itself is: redeclaring would be a SyntaxError.
 */
export async function runRetrySelection(
  branch: ExtractedBranch, input: RetrySelectionInput,
): Promise<RetrySelectionOutcome> {
  const calls: Array<{ prompt: string | null }> = [];

  const provider = async (_q: string, history: Array<{ role: string; content: string }>) => {
    const last = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
    calls.push({ prompt: last && typeof last.content === "string" ? last.content : null });
    return { ...input.second, title: input.second.title ?? "Results" };
  };

  const catalog: Record<string, unknown> = {
    // real — these are the decisions under test
    courtProcessNoSqlIsTerminal,
    partialCoverageRetryPrompt,
    shouldRetryUnexplainedNoSql,
    UNEXPLAINED_NO_SQL_RETRY_PROMPT,
    pastCompleteCalendarYearsRange,
    // the surrounding state the statement reads
    question: input.question,
    guardrailQuestion: input.question,
    tab: input.tab,
    promptHistory: [] as unknown[],
    systemPrompt: undefined,
    activeModel: "stub",
    promptContract: input.promptContract ?? null,
    resolutionPlan: null,
    hasDemographicPlaceDisambiguation: false,
    // stubbed I/O
    translate: provider,
    translateToSql: provider,
    isOverBudget: () => false,
    getDb: () => null,
    findVerifiedCurrentAgency: () => input.verifiedAgency ?? null,
  };

  const PREAMBLE_NAMES = ["claude", "rawFirstNoSql", "rawRetryNoSql", "retryCount", "serverAuthoredNoSql"];
  const names = Object.keys(catalog).filter(
    (n) => !PREAMBLE_NAMES.includes(n) && !new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`).test(branch.text)
  );
  const values = names.map((n) => catalog[n]);

  const src =
    `async function __branch(__first) {\n` +
    `  let claude = __first;\n` +
    `  let rawFirstNoSql = claude.explanation || null;\n` +
    `  let rawRetryNoSql = null;\n` +
    `  let retryCount = 0;\n` +
    `  let serverAuthoredNoSql = false;\n` +
    branch.text + `\n` +
    `  return { claude, rawRetryNoSql, retryCount, serverAuthoredNoSql };\n` +
    `}`;
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText + `\nreturn __branch(__firstReply);`;

  const fn = new Function(...names, "__firstReply", js) as (...a: unknown[]) => Promise<{
    claude: { sql: string | null; explanation: string };
    rawRetryNoSql: string | null;
    retryCount: number;
    serverAuthoredNoSql: boolean;
  }>;

  const out = await fn(...values, { ...input.first, title: input.first.title ?? "Response" });
  return {
    calls,
    sqlAfter: out.claude.sql ?? null,
    explanationAfter: out.claude.explanation ?? "",
    retryCount: out.retryCount,
    serverAuthoredNoSql: out.serverAuthoredNoSql,
    rawRetryNoSql: out.rawRetryNoSql,
  };
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * CLARIFICATION GATES (Cause B) — the same extraction, applied to a declaration
 * ════════════════════════════════════════════════════════════════════════════════════════
 * The retry work above lifts an `if` statement. A clarification gate is decided one line
 * earlier, in the `const … =` that computes the decision, and the `if` only reads it. So the
 * two helpers below lift THAT declaration's own initializer and run it. Same principle as
 * `extractBranch`: the text executed is the route's, located by the parser and erased of type
 * annotations, never retyped here.
 *
 * WHAT THIS DOES NOT PROVE, said once here rather than in each caller: it is not an HTTP
 * request. It shows what the route's own expression decides for a given question and history.
 */

/** The initializer of a `const <name> = …` declaration in a route, with its line. */
export function extractDeclaration(route: RouteKey, name: string, source?: string): ExtractedBranch {
  const file = ROUTE_FILES[route];
  const text = source ?? fs.readFileSync(path.resolve(file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

  let found: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`${file}: no \`const ${name} = …\` declaration was found`);
  const decl: ts.VariableDeclaration = found;
  return {
    route,
    file,
    text: decl.initializer!.getText(sf),
    line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
  };
}

/**
 * Evaluate one lifted expression with the real modules bound by name.
 *
 * Every name the expression needs must be supplied. A missing one is a ReferenceError rather
 * than a quiet `undefined`, which is what keeps a stub from standing in for a real decision
 * without anyone noticing.
 */
export function runRouteExpression<T>(expression: string, catalog: Record<string, unknown>): T {
  const names = Object.keys(catalog);
  const js = ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const fn = new Function(...names, `return ${js.trim().replace(/;\s*$/, "")};`) as (...a: unknown[]) => T;
  return fn(...names.map((n) => catalog[n]));
}

/**
 * The CONDITION of an extracted `if`, as its own source text.
 *
 * WHY THIS EXISTS. A branch check that reads the statement's body and executes the declaration
 * feeding it still says nothing about whether the branch is REACHED. Adding `&& false` to the
 * condition left one such check entirely green (2026-09-25). The condition has to be executed
 * too, or the evidence is about a statement the route may never run.
 */
export function branchCondition(branch: ExtractedBranch): string {
  const sf = ts.createSourceFile("branch.ts", branch.text, ts.ScriptTarget.ES2022, true);
  const first = sf.statements[0];
  if (!first || !ts.isIfStatement(first)) throw new Error("branchCondition: not an `if` statement");
  return first.expression.getText(sf);
}

/** What an executed route branch did. */
export type RouteBranchOutcome = {
  /** True when the branch returned, i.e. it is the exit that handled the request. */
  returned: boolean;
  /** Whatever it returned, as the stubbed `jsonResp` saw it. */
  value: unknown;
  /** True when the branch was not entered, or fell out of the bottom without returning. */
  fellThrough: boolean;
};

/**
 * Execute an extracted route branch with a supplied catalog.
 *
 * WHY, beyond `runBranch`. That one is bound to the no-SQL terminal statement's own catalog. The
 * clarification exits are different statements in a different route, and a review asked for their
 * BODIES to be executed rather than pattern-matched — a regular expression over a branch cannot
 * tell you what it delivers. This runs the route's own text with I/O replaced by fixtures.
 *
 * Any name the branch declares itself is left out of the binding list; redeclaring it would be a
 * SyntaxError. Any name it reads and the catalog does not supply is a ReferenceError, which is the
 * point: a silently-undefined stub is how a branch appears to work without doing anything.
 */
export async function runRouteBranch(
  branchText: string, catalog: Record<string, unknown>,
): Promise<RouteBranchOutcome> {
  const names = Object.keys(catalog).filter(
    (n) => !new RegExp(`\b(?:const|let|var|function)\s+${n}\b`).test(branchText));
  const src = `async function __routeBranch() {\n${branchText}\n  return __FELL_THROUGH;\n}`;
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText + `\nreturn __routeBranch();`;
  const sentinel = Symbol("fell-through");
  const fn = new Function(...names, "__FELL_THROUGH", js) as (...a: unknown[]) => Promise<unknown>;
  const value = await fn(...names.map((n) => catalog[n]), sentinel);
  return { returned: value !== sentinel, value: value === sentinel ? null : value, fellThrough: value === sentinel };
}
