/**
 * A test-only observation point for what request accounting is given (answer batch A, Codex build ruling item 2).
 *
 * The SHR route once pushed its own place instruction onto the user's history, and accounting read it as an earlier
 * user turn (GC-026, GC-078). Handler-level tests need to see the accounting input itself, not infer it from the
 * answer. This does nothing unless a test has installed a recorder on globalThis; it never changes the input.
 */
type AccountingInput = { source: string; question: string; earlierTurns: readonly string[] };
type Recorder = (input: AccountingInput) => void;

export function observeAccountingInput(source: string, question: string, earlierTurns: readonly string[]): void {
  const recorder = (globalThis as { __cdaAccountingInputRecorder?: Recorder }).__cdaAccountingInputRecorder;
  if (typeof recorder === "function") recorder({ source, question, earlierTurns: [...earlierTurns] });
}
