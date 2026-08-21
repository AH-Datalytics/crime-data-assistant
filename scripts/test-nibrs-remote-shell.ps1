# Focused tests for the NIBRS refresh remote shell payload boundary.
#
# No production host is contacted. Where Bash is available it is only asked to PARSE a payload
# (`bash -n`), never to run it, so nothing here touches a database, a workspace, or the network.
#
# A LIMITATION WORTH KNOWING, because it shapes every assertion below. The failure being regressed
# is Linux bash rejecting a CR inside a command (`set: -\r: invalid option`). The MSYS bash shipped
# with Git for Windows strips CR unconditionally and does not even expose the `igncr` option, so no
# Bash on a Windows host can be made to reproduce the rejection. The parse check below is therefore
# a one-directional positive: it proves a normalised payload is accepted, and it becomes genuinely
# CR-sensitive on Linux. What holds the property on Windows is the byte-level assertions -- a CR is
# 0x0D, and its presence or absence in the encoded bytes is exactly what the remote shell reacts to.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "nibrs-remote-shell.ps1")

$script:Passed = 0
$script:Failed = 0
$script:Skipped = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { return }
  throw $Message
}

function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  try {
    & $Body
    $script:Passed++
    Write-Host "  PASS  $Name"
  } catch {
    # A skip is reported as a skip. Counting an unrunnable check as a pass is how a suite starts
    # proving nothing while still printing green.
    if ($_.Exception.Message -like "SKIP:*") {
      $script:Skipped++
      Write-Host "  SKIP  $Name"
      Write-Host "        $($_.Exception.Message.Substring(5).Trim())"
      return
    }
    $script:Failed++
    Write-Host "  FAIL  $Name"
    Write-Host "        $($_.Exception.Message)"
  }
}

# Pull the payload back out of the command exactly as the remote side would: take the base64 word
# and decode it. Asserting the command shape here means a change to the shape cannot quietly turn
# these tests into assertions about nothing.
function Get-EncodedBytes {
  param([Parameter(Mandatory = $true)][string]$Command)
  $parts = $Command.Split(" ")
  Assert-True ($parts.Count -eq 7) "unexpected remote command shape ($($parts.Count) fields): $Command"
  Assert-True ($parts[0] -eq "echo") "the payload is not echoed: $Command"
  Assert-True ($parts[2] -eq "|" -and $parts[3] -eq "base64" -and $parts[4] -eq "-d") "the payload is not base64-decoded remotely: $Command"
  Assert-True ($parts[5] -eq "|" -and $parts[6] -eq "bash") "the payload is not handed to bash: $Command"
  return [Convert]::FromBase64String($parts[1])
}

function Get-DecodedText {
  param([Parameter(Mandatory = $true)][string]$Command)
  return [Text.Encoding]::UTF8.GetString((Get-EncodedBytes -Command $Command))
}

function Assert-NoCarriageReturn {
  param([byte[]]$Bytes, [string]$What)
  $index = [Array]::IndexOf($Bytes, [byte]13)
  Assert-True ($index -lt 0) "$What still carries a carriage return at byte $index"
}

# The shipped preflight, read out of the script that actually runs in production.
function Get-ShippedPreflightPayload {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  $match = [regex]::Match($source, "@'(.*?)'@", [System.Text.RegularExpressions.RegexOptions]::Singleline)
  Assert-True $match.Success "no here-string payload found in refresh-nibrs-rollups.ps1"
  return $match.Groups[1].Value
}

Write-Host "`n-- line endings are normalised at the encoding boundary --"

Test-Case "a CRLF payload encodes with no carriage return" {
  $command = ConvertTo-RemoteBashCommand -Payload "set -e`r`necho hi`r`n"
  Assert-NoCarriageReturn -Bytes (Get-EncodedBytes -Command $command) -What "a CRLF payload"
  Assert-True ((Get-DecodedText -Command $command) -eq "set -e`necho hi`n") "the CRLF payload did not decode to its LF form"
}

Test-Case "a bare CR payload becomes a newline, not a lost line" {
  # Normalising in the wrong order collapses CRLF into a blank line; this pins the order.
  $command = ConvertTo-RemoteBashCommand -Payload "set -e`recho hi"
  Assert-True ((Get-DecodedText -Command $command) -eq "set -e`necho hi") "a bare CR was not turned into a newline"
}

Test-Case "an LF payload is passed through byte-identical" {
  $payload = "set -e`necho hi`n"
  $command = ConvertTo-RemoteBashCommand -Payload $payload
  $expected = [Text.Encoding]::UTF8.GetBytes($payload)
  $actual = Get-EncodedBytes -Command $command
  Assert-True ($actual.Length -eq $expected.Length) "an LF payload changed length: $($expected.Length) -> $($actual.Length)"
  for ($i = 0; $i -lt $expected.Length; $i++) {
    Assert-True ($actual[$i] -eq $expected[$i]) "an LF payload changed at byte $i"
  }
}

Test-Case "mixed endings all become LF and no CRLF pair survives" {
  $command = ConvertTo-RemoteBashCommand -Payload "a`r`nb`nc`rd`r`n"
  $decoded = Get-DecodedText -Command $command
  Assert-True ($decoded -eq "a`nb`nc`nd`n") "mixed endings did not normalise: $([BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($decoded)))"
}

Test-Case "an empty payload does not produce a malformed command" {
  $command = ConvertTo-RemoteBashCommand -Payload ""
  Assert-True ($command -eq "echo  | base64 -d | bash") "an empty payload produced: $command"
}

Write-Host "`n-- the actual incident payload --"

Test-Case "the shipped preflight ships clean even from a CRLF checkout" {
  # Built from the real here-string, then deliberately given CRLF endings so the test states the
  # incident regardless of how this repository happens to be checked out right now.
  $lf = ConvertTo-LfShellPayload -Text (Get-ShippedPreflightPayload)
  $asCrlf = $lf.Replace("`n", "`r`n")

  # First, that this really is the failing shape: encoded naively, it carries CRs.
  $naive = [Text.Encoding]::UTF8.GetBytes($asCrlf)
  Assert-True ([Array]::IndexOf($naive, [byte]13) -ge 0) "the CRLF form of the shipped preflight has no CR; this test proves nothing"

  # Then, that the boundary removes them without altering the script.
  $command = ConvertTo-RemoteBashCommand -Payload $asCrlf
  Assert-NoCarriageReturn -Bytes (Get-EncodedBytes -Command $command) -What "the shipped preflight"
  Assert-True ((Get-DecodedText -Command $command) -eq $lf) "the shipped preflight was altered by normalisation"
}

Test-Case "the shipped preflight still says what it used to say" {
  # Guards against a normalisation that produces CR-free but mangled Bash.
  $decoded = Get-DecodedText -Command (ConvertTo-RemoteBashCommand -Payload (Get-ShippedPreflightPayload))
  Assert-True ($decoded.Contains("set -e`n")) "the payload no longer starts its first statement with set -e"
  Assert-True ($decoded.Contains("printf '%s|%s|%s")) "the payload no longer prints the three-field state line"
  Assert-True (-not $decoded.Contains("`r")) "the payload still contains a CR"
}

Test-Case "bash parses the normalised shipped preflight" {
  # One-directional: see the limitation note at the top of this file.
  $bash = Get-Command bash -ErrorAction SilentlyContinue
  if (-not $bash) { throw "SKIP: no bash on this host to parse the payload with" }
  $bytes = Get-EncodedBytes -Command (ConvertTo-RemoteBashCommand -Payload (Get-ShippedPreflightPayload))
  $path = Join-Path ([System.IO.Path]::GetTempPath()) ("nibrs-payload-" + [Guid]::NewGuid().ToString("N") + ".sh")
  try {
    [System.IO.File]::WriteAllBytes($path, $bytes)
    # -n is parse-only. Nothing in the payload runs.
    $output = & $bash.Source "-n" $path 2>&1
    Assert-True ($LASTEXITCODE -eq 0) "bash rejected the normalised payload (exit $LASTEXITCODE): $($output -join '; ')"
  } finally {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "`n-- the shipped script cannot encode a payload any other way --"

Test-Case "the preflight is encoded through the normalising helper" {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains('. (Join-Path $PSScriptRoot "nibrs-remote-shell.ps1")')) "the refresh script does not load the payload helper"
  Assert-True ($source.Contains('ConvertTo-RemoteBashCommand -Payload $script')) "the preflight is not encoded through the helper"
}

Test-Case "no raw encode path is left in the refresh script" {
  # This is the exact expression that shipped the CRs. If it comes back, so does the incident.
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True (-not $source.Contains('[Text.Encoding]::UTF8.GetBytes')) "the refresh script encodes bytes directly again"
  Assert-True (-not $source.Contains('[Convert]::ToBase64String')) "the refresh script base64-encodes directly again"
}

Test-Case "a second remote payload cannot skip normalisation unnoticed" {
  # A tripwire, not a proof: any new here-string must come with a helper call, or the counts diverge
  # and this fails. Single-line ssh arguments elsewhere in the script are string literals on one
  # source line and cannot contain a line ending, so there is nothing in them to normalise.
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  $hereStrings = ([regex]::Matches($source, "@['`"]")).Count
  # Matched with its parameter so a mention of the helper in a comment is not counted as a call.
  $helperCalls = ([regex]::Matches($source, "ConvertTo-RemoteBashCommand\s+-Payload")).Count
  Assert-True ($hereStrings -eq 1) "expected exactly one here-string in the refresh script, found $hereStrings"
  Assert-True ($helperCalls -eq $hereStrings) "$hereStrings here-string payload(s) but $helperCalls normalising call(s)"
}

$suffix = if ($script:Skipped -gt 0) { ", $script:Skipped skipped" } else { "" }
Write-Host "`nNIBRS remote shell payload: $script:Passed passed, $script:Failed failed$suffix"
if ($script:Failed -gt 0) { exit 1 }
