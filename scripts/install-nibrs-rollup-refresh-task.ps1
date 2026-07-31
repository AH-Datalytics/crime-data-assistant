[CmdletBinding()]
param(
  [string]$TaskName = "NIBRSAI Rollup Refresh",
  [string]$WebHost = "root@178.156.243.51",
  [string]$Workspace = "C:\tmp\nibrs-rollup-refresh",
  [string]$At = "03:00"
)

$ErrorActionPreference = "Stop"
$refreshScript = Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1"
if (!(Test-Path -LiteralPath $refreshScript)) {
  throw "Missing refresh script: $refreshScript"
}

$time = [DateTime]::ParseExact($At, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $refreshScript +
  '" -WebHost "' + $WebHost + '" -Workspace "' + $Workspace + '"'
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 18)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Checks for a new production NIBRS generation and safely builds rollups off-production." -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (daily at $At; no-op when the active rollup is current)."
