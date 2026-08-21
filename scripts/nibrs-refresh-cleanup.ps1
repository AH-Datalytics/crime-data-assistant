# Workspace cleanup for the NIBRS rollup refresh.
#
# WHY THIS EXISTS. On 2026-08-20 the scheduled refresh was terminated hard (Windows result
# 0x8007042B) and left a 119 GiB `nibrs-source-*.db.partial` behind. The script only ever deleted a
# partial for the generation it was about to copy, and only AFTER its free-space preflight, so the
# orphan from a different generation sat there consuming the very space the preflight demanded --
# every later run then failed before reaching the deletion that would have fixed it. The `finally`
# block released the lock and nothing else, so a hard stop always leaked its snapshot.
#
# Two properties, kept in this separate file so they can be tested without a production source:
#   1. stale partials are removed after the lock is taken and BEFORE the free-space check;
#   2. an ordinary failure removes the current run's own partial and source snapshot, best effort.
#
# Every deletion target is resolved and proved to sit inside the configured workspace first. A
# cleanup path that can be pointed outside its workspace is worse than no cleanup.

Set-StrictMode -Version Latest

<#
.SYNOPSIS
Is this path inside the workspace root, after resolving `..` and symlink-free normalisation?
#>
function Test-InsideWorkspace {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($Root)
  } catch {
    return $false
  }
  # Compare against the root WITH a trailing separator, so `C:\tmp\nibrs-rollup-refresh-evil`
  # cannot pass as being inside `C:\tmp\nibrs-rollup-refresh`.
  $rootWithSeparator = $fullRoot.TrimEnd([char]92) + [char]92
  if ($fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  return $fullPath.StartsWith($rootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)
}

<#
.SYNOPSIS
Remove one file, but only when it resolves inside the workspace. Returns $true if it was removed.
#>
function Remove-WorkspaceFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$Reason = "stale file"
  )
  if (-not (Test-InsideWorkspace -Path $Path -Root $Root)) {
    Write-Host "[rollup-refresh] Refusing to remove $Path ($Reason): it does not resolve inside $Root."
    return $false
  }
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $size = (Get-Item -LiteralPath $Path -ErrorAction Stop).Length
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    Write-Host "[rollup-refresh] Removed $Reason ($size bytes): $Path"
    return $true
  } catch {
    # Never rethrow: cleanup failing must not replace the error that caused the cleanup.
    Write-Host "[rollup-refresh] Could not remove $Reason ${Path}: $($_.Exception.Message)"
    return $false
  }
}

<#
.SYNOPSIS
Remove every orphaned source partial in the workspace. Call AFTER the lock, BEFORE the space check.

The lock is what makes this safe: holding it means no other refresh is mid-copy, so any
`nibrs-source-*.db.partial` present is the residue of a run that died.
#>
function Remove-StaleSourcePartials {
  param([Parameter(Mandatory = $true)][string]$Root)
  $removed = @()
  if (-not (Test-Path -LiteralPath $Root)) { return $removed }
  # Enumerated by an explicit, anchored pattern -- never a broad wildcard sweep of the directory.
  $candidates = @(Get-ChildItem -LiteralPath $Root -Filter "nibrs-source-*.db.partial" -File -ErrorAction SilentlyContinue)
  foreach ($candidate in $candidates) {
    if (Remove-WorkspaceFile -Path $candidate.FullName -Root $Root -Reason "stale source partial") {
      $removed += $candidate.FullName
    }
  }
  if ($removed.Count -eq 0) {
    Write-Host "[rollup-refresh] No stale source partials to remove."
  }
  return $removed
}

<#
.SYNOPSIS
Best-effort removal of the current run's own working files after a failure.

Only the run's partial and its completed source snapshot. Retained rollup artifacts, generation
sidecars, logs, last-success.json, the lock and anything unrelated are left alone: this runs on the
failure path, where deleting more than the run's own leftovers would turn one failed refresh into a
lost retention set.
#>
function Remove-FailedRunArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$Partial,
    [string]$Snapshot
  )
  $removed = @()
  foreach ($entry in @(
      @{ Path = $Partial;  Reason = "partial snapshot from the failed run" },
      @{ Path = $Snapshot; Reason = "source snapshot from the failed run" })) {
    if ([string]::IsNullOrWhiteSpace($entry.Path)) { continue }
    if (Remove-WorkspaceFile -Path $entry.Path -Root $Root -Reason $entry.Reason) {
      $removed += $entry.Path
    }
  }
  return $removed
}
