# Remote shell payload encoding for the NIBRS rollup refresh.
#
# WHY THIS EXISTS. The refresh sends a multi-line Bash preflight to production by base64-encoding a
# PowerShell here-string. A here-string carries the ON-DISK line endings of the file it is written
# in, so a CRLF copy of `refresh-nibrs-rollups.ps1` encodes a carriage return at the end of every
# line. Linux bash then reads the first line as `set -e<CR>` and dies:
#
#     bash: line 1: set: -\r: invalid option
#
# That is how the 2026-08-21 03:00 scheduled run failed, about two seconds in, immediately after a
# successful stale-partial cleanup. The 08-19 and 08-20 runs got past the same preflight because the
# working copy still had LF endings then; nothing about the payload itself changed.
#
# Which is the point: the line endings of a checked-out PowerShell file are not something this
# script controls. `core.autocrlf`, an editor, a fresh clone, or a copy through a Windows tool can
# each flip them, and the committed blob and the working copy can disagree. Correctness must not
# depend on any of that. The property kept here is narrow and absolute: a payload is normalised to
# LF at the encoding boundary, before a single byte is encoded or executed remotely.
#
# Kept in its own file so the boundary can be tested without contacting production.

Set-StrictMode -Version Latest

<#
.SYNOPSIS
Normalise a shell payload to LF, whatever line endings it arrived with.
#>
function ConvertTo-LfShellPayload {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
  )
  # CRLF first, then any surviving bare CR. The other order would turn every CRLF into a blank line.
  return $Text.Replace("`r`n", "`n").Replace("`r", "`n")
}

<#
.SYNOPSIS
Build the `ssh` argument that runs a Bash payload remotely: normalised to LF, then base64-encoded.

Normalisation and encoding are deliberately fused into one function. A caller cannot encode a
payload without normalising it, and that is the only form of this guarantee that survives someone
adding a second remote payload here a year from now.
#>
function ConvertTo-RemoteBashCommand {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Payload
  )
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-LfShellPayload -Text $Payload))
  # Belt and braces. If the normalisation above is ever weakened, fail here rather than ship a
  # payload that a remote shell will misread one line at a time.
  if ($bytes -contains 13) {
    throw "Refusing to send a remote shell payload containing a carriage return."
  }
  return "echo " + [Convert]::ToBase64String($bytes) + " | base64 -d | bash"
}
