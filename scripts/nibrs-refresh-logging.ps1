# Command invocation and log ownership for the NIBRS rollup refresh.
#
# This file owns the boundary between the refresh script and every external command it runs. Two
# properties, both learned from production failures, both testable here without a host:
#
# 1. ONE FILE, ONE WRITER. `refresh-nibrs-rollups.ps1` opens the run log with `Start-Transcript` and
#    holds it for the whole run. On 2026-08-22 the streaming helper also piped every streamed step into
#    `Tee-Object -FilePath $logPath` -- the same file -- and the run died in the build stage on "The
#    process cannot access the file ... because it is being used by another process", after already
#    copying 176 GB off production. Not a race: `Tee-Object` opens its target on the first object it
#    receives, so a silent step never collided and a chatty one always did.
#
#    The transcript is the single owner. Streamed output is routed to the host with `Out-Host`, which
#    the PowerShell 5.1 transcript does capture -- unlike native-command output left to flow out
#    through the pipeline, which it does not.
#
# 2. NATIVE STDERR IS NOT A POWERSHELL ERROR. The caller sets `$ErrorActionPreference = "Stop"`. Under
#    that setting a native process writing ANYTHING to stderr raises a terminating error the moment the
#    line reaches the pipeline -- before `$LASTEXITCODE` is ever read, and regardless of the sink
#    (`Tee-Object`, `Out-File` and `Out-Host` all behave identically; all three were probed).
#
#    So a single `npx` deprecation notice, an ssh banner, or an scp progress line on a command that
#    exits 0 would abort the run. That is not theoretical: it can discard a completed 176 GB transfer
#    and a two-hour build over a benign warning, and it directly contradicts the exit-code contract
#    these helpers advertise.
#
#    Both helpers therefore set `$ErrorActionPreference = "Continue"` for the invocation only. The
#    assignment is function-local -- PowerShell copies on write, so the caller's `Stop` is untouched --
#    and `$LASTEXITCODE` is unaffected by it. THE NATIVE EXIT CODE ALONE DECIDES SUCCESS.
#
# The two helpers differ in one deliberate way, and it matters:
#
#   * `Invoke-StreamingCommand` merges stderr into the host stream. Nothing parses that output; a human
#     reads it in the transcript, and interleaving is what makes it readable.
#   * `Invoke-CapturedCommand` RETURNS its output to be parsed -- a generation line, a digest, a link
#     target. Merging stderr into that return value would let a warning corrupt a parsed field, so the
#     streams are partitioned: stdout is returned, stderr is written to the host for the transcript and
#     included in the error message when the command fails.

Set-StrictMode -Version Latest

<#
.SYNOPSIS
Run a command, stream its output into the run transcript, and throw only if it exits non-zero.

.DESCRIPTION
Writes nothing to the log file itself: the active transcript is the only writer on that path, and this
routes output to the host so the transcript records it, exactly once.
#>
function Invoke-StreamingCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  # Function-local, so the caller keeps `Stop` everywhere else. Without this a benign stderr line
  # terminates the run before the exit code below is ever consulted.
  $ErrorActionPreference = "Continue"
  # Flattened to plain strings on the way to the host. An ErrorRecord reaching the host is rendered as
  # PowerShell's full error view -- the message, then a CategoryInfo block repeating it -- so every
  # stderr line would appear twice and several lines long. `scp` progress alone would bury the log.
  & $Command @Arguments 2>&1 |
    ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "$_" } else { $_ } } |
    Out-Host
  # `Out-Host` does not touch `$LASTEXITCODE`, so this is still the native command's own code. Losing
  # it would let a failed build upload an unverified artifact.
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

<#
.SYNOPSIS
Run a command, return its STDOUT for parsing, and throw only if it exits non-zero.

.DESCRIPTION
Returns stdout alone, trimmed. Stderr is separated out, echoed to the host so it still reaches the
transcript, and folded into the error message when the command fails -- never into the return value,
which callers parse into generations, digests and link targets.
#>
function Invoke-CapturedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @()
  )
  $ErrorActionPreference = "Continue"
  $raw = & $Command @Arguments 2>&1
  # With `2>&1`, stderr lines arrive as ErrorRecord objects and stdout as strings. That type difference
  # is the only reliable way to tell them apart after the merge.
  $stdout = @($raw | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
  $stderr = @($raw | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
  $exitCode = $LASTEXITCODE

  foreach ($line in $stderr) { Write-Host "[rollup-refresh] $Command stderr: $line" }

  if ($exitCode -ne 0) {
    $detail = @($stdout + $stderr) -join [Environment]::NewLine
    throw ("$Command failed with exit code $exitCode" + [Environment]::NewLine + $detail)
  }
  return ($stdout -join [Environment]::NewLine).Trim()
}
