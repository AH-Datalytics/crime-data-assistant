[CmdletBinding()]
param(
  [string]$WebHost = "root@178.156.243.51",
  [string]$Workspace = "C:\tmp\nibrs-rollup-refresh",
  [string]$RemoteDb = "/opt/nibrs/nibrs.db",
  [string]$RemoteShared = "/opt/nibrs/shared",
  [int64]$MinimumFreeBytes = 190GB,
  [int]$RetainArtifacts = 2,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "nibrs-refresh-cleanup.ps1")
. (Join-Path $PSScriptRoot "nibrs-remote-shell.ps1")
. (Join-Path $PSScriptRoot "nibrs-refresh-logging.ps1")
. (Join-Path $PSScriptRoot "nibrs-refresh-lifecycle.ps1")
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmss")
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$logPath = Join-Path $Workspace "refresh-$stamp.log"
Start-Transcript -Path $logPath -Append | Out-Null

function Get-PythonInvocation {
  if (Get-Command py -ErrorAction SilentlyContinue) { return @{ Command = "py"; Prefix = @("-3") } }
  if (Get-Command python -ErrorAction SilentlyContinue) { return @{ Command = "python"; Prefix = @() } }
  throw "Python 3 was not found."
}

function Get-RemoteState {
  $script = @'
set -e
test -s /opt/nibrs/shared/nibrs_source.generation
if pgrep -f '[n]ibrs-auto-update.py' >/dev/null; then echo UPDATE_RUNNING; exit 20; fi
wal=0
if test -e /opt/nibrs/nibrs.db-wal; then wal=$(stat -c %s /opt/nibrs/nibrs.db-wal); fi
if test "$wal" -ne 0; then echo WAL_NOT_EMPTY:$wal; exit 21; fi
generation=$(tr -d '\r\n' < /opt/nibrs/shared/nibrs_source.generation)
size=$(stat -Lc %s /opt/nibrs/nibrs.db)
active_generation=""
active=$(readlink -f /opt/nibrs/shared/nibrs_rollups.db 2>/dev/null || true)
if test -n "$active" && test -s "$active.generation"; then active_generation=$(tr -d '\r\n' < "$active.generation"); fi
printf '%s|%s|%s\n' "$generation" "$size" "$active_generation"
'@
  # The here-string above carries this file's on-disk line endings, so encoding it directly shipped
  # a CR at the end of every line the moment a CRLF copy of this script was scheduled. Remote bash
  # read `set -e<CR>` as an invalid option and the 2026-08-21 03:00 run died here in two seconds.
  # `ConvertTo-RemoteBashCommand` normalises to LF before encoding, so the payload no longer depends
  # on how this file happens to be checked out.
  $raw = Invoke-CapturedCommand "ssh" @($WebHost, (ConvertTo-RemoteBashCommand -Payload $script))
  $parts = $raw.Split("|")
  if ($parts.Count -ne 3 -or $parts[0] -notmatch "^\d+:\d+$") { throw "Unexpected remote state: $raw" }
  return [pscustomobject]@{
    Generation = $parts[0]
    SourceBytes = [int64]$parts[1]
    ActiveGeneration = $parts[2]
  }
}

<#
.SYNOPSIS
The production implementation of the lifecycle's remote seam: ssh and scp against $WebHost.

.DESCRIPTION
The lifecycle module never calls ssh or scp itself. Every remote effect goes through this object, so
`test-nibrs-refresh-lifecycle.ps1` can substitute a fake, inject a failure at any transition and
assert what cleanup owns -- without a production host.
#>
function New-ProductionRemote {
  # Taken as a parameter rather than read from the script scope: the closures below resolve it
  # dynamically either way, but a local makes what they depend on visible at the seam.
  param([Parameter(Mandatory = $true)][string]$WebHost)
  $remote = [pscustomobject]@{ Kind = "production" }

  $remote | Add-Member -MemberType NoteProperty -Name TestClear -Value ({
    param([string[]]$Paths)
    $tests = @($Paths | ForEach-Object { "! -e '$_'" }) -join " -a "
    Invoke-CapturedCommand "ssh" @($WebHost, "test $tests") | Out-Null
  }.GetNewClosure())

  $remote | Add-Member -MemberType NoteProperty -Name Upload -Value ({
    param([string]$From, [string]$To, [string]$Label)
    Invoke-StreamingCommand "scp" @($From, "${WebHost}:$To")
  }.GetNewClosure())

  $remote | Add-Member -MemberType NoteProperty -Name Digest -Value ({
    param([string]$Path)
    return Invoke-CapturedCommand "ssh" @($WebHost, "sha256sum '$Path' | cut -d ' ' -f1")
  }.GetNewClosure())

  $remote | Add-Member -MemberType NoteProperty -Name Move -Value ({
    param([string]$From, [string]$To, [string]$Label)
    Invoke-CapturedCommand "ssh" @($WebHost, "mv '$From' '$To'") | Out-Null
  }.GetNewClosure())

  # Prove, in an isolated temporary directory, that this host can replace a symlink atomically. The
  # commit point depends on that property, so it is checked every run rather than assumed once -- and
  # checked BEFORE anything is uploaded, so discovering the mechanism is unavailable costs one round
  # trip instead of a 176 GB transfer. Touches nothing under /opt/nibrs.
  $remote | Add-Member -MemberType NoteProperty -Name VerifyAtomicSwap -Value ({
    param()
    $probe = @'
set -e
probe_dir=$(mktemp -d)
trap 'rm -rf "$probe_dir"' EXIT
: > "$probe_dir/current"
: > "$probe_dir/candidate"
ln -sfn current "$probe_dir/link"
ln -sfn candidate "$probe_dir/link.staging"
mv -T "$probe_dir/link.staging" "$probe_dir/link"
test "$(readlink "$probe_dir/link")" = candidate
'@
    # Encoded through the same normaliser as every other multi-line payload: a here-string carries this
    # file's on-disk line endings, and a CRLF copy of this script is what broke the 2026-08-21 run.
    Invoke-CapturedCommand "ssh" @($WebHost, (ConvertTo-RemoteBashCommand -Payload $probe)) | Out-Null
  }.GetNewClosure())

  # Two steps, both atomic: create the new link under a per-run staging name, then rename it over the
  # live one. `ln -sfn` alone unlinks before it links, leaving a window with no active rollup at all.
  # The staging path is passed in, never derived here: it is stamp-unique and owned by the lifecycle, so
  # two publishers cannot overwrite each other's and failure cleanup knows to remove it.
  $remote | Add-Member -MemberType NoteProperty -Name Activate -Value ({
    param([string]$Basename, [string]$Link, [string]$StagingLink)
    Invoke-CapturedCommand "ssh" @($WebHost, "set -e; ln -sfn '$Basename' '$StagingLink'; mv -T '$StagingLink' '$Link'") | Out-Null
  }.GetNewClosure())

  # Identity is the canonical absolute path, never the leaf name: a basename comparison would accept
  # `/some/other/dir/<our-basename>` as the published database. BOTH sides are resolved on the host, in
  # one call, by the same resolver -- canonicalising our expected path locally would produce a false
  # mismatch the moment any parent directory on the host is itself a symlink, and a false mismatch
  # deletes the live database. `kind` distinguishes a regular file from a directory sharing the name.
  $remote | Add-Member -MemberType NoteProperty -Name ResolveLinkTarget -Value ({
    param([string]$Link, [string]$ExpectedPath)
    $resolver = @'
link=$1
expected=$2
actual=$(readlink -f "$link" 2>/dev/null || true)
expected_canonical=$(readlink -f "$expected" 2>/dev/null || true)
kind=missing
if test -f "$actual"; then kind=file; elif test -d "$actual"; then kind=directory; elif test -n "$actual"; then kind=other; fi
printf '%s|%s|%s
' "$actual" "$expected_canonical" "$kind"
'@
    # The payload is piped to bash on stdin, so there are no positional arguments to pass; `set --`
    # supplies them inside the payload itself. That keeps the script body a literal here-string -- the
    # form the CRLF normaliser and the Bash parse-check both cover -- instead of interpolating paths
    # into shell text. Both values come from this script's own configuration, and the guard below keeps
    # it that way.
    foreach ($value in @($Link, $ExpectedPath)) {
      if ($value -match "'") { throw "Refusing to resolve a path containing a single quote: $value" }
    }
    $payload = "set -- '$Link' '$ExpectedPath'" + [Environment]::NewLine + $resolver
    $raw = Invoke-CapturedCommand "ssh" @($WebHost, (ConvertTo-RemoteBashCommand -Payload $payload))
    $parts = $raw.Split("|")
    if ($parts.Count -ne 3) { throw "Unexpected link resolution: $raw" }
    return [pscustomobject]@{ Actual = $parts[0]; Expected = $parts[1]; Kind = $parts[2] }
  }.GetNewClosure())

  $remote | Add-Member -MemberType NoteProperty -Name Run -Value ({
    param([string]$Label, [string]$Command)
    Invoke-StreamingCommand "ssh" @($WebHost, $Command)
  }.GetNewClosure())

  # `rm -f` on an absent path exits 0, which is what makes remote cleanup idempotent.
  $remote | Add-Member -MemberType NoteProperty -Name Remove -Value ({
    param([string]$Path)
    Invoke-CapturedCommand "ssh" @($WebHost, "rm -f '$Path'") | Out-Null
  }.GetNewClosure())

  return $remote
}

$lockPath = Join-Path $Workspace "refresh.lock"
$lock = $null
$snapshot = $null
$partial = $null
# Ownership is recorded, not inferred. `Get-FailureCleanupPlan` reads this object to decide what a
# failure owns; before the lifecycle exists there is no artifact, so there is nothing to own.
$lifecycle = $null
$remote = $null
$artifact = $null
# Whether `last-success.json` was written. Without this, a housekeeping failure AFTER a recorded
# success would also write `last-activation.json` saying the run "did not complete" -- two records
# contradicting each other about the same run.
$successRecorded = $false
$completed = $false
try {
  $lock = [System.IO.File]::Open($lockPath, "OpenOrCreate", "ReadWrite", "None")

  # Holding the lock means no other refresh is mid-copy, so any source partial still here is the
  # residue of a run that died. Removing it BEFORE the free-space check is the whole point: on
  # 2026-08-20 a 119 GiB orphan made the preflight fail, and the preflight failing meant the code
  # that would have deleted it was never reached.
  Remove-StaleSourcePartials -Root $Workspace | Out-Null
  Write-Host "[rollup-refresh] Checking production source state..."
  $before = Get-RemoteState
  Write-Host "[rollup-refresh] source generation=$($before.Generation) bytes=$($before.SourceBytes)"
  if (!$Force -and $before.ActiveGeneration -eq $before.Generation) {
    Write-Host "[rollup-refresh] Active rollup already matches production; nothing to do."
    exit 0
  }

  # The lifecycle exists from here on, so a failure anywhere below has a recorded owner. Its paths need
  # only $stamp, which is fixed at the top of the run.
  # `$stamp` is unique only to one second and the workspace lock does not serialize another checkout,
  # workspace or machine, so the basename carries a nonce. Every remote path and the staging link derive
  # from it, which is what makes two publishers' owned path sets genuinely disjoint.
  $basename = New-RunArtifactBasename -Stamp $stamp
  $artifact = Join-Path $Workspace $basename
  $lifecycle = New-ArtifactLifecycle `
    -LocalArtifact $artifact `
    -RemoteArtifact "$RemoteShared/$basename" `
    -Basename $basename `
    -RemoteLink "$RemoteShared/nibrs_rollups.db"
  $remote = New-ProductionRemote -WebHost $WebHost

  # HERE, and nowhere later. The commit point depends on an atomic symlink replacement, so prove the
  # host can do it before spending two hours and 176 GB finding out it cannot. After the no-op check,
  # so an idle run pays nothing; before the free-space check and the snapshot copy, so a failure costs
  # one round trip. `test-nibrs-refresh-lifecycle.ps1` asserts this placement against the copy itself,
  # because "first inside the publication helper" would be far too late -- publication is reached only
  # after the copy, the build and the benchmark.
  Write-Host "[rollup-refresh] Proving the host can swap the active symlink atomically..."
  Invoke-ActivationCapabilityCheck -Lifecycle $lifecycle -Remote $remote

  $driveName = [System.IO.Path]::GetPathRoot($Workspace).TrimEnd([char]92).TrimEnd([char]58)
  $drive = Get-PSDrive -Name $driveName
  $required = [Math]::Max($MinimumFreeBytes, $before.SourceBytes + 10GB)
  if ($drive.Free -lt $required) {
    throw "Insufficient free space on $($drive.Root): $($drive.Free) bytes available; $required required."
  }

  $generationKey = $before.Generation.Replace(":", "_")
  $snapshot = Join-Path $Workspace "nibrs-source-$generationKey.db"
  $partial = "$snapshot.partial"
  # No per-generation delete here any more: `Remove-StaleSourcePartials` above already removed every
  # orphaned partial, including ones from other generations, which this line could never see.

  Write-Host "[rollup-refresh] Copying the quiescent source snapshot off production..."
  Invoke-StreamingCommand "scp" @("${WebHost}:$RemoteDb", $partial)
  $copiedSize = (Get-Item -LiteralPath $partial).Length
  if ($copiedSize -ne $before.SourceBytes) {
    throw "Snapshot size mismatch: copied $copiedSize; expected $($before.SourceBytes)."
  }
  $afterCopy = Get-RemoteState
  if ($afterCopy.Generation -ne $before.Generation -or $afterCopy.SourceBytes -ne $before.SourceBytes) {
    throw "Production source changed during the snapshot copy; refusing to build."
  }
  Move-Item -LiteralPath $partial -Destination $snapshot

  $python = Get-PythonInvocation
  $buildArgs = @($python.Prefix) + @(
    (Join-Path $repoRoot "scripts\build-nibrs-rollups.py"),
    "--source", $snapshot,
    "--output", $artifact,
    "--source-generation", $before.Generation
  )
  Write-Host "[rollup-refresh] Building and exactly verifying compact rollups..."
  Invoke-StreamingCommand $python.Command $buildArgs

  $queryLog = Join-Path $Workspace "query_log-$stamp.db"
  Invoke-StreamingCommand "scp" @("${WebHost}:$RemoteShared/query_log.db", $queryLog)
  $benchmark = Join-Path $Workspace "benchmark-$stamp.json"
  $benchmarkArgs = @($python.Prefix) + @(
    (Join-Path $repoRoot "scripts\benchmark-nibrs-rollups.py"),
    "--query-log", $queryLog,
    "--source", $snapshot,
    "--rollup", $artifact,
    "--output", $benchmark
  )
  Write-Host "[rollup-refresh] Replaying the slow-query corpus against the artifact..."
  Invoke-StreamingCommand $python.Command $benchmarkArgs

  # The artifact and its sidecar are complete and locally verified. Everything from here is the
  # publication sequence, and every step of it is a recorded transition.
  Set-ArtifactBuilt -Lifecycle $lifecycle
  $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()

  # Re-checked before the uploads and again immediately before activation, exactly as before: if
  # production's source moved under us, this artifact describes a generation that no longer exists.
  $confirmSourceUnchanged = {
    $now = Get-RemoteState
    if ($now.Generation -ne $before.Generation) {
      throw "Production source changed during publication; refusing activation."
    }
  }.GetNewClosure()

  # The freshness contract resolves its generation sidecar as realpath(NIBRS_ROLLUP_DB_PATH) plus
  # ".generation" (lib/nibrs-rollup-router.ts). Pointing it at the candidate's own final path therefore
  # checks the candidate and ITS sidecar -- whereas pointing it at the symlink before the swap would
  # only re-verify the artifact already live.
  # No per-command `2>&1` here. `Invoke-StreamingCommand` owns the property that stderr does not decide
  # success, for every streamed call site at once; adding a redirect per command would imply the
  # opposite -- that safety is arranged one command string at a time -- and would leave the next call
  # site to be remembered by hand. The boundary is the mechanism; the logging suite asserts it.
  $freshnessBase = "cd /opt/nibrs/current && NIBRS_DB_PATH=$RemoteDb NIBRS_SOURCE_GENERATION_PATH=$RemoteShared/nibrs_source.generation"
  $candidateFreshness = "$freshnessBase NIBRS_ROLLUP_DB_PATH=$RemoteShared/$basename npx tsx scripts/check-nibrs-rollup-freshness.ts"
  $liveFreshness = "$freshnessBase NIBRS_ROLLUP_DB_PATH=$RemoteShared/nibrs_rollups.db npx tsx scripts/check-nibrs-rollup-freshness.ts"
  $scoreboard = "cd /opt/nibrs/current && npx tsx scripts/nightly-latency-scoreboard.ts --hours 24 >> /var/log/latency-scoreboard.log 2>&1"

  Write-Host "[rollup-refresh] Publishing the verified artifact..."
  Invoke-ArtifactPublication `
    -Lifecycle $lifecycle `
    -Remote $remote `
    -ExpectedDigest $digest `
    -CandidateFreshnessCommand $candidateFreshness `
    -LiveFreshnessCommand $liveFreshness `
    -ScoreboardCommand $scoreboard `
    -ConfirmSourceUnchanged $confirmSourceUnchanged

  # Publication succeeded the moment a verified candidate went atomically live. Post-commit telemetry
  # that failed is recorded here as a warning rather than suppressing this record -- withholding it
  # would mark a live artifact unverified and make the next run rebuild 176 GB for nothing.
  $state = @{
    completedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    sourceGeneration = $before.Generation
    sourceBytes = $before.SourceBytes
    artifact = $artifact
    sha256 = $digest
    benchmark = $benchmark
    activatedAtUtc = $lifecycle.ActivatedAtUtc
    activationState = $lifecycle.ActivationState
    postCommitWarnings = @($lifecycle.PostCommitWarnings)
  } | ConvertTo-Json
  if ($lifecycle.PostCommitWarnings.Count -gt 0) {
    Write-Host "[rollup-refresh] Publication succeeded with $($lifecycle.PostCommitWarnings.Count) post-commit warning(s); see last-success.json."
  }
  Set-Content -LiteralPath (Join-Path $Workspace "last-success.json") -Value $state -Encoding UTF8
  $successRecorded = $true

  Remove-Item -LiteralPath $snapshot -Force
  $snapshot = $null
  Remove-Item -LiteralPath $queryLog -Force
  Get-ChildItem -LiteralPath $Workspace -Filter "nibrs_rollups-*.db" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $RetainArtifacts |
    ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force
      if (Test-Path "$($_.FullName).generation") {
        Remove-Item -LiteralPath "$($_.FullName).generation" -Force
      }
    }
  Complete-ArtifactLifecycle -Lifecycle $lifecycle
  Write-Host "[rollup-refresh] Activated $basename for generation $($before.Generation)."
  $completed = $true
} finally {
  # Failure path only. A successful run has already removed its snapshot and applied its retention
  # policy; re-running cleanup there could only delete something it meant to keep.
  if (-not $completed) {
    try {
      # Ownership is read off the recorded state, never inferred from where the failure happened.
      # Before the symlink moved, the local artifact is a disposable partial and every run-owned
      # remote path must go. After it moved, production is serving this artifact: keep both.
      $plan = $null
      if ($lifecycle) { $plan = Get-FailureCleanupPlan -Lifecycle $lifecycle }
      $disposableArtifact = $null
      if ($null -eq $plan -or $plan.LocalDisposable) { $disposableArtifact = $artifact }
      Remove-FailedRunArtifacts -Root $Workspace -Partial $partial -Snapshot $snapshot -Artifact $disposableArtifact | Out-Null
      if ($lifecycle -and $remote) {
        Invoke-RemoteFailureCleanup -Lifecycle $lifecycle -Remote $remote | Out-Null
      }
      # Two states a human must be told about, both meaning "production may be serving this artifact
      # even though the run did not finish":
      #   * unknown   -- the link could not be read, so no artifact was removed and nobody knows.
      #   * committed -- read-back proved the swap; a step AFTER the commit then failed. Since
      #                  `reconciled-active` is now a success, the realistic way to land here is a
      #                  local housekeeping failure after `last-success.json` was already written,
      #                  which `$successRecorded` distinguishes so the two records cannot disagree.
      # Incident evidence only. It records what happened; it does not make publication safe, and it is
      # no substitute for operational alerting.
      if ($lifecycle -and ($plan.RequiresHumanReconciliation -or $plan.Committed)) {
        $needsHuman = $plan.RequiresHumanReconciliation
        $note = if ($needsHuman) {
          "ACTIVATION OUTCOME UNKNOWN. The active link could not be read, so no artifact was removed. Check $($lifecycle.RemoteLink) by hand before the next run."
        } elseif ($successRecorded) {
          "Published successfully; a later local housekeeping step failed. See last-success.json -- production is serving this artifact and the next run will no-op."
        } else {
          "Activated but the run did not complete. Production is serving this artifact."
        }
        $activation = @{
          recordedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
          activatedAtUtc = $lifecycle.ActivatedAtUtc
          artifact = $lifecycle.Basename
          sourceGeneration = $before.Generation
          activationState = $lifecycle.ActivationState
          observedLinkTarget = $lifecycle.ObservedLinkTarget
          remoteState = $lifecycle.Remote
          requiresHumanReconciliation = $needsHuman
          note = $note
        } | ConvertTo-Json
        Set-Content -LiteralPath (Join-Path $Workspace "last-activation.json") -Value $activation -Encoding UTF8
        Write-Host "[rollup-refresh] $note Recorded in last-activation.json."
      }
    } catch {
      # Never let cleanup replace the original refresh error -- that would hide why the run failed.
      Write-Host "[rollup-refresh] Cleanup after failure did not complete: $($_.Exception.Message)"
    }
  }
  if ($lock) { $lock.Dispose() }
  Stop-Transcript | Out-Null
}
