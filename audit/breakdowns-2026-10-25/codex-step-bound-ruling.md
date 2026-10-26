# Codex ruling: transfer-and-verify step bound (2026-10-25)

Transcribed from Codex (agent a58aaa21ad849363a); Codex cannot write this folder.

**ACCEPT-WITH-CHANGES, future windows only.** Operator-step amendment; no sealed-script change.

- 180 s fits the four-call transfer-and-verify step (unobstructed timings 35-123 s). It does not excuse earlier breaches (release-hc-off-r2-2026-10-24: 1,577 s overrun, 1,637 s gate-to-verify).
- The gate clamps `min(allowance, 5250 - now - 30)`, which protects only the final reserve, not intermediate deadlines (a transfer admitted at T0+5000 could end at T0+5180, past the T0+5130 refusal point).
- T0+5130 applies to verify, request and controller commit. Controller admission T0+4855 and saved-capture deadline T0+4980 also bind.
- The step bound is operator-enforced; the controller does not detect its expiry.

Record in every future RUNBOOK, and append to the next release's capture-transfer AMENDMENT:

> **r3 — Transfer-and-verify step bound**
>
> Immediately before capture transfer, run `gate-k.sh step 180 NAME transfer+verify` as a standalone tool call and read its verdict. Use the release's existing gate script.
>
> One aggregate bound covers page `__export`, Write of the unchanged base64, `fetch-capture.sh` decode/publication, and successful completion of `close-k.sh verify`. Count elapsed time from the gate's server-clock reading. Tool latency, gaps and retries consume this same bound. Do not reset it between calls. The printed bound, which may be less than 180 s, governs.
>
> The allowance does not extend any hard deadline or guarantee that the remaining workflow fits. Before proceeding, budget the transfer and remaining required actions against submission admission, capture publication, subsequent start/submit gates, and the T0+5130 refusal applying to verify, request and controller commit. Include time for the controller to observe the request and start commit. Do not begin work whose remaining bounded sequence cannot fit.
>
> Start/submit conditions remain `now <= 4850` and `now + 265 <= 5250`. The answer bound remains 120 s. Controller admission and saved-capture deadlines remain T0+4855 and T0+4980. Close-mode starts remain limited to T0+5130, and controller rollback remains required at T0+5250 without CLOSE-PASS. All other step allowances, manual VR-style steps, and close-k's internal timeout remain 60 s.
>
> If any applicable bound expires, cease the step and roll back, or stop dependent work and ask the owner while all existing controller deadlines remain active. Asking does not pause or extend a deadline, authorize continuation, or override an existing mandatory rollback condition. A gate STOP or close failure retains its existing rollback response. Disclosure alone never authorizes continuation.
>
> This amendment applies prospectively. Existing integrity checks, sealed scripts and historical breach findings remain unchanged.
