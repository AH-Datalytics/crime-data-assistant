# Focused tests for NIBRS refresh log ownership.
#
# WHY THIS EXISTS. The 2026-08-22 03:00 scheduled refresh copied the full 176 GB source snapshot off
# production and then died in the build stage with:
#
#   TerminatingError(out-file): "The process cannot access the file
#   'C:\tmp\nibrs-rollup-refresh\refresh-20260822_080002.log' because it is being used by another
#   process."
#
# `Start-Transcript` held the run log open for the whole run while the streaming helper piped every
# streamed step into `Tee-Object -FilePath` on the SAME path. Two writers, one file.
#
# It is NOT a race. `Tee-Object` opens its file on the first object it receives, so a streamed step
# that emits nothing never opens the log and never collides. That is why the 176 GB `scp` -- silent
# with no tty -- survived and the build, which prints progress, did not. The collision is
# deterministic in "the streamed command produced output", which is exactly what these tests drive.
#
# Everything runs against a throwaway transcript under the system temp directory. No production host
# is contacted and the real refresh workspace is never touched.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "nibrs-refresh-logging.ps1")

$script:Passed = 0
$script:Failed = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { return }
  throw $Message
}

function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("nibrs-logging-test-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  try {
    & $Body $root
    $script:Passed++
    Write-Host "  PASS  $Name"
  } catch {
    $script:Failed++
    Write-Host "  FAIL  $Name"
    Write-Host "        $($_.Exception.Message)"
  } finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

<#
.SYNOPSIS
Run a scriptblock with a transcript open on $LogPath, the way the refresh script does, and return
the transcript's text. The transcript is always stopped, so a failing body cannot leave one running
and poison every later test in this process.
#>
function Invoke-UnderTranscript {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][scriptblock]$Body
  )
  $thrown = $null
  Start-Transcript -Path $LogPath -Append | Out-Null
  try {
    & $Body
  } catch {
    $thrown = $_
  } finally {
    Stop-Transcript | Out-Null
  }
  $text = ""
  if (Test-Path -LiteralPath $LogPath) {
    $text = Get-Content -LiteralPath $LogPath -Raw
  }
  return [pscustomobject]@{ Thrown = $thrown; Text = $text }
}

function Format-Thrown {
  param($Thrown)
  # Under Set-StrictMode, reading .Exception off $null throws while BUILDING a failure message, which
  # turns a real assertion failure into a confusing harness error. Always go through this.
  if ($null -eq $Thrown) { return "(nothing was thrown)" }
  return $Thrown.Exception.Message
}

function Measure-Occurrence {
  param([string]$Text, [string]$Needle)
  if ([string]::IsNullOrEmpty($Text)) { return 0 }
  $count = 0
  $at = $Text.IndexOf($Needle, [System.StringComparison]::Ordinal)
  while ($at -ge 0) {
    $count++
    $at = $Text.IndexOf($Needle, $at + $Needle.Length, [System.StringComparison]::Ordinal)
  }
  return $count
}

Write-Host "`n-- the collision this fixes is real, and this harness detects it --"

Test-Case "a second writer on the transcript path still fails, so the harness can catch a regression" {
  param($root)
  # The defect itself, reproduced deliberately. If this ever stops throwing, the tests below are no
  # longer proving anything and this file needs rewriting rather than trusting.
  $log = Join-Path $root "refresh-collision.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    & cmd @("/c", "echo SECOND_WRITER") 2>&1 | Tee-Object -FilePath $log -Append
  }.GetNewClosure()
  Assert-True ($null -ne $result.Thrown) "a second writer on the open transcript did not fail"
  Assert-True ($result.Thrown.Exception -is [System.IO.IOException]) `
    "expected an IOException, got $($result.Thrown.Exception.GetType().FullName)"
}

Test-Case "the silent case is why this hid for weeks" {
  param($root)
  # A streamed step that emits nothing never opens the tee target, so the old code survived it. This
  # is documentation of the failure mode, not a property of the fix.
  $log = Join-Path $root "refresh-silent.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    & cmd @("/c", "exit 0") 2>&1 | Tee-Object -FilePath $log -Append
  }.GetNewClosure()
  Assert-True ($null -eq $result.Thrown) "a silent streamed step should not have collided"
}

Write-Host "`n-- the streaming helper has exactly one writer --"

Test-Case "a streamed step that produces output does not collide with the run transcript" {
  param($root)
  $log = Join-Path $root "refresh-ok.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo BUILD_PROGRESS")
  }
  Assert-True ($null -eq $result.Thrown) "the helper still collided: $(Format-Thrown $result.Thrown)"
}

Test-Case "streamed output is captured in the run log" {
  param($root)
  # The point of streaming at all: a scheduled run leaves the step output behind for a human.
  $log = Join-Path $root "refresh-capture.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo CAPTURED_LINE")
  }
  Assert-True ($null -eq $result.Thrown) "the helper threw: $(Format-Thrown $result.Thrown)"
  Assert-True ((Measure-Occurrence -Text $result.Text -Needle "CAPTURED_LINE") -ge 1) `
    "streamed output never reached the run log"
}

Test-Case "streamed output is recorded once, not twice" {
  param($root)
  # One writer means one copy. Two copies would mean a sink was added back alongside the transcript.
  $log = Join-Path $root "refresh-once.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo ONE_COPY_ONLY")
  }
  $seen = Measure-Occurrence -Text $result.Text -Needle "ONE_COPY_ONLY"
  Assert-True ($seen -eq 1) "expected the line once in the run log, saw it $seen times"
}

Test-Case "many output lines stream without collision" {
  param($root)
  # The real build prints steadily for two hours. One line proves the handle; many prove the sink is
  # not being reopened per object.
  $log = Join-Path $root "refresh-many.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "for /l %i in (1,1,40) do @echo STREAM_LINE_%i")
  }
  Assert-True ($null -eq $result.Thrown) "streaming many lines threw: $(Format-Thrown $result.Thrown)"
  Assert-True ((Measure-Occurrence -Text $result.Text -Needle "STREAM_LINE_40") -eq 1) "the last streamed line is missing"
}

Write-Host "`n-- failures are still failures --"

Test-Case "a non-zero exit code still throws" {
  param($root)
  # The false-acceptance case that matters: if changing the sink lost `$LASTEXITCODE`, a failed build
  # would be treated as a success and an unverified artifact would be uploaded to production.
  $log = Join-Path $root "refresh-exit.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo FAILING_STEP & exit 9")
  }
  Assert-True ($null -ne $result.Thrown) "a step exiting 9 was treated as success"
  Assert-True ($result.Thrown.Exception.Message -like "*exit code 9*") `
    "the thrown error does not name the exit code: $(Format-Thrown $result.Thrown)"
}

Test-Case "a step that exits zero silently does not throw" {
  param($root)
  $log = Join-Path $root "refresh-quiet.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "exit 0")
  }
  Assert-True ($null -eq $result.Thrown) "a successful silent step threw: $(Format-Thrown $result.Thrown)"
}

Test-Case "the helper works with no active transcript at all" {
  param($root)
  # Run interactively from a developer shell there is no transcript. The helper must not depend on one.
  Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo NO_TRANSCRIPT_HERE")
  $threw = $false
  try { Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "exit 4") } catch { $threw = $true }
  Assert-True $threw "without a transcript a failing step stopped throwing"
}

Write-Host "`n-- the shipped script owns its log once --"

Test-Case "the shipped script never tees into the transcript path" {
  param($root)
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains('Start-Transcript -Path $logPath')) "the transcript is gone; this check is stale"
  Assert-True (-not ($source -match 'Tee-Object[^\r\n]*\$logPath')) `
    "the shipped script tees into the same path it transcribes -- this is the 2026-08-22 defect"
}

Test-Case "the shipped script streams through the shared helper" {
  param($root)
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains('nibrs-refresh-logging.ps1')) "the shipped script does not load the logging helper"
  Assert-True ($source.Contains('Invoke-StreamingCommand')) "the shipped script does not stream through the helper"
}

Write-Host "`n-- round 3 blocker 1: native stderr is not a PowerShell error --"

# The caller runs under `$ErrorActionPreference = "Stop"`. These tests set it here too, because the
# defect ONLY appears under that setting: a native process writing anything to stderr raised a
# terminating error before `$LASTEXITCODE` was ever read, so one benign `npx` notice or ssh banner could
# discard a completed 176 GB transfer and a two-hour build.
$ErrorActionPreference = "Stop"

Test-Case "a streamed command writing to stderr and exiting 0 succeeds" {
  param($root)
  $log = Join-Path $root "stderr-ok.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo harmless-warning 1>&2 & echo real-output & exit 0")
  }
  Assert-True ($null -eq $result.Thrown) "a benign stderr line failed a successful command: $(Format-Thrown $result.Thrown)"
}

Test-Case "both streams of a successful command reach the run log exactly once" {
  param($root)
  $log = Join-Path $root "stderr-capture.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo WARN_LINE 1>&2 & echo OUT_LINE & exit 0")
  }
  Assert-True ((Measure-Occurrence -Text $result.Text -Needle "OUT_LINE") -eq 1) "stdout was not recorded exactly once"
  Assert-True ((Measure-Occurrence -Text $result.Text -Needle "WARN_LINE") -eq 1) "stderr was not recorded exactly once"
}

Test-Case "a streamed command writing to stderr and exiting non-zero throws with the exit code" {
  param($root)
  # The exit code alone decides, in both directions.
  $log = Join-Path $root "stderr-fail.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo fatal-detail 1>&2 & exit 6")
  }
  Assert-True ($null -ne $result.Thrown) "a failing command was treated as success"
  Assert-True ((Format-Thrown $result.Thrown) -like "*exit code 6*") `
    "the error does not name the exit code: $(Format-Thrown $result.Thrown)"
}

Test-Case "the caller's Stop preference survives a streamed command" {
  # The relaxation is for the invocation only. If it leaked, every later error in the run would stop
  # being terminating -- a far worse defect than the one being fixed.
  $before = $ErrorActionPreference
  Invoke-StreamingCommand -Command "cmd" -Arguments @("/c", "echo leak-check 1>&2 & exit 0")
  Assert-True ($ErrorActionPreference -eq $before) "the preference leaked: $ErrorActionPreference"
  Assert-True ($ErrorActionPreference -eq "Stop") "the test is not running under Stop, so it proves nothing"
}

Write-Host "`n-- the captured helper has the same exit-code contract, and a stricter return contract --"

Test-Case "a captured command writing to stderr and exiting 0 succeeds" {
  $value = Invoke-CapturedCommand -Command "cmd" -Arguments @("/c", "echo noise 1>&2 & echo payload & exit 0")
  Assert-True ($value -eq "payload") "stderr contaminated the parsed return value: [$value]"
}

Test-Case "stderr never enters the value the caller parses" {
  # This return value becomes a generation string, a digest, a resolved link target. A warning folded
  # into it would be parsed as data.
  $value = Invoke-CapturedCommand -Command "cmd" -Arguments @("/c", "echo WARN 1>&2 & echo a^|b^|c & exit 0")
  Assert-True ($value -eq "a|b|c") "the parsed value is [$value]"
  Assert-True (-not $value.Contains("WARN")) "stderr leaked into the return value"
}

Test-Case "a captured command exiting non-zero throws with the exit code and the detail" {
  $threw = $null
  try { Invoke-CapturedCommand -Command "cmd" -Arguments @("/c", "echo why-it-failed 1>&2 & exit 4") } catch { $threw = $_ }
  Assert-True ($null -ne $threw) "a failing captured command was treated as success"
  Assert-True ((Format-Thrown $threw) -like "*exit code 4*") "the error does not name the exit code"
  Assert-True ((Format-Thrown $threw) -like "*why-it-failed*") "the error discarded the stderr detail a human needs"
}

Test-Case "a captured command's stderr still reaches the run log" {
  param($root)
  $log = Join-Path $root "captured-stderr.log"
  $result = Invoke-UnderTranscript -LogPath $log -Body {
    Invoke-CapturedCommand -Command "cmd" -Arguments @("/c", "echo DIAGNOSTIC 1>&2 & echo value & exit 0") | Out-Null
  }
  Assert-True ((Measure-Occurrence -Text $result.Text -Needle "DIAGNOSTIC") -ge 1) `
    "stderr was dropped instead of being recorded for a human"
}

Test-Case "an empty captured result is an empty string, not an error" {
  $value = Invoke-CapturedCommand -Command "cmd" -Arguments @("/c", "exit 0")
  Assert-True ($value -eq "") "a silent successful command returned [$value]"
}

Write-Host "`n-- every streamed call site goes through the fixed boundary --"

Test-Case "the shipped script runs no native command outside its sanctioned boundaries" {
  # Fixing individual command strings would leave the next call site broken. The boundary is the fix.
  #
  # There are now THREE boundaries, not two. `Invoke-BoundedChild` joined them when the long-running
  # children (transfer, build, benchmark) came under deadline supervision: it cannot go through
  # `Invoke-StreamingCommand` because it needs the process handle in order to bound and kill a tree.
  # It owns the same property the other two own -- the child's OWN exit code decides success, never
  # whatever it happened to write to stderr -- and the supervisor suite asserts that directly.
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True (-not ($source -match '(?m)^\s*&\s*"?(ssh|scp)\b')) "the shipped script invokes ssh or scp directly"
  Assert-True (-not ($source -match 'Tee-Object')) "a second writer is back on the run log"
  $streamed = ([regex]::Matches($source, "Invoke-StreamingCommand ")).Count
  $captured = ([regex]::Matches($source, "Invoke-CapturedCommand ")).Count
  $bounded  = ([regex]::Matches($source, "Invoke-BoundedChild ")).Count
  # The remote commands moved to the BOUNDED forms of the same two helpers, which is the point of the
  # transport correction: they keep the captured/streamed contracts and add a deadline. So the counts
  # are taken across all four sanctioned boundaries rather than the two original names.
  $boundedCaptured = ([regex]::Matches($source, "Invoke-BoundedCapturedCommand ")).Count
  $boundedStreamed = ([regex]::Matches($source, "Invoke-BoundedStreamingCommand ")).Count
  # One total across the sanctioned boundaries, rather than a magic number per helper name. The
  # per-name thresholds were a proxy for "no call site escaped", and they went stale the moment the
  # remote calls moved to the bounded forms -- which is a correction, not a regression.
  $total = $streamed + $captured + $bounded + $boundedStreamed + $boundedCaptured
  Assert-True ($total -ge 10) "call sites appear to have been removed rather than bounded, found $total"
  Assert-True (($bounded + $boundedStreamed) -ge 4) `
    "the streaming/long-running call sites are no longer bounded, found $bounded + $boundedStreamed"
  Assert-True ($boundedCaptured -ge 6) `
    "the captured server call sites are no longer bounded, found $boundedCaptured"
  # And nothing may use the UNBOUNDED forms any more: every server command is on a deadline now.
  Assert-True (($streamed -eq 0) -and ($captured -eq 0)) `
    "an unbounded helper is still used for a server command ($streamed streamed, $captured captured)"
  Assert-True ($bounded -ge 2) "the long-running children are no longer under deadline supervision, found $bounded"

  # Nothing may start a native process on its own. `Start-Process` belongs to the supervisor and the
  # seam that hands the holder its control channel, not to the operation body.
  $supervisor = Get-Content -LiteralPath (Join-Path $PSScriptRoot "nibrs-recovery-supervisor.ps1") -Raw
  Assert-True ($supervisor -match "ExitCode") "the bounded-child boundary does not read the child's own exit code"
}

Write-Host "`nNIBRS refresh logging: $script:Passed passed, $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
