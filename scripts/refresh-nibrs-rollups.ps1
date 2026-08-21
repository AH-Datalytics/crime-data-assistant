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
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd_HHmmss")
New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
$logPath = Join-Path $Workspace "refresh-$stamp.log"
Start-Transcript -Path $logPath -Append | Out-Null

function Invoke-Captured {
  param([string]$Command, [string[]]$Arguments)
  $output = & $Command @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("$Command failed with exit code $LASTEXITCODE" + [Environment]::NewLine + ($output -join [Environment]::NewLine))
  }
  return ($output -join [Environment]::NewLine).Trim()
}

function Invoke-Streaming {
  param([string]$Command, [string[]]$Arguments)
  & $Command @Arguments 2>&1 | Tee-Object -FilePath $logPath -Append
  if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

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
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
  $raw = Invoke-Captured "ssh" @($WebHost, "echo $encoded | base64 -d | bash")
  $parts = $raw.Split("|")
  if ($parts.Count -ne 3 -or $parts[0] -notmatch "^\d+:\d+$") { throw "Unexpected remote state: $raw" }
  return [pscustomobject]@{
    Generation = $parts[0]
    SourceBytes = [int64]$parts[1]
    ActiveGeneration = $parts[2]
  }
}

$lockPath = Join-Path $Workspace "refresh.lock"
$lock = $null
$snapshot = $null
$partial = $null
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
  Invoke-Streaming "scp" @("${WebHost}:$RemoteDb", $partial)
  $copiedSize = (Get-Item -LiteralPath $partial).Length
  if ($copiedSize -ne $before.SourceBytes) {
    throw "Snapshot size mismatch: copied $copiedSize; expected $($before.SourceBytes)."
  }
  $afterCopy = Get-RemoteState
  if ($afterCopy.Generation -ne $before.Generation -or $afterCopy.SourceBytes -ne $before.SourceBytes) {
    throw "Production source changed during the snapshot copy; refusing to build."
  }
  Move-Item -LiteralPath $partial -Destination $snapshot

  $artifact = Join-Path $Workspace "nibrs_rollups-$stamp.db"
  $python = Get-PythonInvocation
  $buildArgs = @($python.Prefix) + @(
    (Join-Path $repoRoot "scripts\build-nibrs-rollups.py"),
    "--source", $snapshot,
    "--output", $artifact,
    "--source-generation", $before.Generation
  )
  Write-Host "[rollup-refresh] Building and exactly verifying compact rollups..."
  Invoke-Streaming $python.Command $buildArgs

  $queryLog = Join-Path $Workspace "query_log-$stamp.db"
  Invoke-Streaming "scp" @("${WebHost}:$RemoteShared/query_log.db", $queryLog)
  $benchmark = Join-Path $Workspace "benchmark-$stamp.json"
  $benchmarkArgs = @($python.Prefix) + @(
    (Join-Path $repoRoot "scripts\benchmark-nibrs-rollups.py"),
    "--query-log", $queryLog,
    "--source", $snapshot,
    "--rollup", $artifact,
    "--output", $benchmark
  )
  Write-Host "[rollup-refresh] Replaying the slow-query corpus against the artifact..."
  Invoke-Streaming $python.Command $benchmarkArgs

  $beforeUpload = Get-RemoteState
  if ($beforeUpload.Generation -ne $before.Generation) {
    throw "Production source changed before upload; refusing activation."
  }
  $basename = Split-Path -Leaf $artifact
  $remoteArtifact = "$RemoteShared/$basename"
  $sidecar = "$artifact.generation"
  $digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
  Invoke-Captured "ssh" @(
    $WebHost,
    "test ! -e '$remoteArtifact' -a ! -e '$remoteArtifact.tmp' -a ! -e '$remoteArtifact.generation' -a ! -e '$remoteArtifact.generation.tmp'"
  )

  Write-Host "[rollup-refresh] Uploading verified artifact..."
  Invoke-Streaming "scp" @($artifact, "${WebHost}:$remoteArtifact.tmp")
  Invoke-Streaming "scp" @($sidecar, "${WebHost}:$remoteArtifact.generation.tmp")
  $remoteDigest = Invoke-Captured "ssh" @($WebHost, "sha256sum '$remoteArtifact.tmp' | cut -d ' ' -f1")
  if ($remoteDigest -ne $digest) { throw "Remote SHA-256 mismatch." }

  $beforeActivation = Get-RemoteState
  if ($beforeActivation.Generation -ne $before.Generation) {
    throw "Production source changed during upload; refusing activation."
  }
  Invoke-Captured "ssh" @(
    $WebHost,
    "set -e; mv '$remoteArtifact.tmp' '$remoteArtifact'; mv '$remoteArtifact.generation.tmp' '$remoteArtifact.generation'; ln -sfn '$basename' '$RemoteShared/nibrs_rollups.db'"
  )

  Write-Host "[rollup-refresh] Verifying production freshness contract..."
  $freshness = "cd /opt/nibrs/current && NIBRS_DB_PATH=$RemoteDb NIBRS_ROLLUP_DB_PATH=$RemoteShared/nibrs_rollups.db NIBRS_SOURCE_GENERATION_PATH=$RemoteShared/nibrs_source.generation npx tsx scripts/check-nibrs-rollup-freshness.ts"
  Invoke-Streaming "ssh" @($WebHost, $freshness)
  Invoke-Streaming "ssh" @($WebHost, "cd /opt/nibrs/current && npx tsx scripts/nightly-latency-scoreboard.ts --hours 24 >> /var/log/latency-scoreboard.log 2>&1")

  $state = @{
    completedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    sourceGeneration = $before.Generation
    sourceBytes = $before.SourceBytes
    artifact = $artifact
    sha256 = $digest
    benchmark = $benchmark
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $Workspace "last-success.json") -Value $state -Encoding UTF8

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
  Write-Host "[rollup-refresh] Activated $basename for generation $($before.Generation)."
  $completed = $true
} finally {
  # Failure path only. A successful run has already removed its snapshot and applied its retention
  # policy; re-running cleanup there could only delete something it meant to keep.
  if (-not $completed) {
    try {
      Remove-FailedRunArtifacts -Root $Workspace -Partial $partial -Snapshot $snapshot | Out-Null
    } catch {
      # Never let cleanup replace the original refresh error -- that would hide why the run failed.
      Write-Host "[rollup-refresh] Cleanup after failure did not complete: $($_.Exception.Message)"
    }
  }
  if ($lock) { $lock.Dispose() }
  Stop-Transcript | Out-Null
}
