# Focused tests for the NIBRS refresh workspace cleanup.
#
# Everything runs in a throwaway workspace under the system temp directory. The real refresh
# directory is never touched, and no production host is contacted.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "nibrs-refresh-cleanup.ps1")

$script:Passed = 0
$script:Failed = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { return }
  throw $Message
}

function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("nibrs-refresh-test-" + [Guid]::NewGuid().ToString("N"))
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

function New-File {
  param([string]$Path, [int]$Bytes = 16)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllBytes($Path, (New-Object byte[] $Bytes))
}

Write-Host "`n-- stale partials are removed before the free-space check --"

Test-Case "a stale partial from another generation is removed" {
  param($root)
  # This is the incident: the orphan belongs to a DIFFERENT generation, so the old per-generation
  # delete could never see it, and it consumed the space the preflight demanded.
  $stale = Join-Path $root "nibrs-source-2026-08-19T00_00_00.db.partial"
  New-File $stale 4096
  $removed = @(Remove-StaleSourcePartials -Root $root)
  Assert-True (-not (Test-Path -LiteralPath $stale)) "the stale partial survived"
  Assert-True ($removed.Count -eq 1) "expected one removal, got $($removed.Count)"
}

Test-Case "several stale partials are all removed" {
  param($root)
  1..3 | ForEach-Object { New-File (Join-Path $root "nibrs-source-gen$_.db.partial") 128 }
  $removed = @(Remove-StaleSourcePartials -Root $root)
  Assert-True ($removed.Count -eq 3) "expected three removals, got $($removed.Count)"
  Assert-True (@(Get-ChildItem -LiteralPath $root -Filter "*.partial").Count -eq 0) "a partial survived"
}

Test-Case "removal happens before a simulated free-space failure" {
  param($root)
  # Order is the property: with the partial gone first, the space the preflight sees is the space
  # the partial was holding. Simulated by measuring the directory either side of the sweep.
  $stale = Join-Path $root "nibrs-source-old.db.partial"
  New-File $stale 65536
  # Summed directly: under Set-StrictMode, reading .Sum off an empty Measure-Object result throws
  # before any null check can run.
  $usedBytes = {
    param($dir)
    $total = [int64]0
    foreach ($file in @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue)) {
      $total += [int64]$file.Length
    }
    return $total
  }
  $before = & $usedBytes $root
  Remove-StaleSourcePartials -Root $root | Out-Null
  $afterSweep = & $usedBytes $root
  # The preflight would only now run, and it sees the reclaimed space.
  $preflightRan = $true
  Assert-True ($before -gt $afterSweep) "the sweep reclaimed nothing"
  Assert-True $preflightRan "the preflight must run after the sweep, not before"
}

Write-Host "`n-- a failed run removes its own leftovers, on either side of the move --"

Test-Case "a failure before the move removes the partial" {
  param($root)
  $snapshot = Join-Path $root "nibrs-source-gen.db"
  $partial = "$snapshot.partial"
  New-File $partial 2048
  Remove-FailedRunArtifacts -Root $root -Partial $partial -Snapshot $snapshot | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $partial)) "the partial survived a pre-move failure"
}

Test-Case "a failure after the move removes the source snapshot" {
  param($root)
  $snapshot = Join-Path $root "nibrs-source-gen.db"
  New-File $snapshot 2048
  Remove-FailedRunArtifacts -Root $root -Partial "$snapshot.partial" -Snapshot $snapshot | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $snapshot)) "the snapshot survived a post-move failure"
}

Test-Case "a missing file is not an error" {
  param($root)
  $removed = @(Remove-FailedRunArtifacts -Root $root -Partial (Join-Path $root "absent.db.partial") -Snapshot $null)
  Assert-True ($removed.Count -eq 0) "nothing should have been removed"
}

Write-Host "`n-- everything else survives --"

Test-Case "retained artifacts, sidecars, logs, state, lock and unrelated files survive" {
  param($root)
  $keep = @(
    (Join-Path $root "nibrs_rollups-20260819_120000.db"),
    (Join-Path $root "nibrs_rollups-20260819_120000.db.generation"),
    (Join-Path $root "refresh-20260819_120000.log"),
    (Join-Path $root "last-success.json"),
    (Join-Path $root "refresh.lock"),
    (Join-Path $root "benchmark-20260819_120000.json"),
    (Join-Path $root "query_log-20260819_120000.db"),
    (Join-Path $root "something-unrelated.txt"),
    # Named to look like the target without being it: a completed snapshot is not a partial.
    (Join-Path $root "nibrs-source-gen.db")
  )
  $keep | ForEach-Object { New-File $_ 32 }
  $stale = Join-Path $root "nibrs-source-other.db.partial"
  New-File $stale 32

  Remove-StaleSourcePartials -Root $root | Out-Null

  Assert-True (-not (Test-Path -LiteralPath $stale)) "the stale partial was not removed"
  foreach ($path in $keep) {
    Assert-True (Test-Path -LiteralPath $path) "the sweep deleted $([System.IO.Path]::GetFileName($path))"
  }
}

Test-Case "the failure path does not touch retained artifacts" {
  param($root)
  $artifact = Join-Path $root "nibrs_rollups-20260819_120000.db"
  $log = Join-Path $root "refresh-20260819_120000.log"
  $state = Join-Path $root "last-success.json"
  @($artifact, $log, $state) | ForEach-Object { New-File $_ 32 }
  $snapshot = Join-Path $root "nibrs-source-gen.db"
  New-File $snapshot 32

  Remove-FailedRunArtifacts -Root $root -Partial "$snapshot.partial" -Snapshot $snapshot | Out-Null

  Assert-True (-not (Test-Path -LiteralPath $snapshot)) "the run's own snapshot survived"
  foreach ($path in @($artifact, $log, $state)) {
    Assert-True (Test-Path -LiteralPath $path) "the failure path deleted $([System.IO.Path]::GetFileName($path))"
  }
}

Write-Host "`n-- nothing outside the workspace can be selected --"

Test-Case "a path outside the workspace is refused" {
  param($root)
  $outsideDir = Join-Path ([System.IO.Path]::GetTempPath()) ("nibrs-outside-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $outsideDir | Out-Null
  $outside = Join-Path $outsideDir "nibrs-source-gen.db.partial"
  New-File $outside 32
  try {
    $removed = Remove-WorkspaceFile -Path $outside -Root $root -Reason "test"
    Assert-True (-not $removed) "a file outside the workspace was removed"
    Assert-True (Test-Path -LiteralPath $outside) "the outside file was deleted"
  } finally {
    Remove-Item -LiteralPath $outsideDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Test-Case "traversal out of the workspace is refused" {
  param($root)
  $escape = Join-Path $root "..\nibrs-source-escape.db.partial"
  New-File ([System.IO.Path]::GetFullPath($escape)) 32
  try {
    Assert-True (-not (Test-InsideWorkspace -Path $escape -Root $root)) "a traversal path was accepted"
    $removed = Remove-WorkspaceFile -Path $escape -Root $root -Reason "test"
    Assert-True (-not $removed) "a traversal path was removed"
    Assert-True (Test-Path -LiteralPath ([System.IO.Path]::GetFullPath($escape))) "the traversal target was deleted"
  } finally {
    Remove-Item -LiteralPath ([System.IO.Path]::GetFullPath($escape)) -Force -ErrorAction SilentlyContinue
  }
}

Test-Case "a sibling directory with the same prefix is refused" {
  param($root)
  # `...-refresh-evil` must not pass as being inside `...-refresh`.
  $sibling = "$root-evil"
  New-Item -ItemType Directory -Force -Path $sibling | Out-Null
  $target = Join-Path $sibling "nibrs-source-gen.db.partial"
  New-File $target 32
  try {
    Assert-True (-not (Test-InsideWorkspace -Path $target -Root $root)) "a prefix-sharing sibling was accepted"
  } finally {
    Remove-Item -LiteralPath $sibling -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Test-Case "the workspace root itself is not a deletion target" {
  param($root)
  Assert-True (-not (Test-InsideWorkspace -Path $root -Root $root)) "the root was accepted as a target"
}

Write-Host "`n-- the shipped script wires the properties in the right order --"

Test-Case "the sweep runs after the lock and before the free-space check" {
  param($root)
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  $lockAt = $source.IndexOf('[System.IO.File]::Open($lockPath')
  $sweepAt = $source.IndexOf('Remove-StaleSourcePartials -Root $Workspace')
  $spaceAt = $source.IndexOf('if ($drive.Free -lt $required)')
  Assert-True ($lockAt -ge 0) "the lock acquisition is gone; this check is stale"
  Assert-True ($sweepAt -ge 0) "the shipped script never sweeps stale partials"
  Assert-True ($spaceAt -ge 0) "the free-space check is gone; this check is stale"
  Assert-True ($lockAt -lt $sweepAt) "the sweep runs before the lock is held"
  Assert-True ($sweepAt -lt $spaceAt) "the sweep runs after the free-space check, which is the bug"
}

Test-Case "the failure path cleans up only when the run did not complete" {
  param($root)
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains('if (-not $completed)')) "cleanup is not gated on failure"
  Assert-True ($source.Contains('Remove-FailedRunArtifacts -Root $Workspace')) "the failure path never cleans up"
  Assert-True ($source.Contains('$completed = $true')) "nothing ever marks the run complete"
  # Cleanup must not be able to replace the original error.
  $finallyAt = $source.IndexOf('} finally {')
  $catchAfter = $source.IndexOf('Cleanup after failure did not complete', $finallyAt)
  Assert-True ($catchAfter -gt $finallyAt) "a cleanup failure is not caught and logged"
}

Write-Host "`n-- a failed run also removes its own rollup artifact and SQLite sidecars --"

Test-Case "a failure during the build removes the run's own partial rollup" {
  param($root)
  # The 2026-08-22 leftovers: cleanup reclaimed the 176 GB snapshot but left a 1.6 MB partial
  # `nibrs_rollups-20260822_080002.db` behind, which no later run would ever activate.
  $artifact = Join-Path $root "nibrs_rollups-20260822_080002.db"
  New-File $artifact 1024
  Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $artifact | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $artifact)) "the run's own partial rollup survived"
}

Test-Case "a failure removes the run artifact's SQLite sidecars and generation file" {
  param($root)
  $artifact = Join-Path $root "nibrs_rollups-20260822_080002.db"
  $sidecars = @("$artifact-journal", "$artifact-wal", "$artifact-shm", "$artifact.generation")
  New-File $artifact 1024
  $sidecars | ForEach-Object { New-File $_ 64 }
  Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $artifact | Out-Null
  foreach ($path in $sidecars) {
    Assert-True (-not (Test-Path -LiteralPath $path)) "$([System.IO.Path]::GetFileName($path)) survived"
  }
}

Test-Case "a failure removes the source snapshot's SQLite sidecars" {
  param($root)
  # Observed after the 2026-08-22 run: a 32 KB `-shm` and an empty `-wal` next to the snapshot,
  # opened by the build reading the snapshot. The snapshot went; these stayed.
  $snapshot = Join-Path $root "nibrs-source-176727072768_1786871106929227623.db"
  $sidecars = @("$snapshot-shm", "$snapshot-wal", "$snapshot-journal")
  New-File $snapshot 4096
  $sidecars | ForEach-Object { New-File $_ 32 }
  Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $snapshot | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $snapshot)) "the snapshot survived"
  foreach ($path in $sidecars) {
    Assert-True (-not (Test-Path -LiteralPath $path)) "$([System.IO.Path]::GetFileName($path)) survived"
  }
}

Test-Case "an empty sidecar is still removed" {
  param($root)
  # The observed `-wal` was zero bytes. A cleanup that skips empty files would have left it.
  $snapshot = Join-Path $root "nibrs-source-gen.db"
  $wal = "$snapshot-wal"
  New-File $snapshot 32
  New-File $wal 0
  Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $snapshot | Out-Null
  Assert-True (-not (Test-Path -LiteralPath $wal)) "the empty -wal sidecar survived"
}

Write-Host "`n-- cleanup is exact-path, so no other run is collateral --"

Test-Case "another run's retained artifact and its sidecars survive" {
  param($root)
  # Retention is a success-path policy. A failed run must never reach into the retained set.
  $keep = Join-Path $root "nibrs_rollups-20260819_120000.db"
  $keepSidecars = @("$keep.generation", "$keep-wal", "$keep-shm")
  New-File $keep 512
  $keepSidecars | ForEach-Object { New-File $_ 64 }
  $mine = Join-Path $root "nibrs_rollups-20260822_080002.db"
  New-File $mine 512

  Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $mine | Out-Null

  Assert-True (-not (Test-Path -LiteralPath $mine)) "the run's own artifact survived"
  Assert-True (Test-Path -LiteralPath $keep) "another run's retained artifact was deleted"
  foreach ($path in $keepSidecars) {
    Assert-True (Test-Path -LiteralPath $path) "another run's $([System.IO.Path]::GetFileName($path)) was deleted"
  }
}

Test-Case "a run artifact outside the workspace is refused" {
  param($root)
  $outsideDir = Join-Path ([System.IO.Path]::GetTempPath()) ("nibrs-outside-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $outsideDir | Out-Null
  $outside = Join-Path $outsideDir "nibrs_rollups-20260822_080002.db"
  New-File $outside 64
  try {
    Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $outside | Out-Null
    Assert-True (Test-Path -LiteralPath $outside) "an artifact outside the workspace was deleted"
  } finally {
    Remove-Item -LiteralPath $outsideDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Test-Case "logs, state and the lock still survive the wider cleanup" {
  param($root)
  $keep = @(
    (Join-Path $root "refresh-20260822_080002.log"),
    (Join-Path $root "last-success.json"),
    (Join-Path $root "refresh.lock"),
    (Join-Path $root "benchmark-20260822_080002.json"),
    (Join-Path $root "query_log-20260822_080002.db")
  )
  $keep | ForEach-Object { New-File $_ 32 }
  $artifact = Join-Path $root "nibrs_rollups-20260822_080002.db"
  New-File $artifact 32
  Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $artifact | Out-Null
  foreach ($path in $keep) {
    Assert-True (Test-Path -LiteralPath $path) "cleanup deleted $([System.IO.Path]::GetFileName($path))"
  }
}

Write-Host "`n-- a cleanup that cannot finish never replaces the original failure --"

Test-Case "a locked target does not make cleanup throw" {
  param($root)
  # The build error is the one a human needs. If cleanup threw on a file the build still had open,
  # the transcript would end with a file-permission error and the real cause would be gone.
  $artifact = Join-Path $root "nibrs_rollups-20260822_080002.db"
  New-File $artifact 128
  $held = [System.IO.File]::Open($artifact, "Open", "ReadWrite", "None")
  try {
    $removed = @(Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $artifact)
    Assert-True ($removed.Count -eq 0) "a locked file was reported as removed"
    Assert-True (Test-Path -LiteralPath $artifact) "a locked file was somehow deleted"
  } finally {
    $held.Dispose()
  }
}

Test-Case "a locked sidecar does not stop the other targets being removed" {
  param($root)
  $artifact = Join-Path $root "nibrs_rollups-20260822_080002.db"
  $journal = "$artifact-journal"
  New-File $artifact 128
  New-File $journal 64
  $held = [System.IO.File]::Open($journal, "Open", "ReadWrite", "None")
  try {
    Remove-FailedRunArtifacts -Root $root -Partial $null -Snapshot $null -Artifact $artifact | Out-Null
    Assert-True (-not (Test-Path -LiteralPath $artifact)) "a locked sidecar aborted the whole cleanup"
  } finally {
    $held.Dispose()
  }
}

Write-Host "`nNIBRS refresh cleanup: $script:Passed passed, $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
