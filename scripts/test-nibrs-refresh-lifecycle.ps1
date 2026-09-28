# Failure-injection tests for the NIBRS refresh artifact publication transaction.
#
# WHY THIS EXISTS. Two defects in a row in this component -- the 2026-08-20 partial-snapshot leak and
# the 2026-08-22 log-handle collision -- fired the baseline's protocol row 3. The reassessment found
# ownership was never modelled; the script carried one boolean and inferred the rest from where in a
# 200-line try block a failure landed.
#
# Two rounds of Codex review then found the commit point itself unsafe. The properties this suite
# exists to hold, each one a defect that was really there:
#
#   * A RETURNED EXIT CODE IS NOT EVIDENCE. ssh can move the symlink and then lose the connection, and
#     it can also return success without having selected anything. So the link is read back after
#     EVERY activation attempt and must name this exact run. Nothing else establishes the commit.
#   * UNCERTAINTY IS NOT FAILURE. If the link cannot be read, no artifact is deleted.
#   * OBSERVED REALITY OUTRANKS A LOST ACKNOWLEDGEMENT. If read-back proves the verified candidate is
#     live, publication succeeded and the transport error is recorded as a warning.
#   * THE CANDIDATE IS VERIFIED BEFORE IT CAN GO LIVE, at its own path, not through the symlink.
#   * THE STAGING LINK IS PER-RUN AND OWNED. A shared staging path is residue two publishers can race.
#   * THE LIVE-PATH CHECK IS NOT THE SCOREBOARD. Both are post-commit, but they are recorded as
#     different kinds of warning because they mean different things.
#
# The fake remote simulates the shared directory, the symlink and the staging link, so "the next run
# is not blocked" is asserted by replaying the next run's own precondition rather than by reading
# source. Nothing here contacts production, runs ssh or scp, or needs a snapshot.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "nibrs-refresh-lifecycle.ps1")

$script:Passed = 0
$script:Failed = 0

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if ($Condition) { return }
  throw $Message
}

function Assert-SetEqual {
  param([string[]]$Actual, [string[]]$Expected, [string]$Message)
  $a = @($Actual | Sort-Object) -join " | "
  $e = @($Expected | Sort-Object) -join " | "
  if ($a -eq $e) { return }
  throw "$Message`n          expected: $e`n          actual:   $a"
}

function Test-Case {
  param([string]$Name, [scriptblock]$Body)
  try {
    & $Body
    $script:Passed++
    Write-Host "  PASS  $Name"
  } catch {
    $script:Failed++
    Write-Host "  FAIL  $Name"
    Write-Host "        $($_.Exception.Message)"
  }
}

function Format-Thrown {
  param($Thrown)
  if ($null -eq $Thrown) { return "(nothing was thrown)" }
  return $Thrown.Exception.Message
}

function Get-WarningKinds {
  param($Lifecycle)
  return @(@($Lifecycle.PostCommitWarnings) | ForEach-Object { $_.Kind })
}

# --------------------------------------------------------------------------------------------------
# The fake remote: a hashtable standing in for /opt/nibrs/shared, plus the active symlink.
# --------------------------------------------------------------------------------------------------

$script:RemoteShared = "/opt/nibrs/shared"
$script:Basename = "nibrs_rollups-20260822_080002.db"
$script:PriorBasename = "nibrs_rollups-20260819_120000.db"
$script:RemoteArtifact = "$script:RemoteShared/$script:Basename"
$script:RemoteLink = "$script:RemoteShared/nibrs_rollups.db"
$script:LocalArtifact = "C:\tmp\nibrs-rollup-refresh\$script:Basename"

<#
.SYNOPSIS
A remote that records every operation, simulates the shared directory, and can misbehave in each of
the ways the two reviews identified.

.PARAMETER FailAt
Throw at this transition. Side-effect ordering is deliberate per operation: Upload creates its
destination FIRST then throws, modelling a partial transfer; Move throws BEFORE its side effect,
modelling an atomic rename that either happened or did not. Activation is modelled as its two real
steps -- create the staging link, then rename it over the live one -- so a failure between them can be
injected.

.PARAMETER ApplyThenFailActivation
The swap really applies and THEN reports failure, as a dropped ssh connection would.

.PARAMETER ActivationNoOpSuccess
Activation returns SUCCESS without changing the link -- a malformed command, an external writer, or a
future seam regression. Only read-back catches this.

.PARAMETER ReadLinkUnavailable
Reconciliation cannot establish the link target at all.
#>
function New-FakeRemote {
  param(
    [string]$FailAt = "",
    [string]$Digest = "digest-ok",
    [string]$ActiveLink = $script:PriorBasename,
    [switch]$ApplyThenFailActivation,
    [switch]$ActivationNoOpSuccess,
    [switch]$ReadLinkUnavailable,
    [string]$ResolveActualReturns = $null,
    [string]$ResolveKindReturns = "file"
  )
  $fake = [pscustomobject]@{
    Files          = @{}
    Calls          = (New-Object System.Collections.ArrayList)
    Link           = $ActiveLink
    FailAt         = $FailAt
    DigestValue    = $Digest
    Removed        = (New-Object System.Collections.ArrayList)
    ApplyThenFail  = [bool]$ApplyThenFailActivation
    NoOpSuccess    = [bool]$ActivationNoOpSuccess
    ReadLinkBroken = [bool]$ReadLinkUnavailable
    ResolveActualOverride = $ResolveActualReturns
    ResolveKind = $ResolveKindReturns
  }
  # Captured as a LOCAL before the closures are made: inside GetNewClosure() the `$script:` scope is
  # the closure's own module, not this file, so `$script:RemoteShared` would read as empty there.
  $sharedRoot = $script:RemoteShared
  $step = {
    param([string]$Name)
    [void]$fake.Calls.Add($Name)
    if ($fake.FailAt -eq $Name) { throw "injected failure at $Name" }
  }.GetNewClosure()
  $fake | Add-Member -MemberType NoteProperty -Name Step -Value $step

  $fake | Add-Member -MemberType NoteProperty -Name VerifyAtomicSwap -Value ({
    param()
    & $fake.Step "verify-activation-capability"
  }.GetNewClosure())

  $fake | Add-Member -MemberType NoteProperty -Name TestClear -Value ({
    param([string[]]$Paths)
    & $fake.Step "precondition"
    foreach ($path in $Paths) {
      if ($fake.Files.ContainsKey($path)) { throw "remote path already exists: $path" }
    }
  }.GetNewClosure())

  $fake | Add-Member -MemberType NoteProperty -Name Upload -Value ({
    param([string]$From, [string]$To, [string]$Label)
    $fake.Files[$To] = "partial"
    & $fake.Step $Label
    $fake.Files[$To] = "complete"
  }.GetNewClosure())

  $fake | Add-Member -MemberType NoteProperty -Name Digest -Value ({
    param([string]$Path)
    & $fake.Step "verify-digest"
    return $fake.DigestValue
  }.GetNewClosure())

  $fake | Add-Member -MemberType NoteProperty -Name Move -Value ({
    param([string]$From, [string]$To, [string]$Label)
    & $fake.Step $Label
    if (-not $fake.Files.ContainsKey($From)) { throw "remote move source missing: $From" }
    $fake.Files[$To] = $fake.Files[$From]
    $fake.Files.Remove($From)
  }.GetNewClosure())

  # Two real steps in one ssh call, so `set -e` failing between them is a state the tests can drive.
  $fake | Add-Member -MemberType NoteProperty -Name Activate -Value ({
    param([string]$Basename, [string]$Link, [string]$StagingLink)
    if ($fake.NoOpSuccess) {
      # Returns success, selects nothing. The link is left exactly as it was.
      [void]$fake.Calls.Add("create-staging-link")
      [void]$fake.Calls.Add("activate-symlink")
      return
    }
    $fake.Files[$StagingLink] = "symlink -> $Basename"
    & $fake.Step "create-staging-link"
    if ($fake.ApplyThenFail) {
      $fake.Link = $Basename
      $fake.Files.Remove($StagingLink)
      [void]$fake.Calls.Add("activate-symlink")
      throw "connection closed after the swap was applied"
    }
    & $fake.Step "activate-symlink"
    $fake.Link = $Basename
    $fake.Files.Remove($StagingLink)
  }.GetNewClosure())

  # The host canonicalises both sides with one resolver, so the fake does too: `Actual` is what the
  # live link resolves to, `Expected` is the caller's artifact path resolved the same way, and `Kind`
  # says whether the resolved target is a regular file.
  $fake | Add-Member -MemberType NoteProperty -Name ResolveLinkTarget -Value ({
    param([string]$Link, [string]$ExpectedPath)
    [void]$fake.Calls.Add("resolve-link")
    if ($fake.ReadLinkBroken) { throw "cannot reach the host to resolve the link" }
    # An override models what the HOST actually resolved -- another directory, a directory rather than
    # a file, or nothing at all -- independently of what this run did.
    $actual = if ($null -ne $fake.ResolveActualOverride -and $fake.ResolveActualOverride -ne "") {
      $fake.ResolveActualOverride
    } else {
      "$sharedRoot/$($fake.Link)"
    }
    return [pscustomobject]@{ Actual = $actual; Expected = $ExpectedPath; Kind = $fake.ResolveKind }
  }.GetNewClosure())

  $fake | Add-Member -MemberType NoteProperty -Name Run -Value ({
    param([string]$Label, [string]$Command)
    & $fake.Step $Label
  }.GetNewClosure())

  $fake | Add-Member -MemberType NoteProperty -Name Remove -Value ({
    param([string]$Path)
    [void]$fake.Removed.Add($Path)
    if ($fake.Files.ContainsKey($Path)) { $fake.Files.Remove($Path) }
  }.GetNewClosure())

  return $fake
}

function New-TestLifecycle {
  param([string]$Basename = $script:Basename)
  return New-ArtifactLifecycle `
    -LocalArtifact "C:\tmp\nibrs-rollup-refresh\$Basename" `
    -RemoteArtifact "$script:RemoteShared/$Basename" `
    -Basename $Basename `
    -RemoteLink $script:RemoteLink
}

function Invoke-Publication {
  param(
    [string]$FailAt = "",
    [string]$Digest = "digest-ok",
    [switch]$ApplyThenFailActivation,
    [switch]$ActivationNoOpSuccess,
    [switch]$ReadLinkUnavailable,
    [string]$ActiveLink = $script:PriorBasename,
    [string]$ResolveActualReturns = $null,
    [string]$ResolveKindReturns = "file"
  )
  $lifecycle = New-TestLifecycle
  $remote = New-FakeRemote -FailAt $FailAt -Digest $Digest -ActiveLink $ActiveLink `
    -ApplyThenFailActivation:$ApplyThenFailActivation `
    -ActivationNoOpSuccess:$ActivationNoOpSuccess `
    -ReadLinkUnavailable:$ReadLinkUnavailable -ResolveActualReturns $ResolveActualReturns `
    -ResolveKindReturns $ResolveKindReturns
  Set-ArtifactBuilt -Lifecycle $lifecycle
  $thrown = $null
  try {
    Invoke-ArtifactPublication -Lifecycle $lifecycle -Remote $remote -ExpectedDigest "digest-ok" `
      -CandidateFreshnessCommand "check-candidate" -LiveFreshnessCommand "check-live" `
      -ScoreboardCommand "scoreboard"
  } catch {
    $thrown = $_
  }
  return [pscustomobject]@{ Lifecycle = $lifecycle; Remote = $remote; Thrown = $thrown }
}

function Get-RunOwnedRemotePaths {
  return @(
    "$script:RemoteArtifact.tmp",
    "$script:RemoteArtifact.generation.tmp",
    $script:RemoteArtifact,
    "$script:RemoteArtifact.generation",
    "$script:RemoteLink.staging-$script:Basename"
  )
}

function Assert-NextRunNotBlocked {
  param($Result)
  Invoke-RemoteFailureCleanup -Lifecycle $Result.Lifecycle -Remote $Result.Remote | Out-Null
  $blocked = $null
  try {
    & $Result.Remote.TestClear (Get-RunOwnedRemotePaths)
  } catch {
    $blocked = $_.Exception.Message
  }
  Assert-True ($null -eq $blocked) "the next run is blocked by run-owned residue: $blocked"
}

# --------------------------------------------------------------------------------------------------

Write-Host "`n-- the capability probe is a preflight concern, not a publication step --"

Test-Case "the capability check is its own callable step" {
  # It has to run before the 176 GB snapshot copy, which happens long before publication is reached.
  # So it cannot live inside Invoke-ArtifactPublication, and being 'first' in there proves nothing.
  $lifecycle = New-TestLifecycle
  $remote = New-FakeRemote
  Invoke-ActivationCapabilityCheck -Lifecycle $lifecycle -Remote $remote
  Assert-True (@($remote.Calls) -contains "verify-activation-capability") "the capability probe was not run"
  Assert-True (@($lifecycle.Transitions) -contains "verify-activation-capability") "the check is not recorded as a transition"
}

Test-Case "a failing capability check throws and creates nothing remote" {
  $lifecycle = New-TestLifecycle
  $remote = New-FakeRemote -FailAt "verify-activation-capability"
  $threw = $null
  try { Invoke-ActivationCapabilityCheck -Lifecycle $lifecycle -Remote $remote } catch { $threw = $_ }
  Assert-True ($null -ne $threw) "an unavailable atomic swap was accepted"
  Assert-True ($lifecycle.Remote -eq "absent") "remote state moved on a capability failure"
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $lifecycle).RemotePaths @() "a capability failure would delete remote files"
}

Test-Case "publication does not run the capability check itself" {
  # If it reappears in here, it is back to being useless: publication happens after the transfer.
  $result = Invoke-Publication
  Assert-True (@($result.Remote.Calls) -notcontains "verify-activation-capability") `
    "the capability probe is back inside publication, which runs after the 176 GB copy"
}

Write-Host "`n-- the happy path --"

Test-Case "the transitions run in the contracted order" {
  $result = Invoke-Publication
  Assert-SetEqual $result.Remote.Calls @(
    "precondition", "upload-database", "upload-generation", "verify-digest",
    "move-database", "move-generation", "verify-candidate",
    "create-staging-link", "activate-symlink", "resolve-link", "confirm-live", "latency-scoreboard"
  ) "the transition sequence changed"
  $calls = @($result.Remote.Calls)
  Assert-True ($calls.IndexOf("move-generation") -lt $calls.IndexOf("verify-candidate")) `
    "the candidate was verified before both final files were in place"
  Assert-True ($calls.IndexOf("verify-candidate") -lt $calls.IndexOf("activate-symlink")) `
    "the artifact was activated before its candidate freshness was verified"
  Assert-True ($calls.IndexOf("create-staging-link") -lt $calls.IndexOf("activate-symlink")) `
    "the rename ran before its staging link existed"
  Assert-True ($calls.IndexOf("activate-symlink") -lt $calls.IndexOf("resolve-link")) "the link was read before the swap"
}

Test-Case "a clean publication ends verified, active and locally preserved" {
  $result = Invoke-Publication
  Assert-True ($null -eq $result.Thrown) "the clean path threw: $(Format-Thrown $result.Thrown)"
  Assert-True ($result.Lifecycle.Remote -eq "verified") "remote state is $($result.Lifecycle.Remote), expected verified"
  Assert-True ($result.Lifecycle.Local -eq "active") "local state is $($result.Lifecycle.Local), expected active"
  Assert-True ($result.Remote.Link -eq $script:Basename) "the symlink was not switched to this artifact"
  Assert-True ($result.Lifecycle.ActivationState -eq "applied") "activation state is $($result.Lifecycle.ActivationState)"
  Assert-SetEqual (Get-WarningKinds -Lifecycle $result.Lifecycle) @() "a clean run recorded a warning"
}

Test-Case "the atomic rename consumes the staging link on success" {
  $result = Invoke-Publication
  Assert-True (-not $result.Remote.Files.ContainsKey($result.Lifecycle.RemoteStagingLink)) `
    "the staging link survived a successful swap"
}

Test-Case "a completed run reaches retained" {
  $result = Invoke-Publication
  Complete-ArtifactLifecycle -Lifecycle $result.Lifecycle
  Assert-True ($result.Lifecycle.Local -eq "retained") "a completed run did not reach retained"
}

Write-Host "`n-- round 2 finding 2: the link is read back after EVERY activation attempt --"

Test-Case "an activation that returns success without changing the link fails publication" {
  # The gap read-back closes: a zero exit is not evidence that anything was selected.
  $result = Invoke-Publication -ActivationNoOpSuccess
  Assert-True ($null -ne $result.Thrown) "a no-op activation was accepted as a commit"
  Assert-True ($result.Remote.Link -eq $script:PriorBasename) "the fake changed the link after all"
  Assert-True ($result.Lifecycle.ActivationState -eq "reconciled-prior-active") `
    "activation state is $($result.Lifecycle.ActivationState), expected reconciled-prior-active"
  Assert-True ($result.Lifecycle.Local -ne "active") "a run that never went live was marked active"
}

Test-Case "the error names what the link actually points at" {
  $result = Invoke-Publication -ActivationNoOpSuccess
  Assert-True ((Format-Thrown $result.Thrown) -like "*$script:PriorBasename*") `
    "the failure does not say what is live: $(Format-Thrown $result.Thrown)"
}

Test-Case "a -Force run whose previous artifact shares the generation still fails on read-back" {
  # The case the review named: with the same generation, confirm-live would pass against the OLD
  # artifact and everything downstream would look healthy. Only the exact basename catches it.
  $result = Invoke-Publication -ActivationNoOpSuccess -ActiveLink $script:PriorBasename
  Assert-True ($null -ne $result.Thrown) "a same-generation predecessor masked a failed selection"
  Assert-True (@($result.Remote.Calls) -notcontains "confirm-live") `
    "the live check ran and could have passed against the previous artifact"
  Assert-True (-not (Test-PublicationCommitted -Lifecycle $result.Lifecycle)) "an uncommitted run reported a commit"
}

Test-Case "read-back happens even when activation returns success" {
  $result = Invoke-Publication
  Assert-True (@($result.Remote.Calls) -contains "resolve-link") "a successful activation was trusted without read-back"
}

Test-Case "only an exact read-back establishes the commit" {
  foreach ($case in @(
      @{ Name = "clean";     Result = (Invoke-Publication);                       Committed = $true },
      @{ Name = "no-op";     Result = (Invoke-Publication -ActivationNoOpSuccess); Committed = $false },
      @{ Name = "unknown";   Result = (Invoke-Publication -ReadLinkUnavailable);   Committed = $false })) {
    $actual = Test-PublicationCommitted -Lifecycle $case.Result.Lifecycle
    Assert-True ($actual -eq $case.Committed) "$($case.Name): commit reported as $actual"
  }
}

Write-Host "`n-- round 2 decision 2: observed reality outranks a lost acknowledgement --"

Test-Case "an applied swap that reported failure is a successful publication" {
  $result = Invoke-Publication -ApplyThenFailActivation
  Assert-True ($null -eq $result.Thrown) "a proven-live artifact still failed the run: $(Format-Thrown $result.Thrown)"
  Assert-True ($result.Lifecycle.ActivationState -eq "reconciled-active") `
    "activation state is $($result.Lifecycle.ActivationState), expected reconciled-active"
  Assert-True ($result.Lifecycle.Local -eq "active") "local state is $($result.Lifecycle.Local)"
  Assert-True (Test-PublicationCommitted -Lifecycle $result.Lifecycle) "a reconciled-active run does not count as committed"
}

Test-Case "the lost transport error is retained as a warning" {
  $result = Invoke-Publication -ApplyThenFailActivation
  Assert-True ((Get-WarningKinds -Lifecycle $result.Lifecycle) -contains "activation-transport") `
    "the transport error was discarded: $((Get-WarningKinds -Lifecycle $result.Lifecycle) -join ', ')"
  $warning = @($result.Lifecycle.PostCommitWarnings) | Where-Object { $_.Kind -eq "activation-transport" }
  Assert-True ($warning.Message -like "*connection closed*") "the warning lost the original error text"
}

Test-Case "a reconciled-active run still runs the live check and can complete" {
  $result = Invoke-Publication -ApplyThenFailActivation
  Assert-True (@($result.Remote.Calls) -contains "confirm-live") "the live check was skipped after reconciliation"
  Assert-True (@($result.Remote.Calls) -contains "latency-scoreboard") "the scoreboard was skipped after reconciliation"
  Complete-ArtifactLifecycle -Lifecycle $result.Lifecycle
  Assert-True ($result.Lifecycle.Local -eq "retained") "a reconciled-active run could not complete"
}

Test-Case "reconciled-prior-active and activation-unknown remain failures" {
  foreach ($result in @((Invoke-Publication -ActivationNoOpSuccess), (Invoke-Publication -ReadLinkUnavailable))) {
    Assert-True ($null -ne $result.Thrown) "$($result.Lifecycle.ActivationState) was treated as success"
    Assert-True (-not (Test-PublicationCommitted -Lifecycle $result.Lifecycle)) `
      "$($result.Lifecycle.ActivationState) reported a commit"
  }
}

Write-Host "`n-- uncertainty deletes no artifact --"

Test-Case "an unreadable link is activation-unknown and demands a human" {
  $result = Invoke-Publication -ReadLinkUnavailable
  Assert-True ($result.Lifecycle.Remote -eq "activation-unknown") "remote state is $($result.Lifecycle.Remote)"
  Assert-True ($result.Lifecycle.Local -eq "activation-unknown") "local state is $($result.Lifecycle.Local)"
  $plan = Get-FailureCleanupPlan -Lifecycle $result.Lifecycle
  Assert-True (-not $plan.LocalDisposable) "the local artifact was deleted while the link state was unknown"
  Assert-True $plan.RequiresHumanReconciliation "an unknown link state did not demand human reconciliation"
}

Test-Case "an unknown outcome removes the staging link and nothing else" {
  # The staging link is provably never the path production reads, so removing that exact path cannot
  # affect what is being served -- and leaving it behind is residue.
  $result = Invoke-Publication -ReadLinkUnavailable
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).RemotePaths `
    @($result.Lifecycle.RemoteStagingLink) "an unknown outcome scheduled the wrong paths"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-SetEqual @($result.Remote.Removed) @($result.Lifecycle.RemoteStagingLink) "cleanup touched more than the staging link"
  Assert-True ($result.Remote.Files.ContainsKey($script:RemoteArtifact)) "a possibly-live database was deleted"
  Assert-True ($result.Remote.Files.ContainsKey("$script:RemoteArtifact.generation")) "a possibly-live generation file was deleted"
}

Test-Case "an unknown outcome after an applied swap also keeps the artifact" {
  $result = Invoke-Publication -ApplyThenFailActivation -ReadLinkUnavailable
  Assert-True ($result.Lifecycle.Remote -eq "activation-unknown") "remote state is $($result.Lifecycle.Remote)"
  Assert-True ($result.Remote.Files.ContainsKey($script:RemoteArtifact)) "the artifact was deleted under uncertainty"
}

Write-Host "`n-- round 2 finding 3: the staging link is per-run and owned --"

Test-Case "the staging link is derived from the unique artifact basename" {
  $lifecycle = New-TestLifecycle
  Assert-True ($lifecycle.RemoteStagingLink -eq "$script:RemoteLink.staging-$script:Basename") `
    "the staging link is $($lifecycle.RemoteStagingLink)"
  Assert-True ($lifecycle.RemoteStagingLink -ne "$script:RemoteLink.staging") "the staging link is still a shared fixed path"
}

Test-Case "two runs cannot collide on a staging link" {
  $a = New-TestLifecycle -Basename "nibrs_rollups-20260822_080002.db"
  $b = New-TestLifecycle -Basename "nibrs_rollups-20260823_080002.db"
  Assert-True ($a.RemoteStagingLink -ne $b.RemoteStagingLink) "two runs share one staging link path"
  Assert-True ((Get-FailureCleanupPlan -Lifecycle $a).RemotePaths -notcontains $b.RemoteStagingLink) `
    "one run's cleanup would remove another run's staging link"
}

Test-Case "the staging link is part of the precondition" {
  $result = Invoke-Publication
  # Proven by the next run's precondition being satisfied only when the staging path is also clear:
  # the plan and the precondition are built from the same list.
  Assert-True ((Get-RunOwnedRemotePaths) -contains $result.Lifecycle.RemoteStagingLink) `
    "the staging link is not in the run-owned set"
}

Test-Case "a failure after the staging link is created removes it" {
  $result = Invoke-Publication -FailAt "activate-symlink"
  Assert-True ($result.Remote.Files.ContainsKey($result.Lifecycle.RemoteStagingLink)) `
    "the fake did not leave a staging link to clean"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-True (-not $result.Remote.Files.ContainsKey($result.Lifecycle.RemoteStagingLink)) `
    "the staging link survived cleanup"
}

Test-Case "a failure while creating the staging link is cleaned too" {
  $result = Invoke-Publication -FailAt "create-staging-link"
  Assert-True ($null -ne $result.Thrown) "the injected failure did not surface"
  Assert-True ($result.Remote.Link -eq $script:PriorBasename) "the link moved despite failing before the rename"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-SetEqual @($result.Remote.Files.Keys) @() "residue survived a staging-link failure"
}

Write-Host "`n-- round 2 decision 1: the live check is not the scoreboard --"

Test-Case "a scoreboard failure is telemetry" {
  $result = Invoke-Publication -FailAt "latency-scoreboard"
  Assert-True ($null -eq $result.Thrown) "a scoreboard failure failed the publication: $(Format-Thrown $result.Thrown)"
  Assert-SetEqual (Get-WarningKinds -Lifecycle $result.Lifecycle) @("telemetry") "the scoreboard warning is miscategorised"
  Assert-True (Test-PublicationCommitted -Lifecycle $result.Lifecycle) "a scoreboard failure undid the commit"
}

Test-Case "a live-check failure is recorded as a live-path warning, not telemetry" {
  # Both are post-commit, but they mean different things: one says the artifact is not visible through
  # the production path, the other says a log did not get written.
  $result = Invoke-Publication -FailAt "confirm-live"
  Assert-True ($null -eq $result.Thrown) "the live check failed the publication after a proven commit"
  Assert-True ((Get-WarningKinds -Lifecycle $result.Lifecycle) -contains "live-path-verification") `
    "the live-check warning is not distinguished: $((Get-WarningKinds -Lifecycle $result.Lifecycle) -join ', ')"
  Assert-True ((Get-WarningKinds -Lifecycle $result.Lifecycle) -notcontains "telemetry") `
    "the live check was recorded as mere telemetry"
  Assert-True ($result.Lifecycle.Remote -eq "active") "remote state is $($result.Lifecycle.Remote), expected active"
}

Test-Case "the live check is only downgraded once the commit is proven" {
  # It is a warning solely because read-back already proved the link names this run and the candidate
  # already passed freshness. Where either is untrue, the run fails before reaching it.
  foreach ($result in @((Invoke-Publication -ActivationNoOpSuccess), (Invoke-Publication -FailAt "verify-candidate"))) {
    Assert-True (@($result.Remote.Calls) -notcontains "confirm-live") `
      "the live check ran without a proven commit ($($result.Lifecycle.ActivationState))"
  }
}

Test-Case "both post-commit steps can warn at once and the run still stands" {
  $result = Invoke-Publication -ApplyThenFailActivation
  Assert-True ((Get-WarningKinds -Lifecycle $result.Lifecycle) -contains "activation-transport") "no transport warning"
  Assert-True (Test-PublicationCommitted -Lifecycle $result.Lifecycle) "the run does not count as committed"
}

Write-Host "`n-- before activation: the local artifact is disposable --"

foreach ($case in @(
    @{ At = "precondition";        State = "absent" },
    @{ At = "upload-database";     State = "staged-database" },
    @{ At = "upload-generation";   State = "staged-both" },
    @{ At = "verify-digest";       State = "staged-both" },
    @{ At = "move-database";       State = "final-database-only" },
    @{ At = "move-generation";     State = "final-both" },
    @{ At = "verify-candidate";    State = "final-both" },
    @{ At = "create-staging-link"; State = "candidate-verified" },
    @{ At = "activate-symlink";    State = "candidate-verified" })) {
  Test-Case "a failure at $($case.At) leaves the local artifact disposable" {
    $result = Invoke-Publication -FailAt $case.At
    Assert-True ($null -ne $result.Thrown) "the injected failure at $($case.At) did not surface"
    Assert-True ($result.Lifecycle.Remote -eq $case.State) `
      "remote state after failing at $($case.At) is $($result.Lifecycle.Remote), expected $($case.State)"
    Assert-True (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).LocalDisposable `
      "the local artifact was preserved before activation, so it will never be cleaned up"
  }.GetNewClosure()
}

Write-Host "`n-- exact cleanup responsibility --"

Test-Case "a precondition failure removes nothing remote" {
  $result = Invoke-Publication -FailAt "precondition"
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).RemotePaths @() `
    "a precondition failure would delete remote files it does not own"
}

Test-Case "a failure during the first upload removes the partial temporary file" {
  $result = Invoke-Publication -FailAt "upload-database"
  Assert-True ($result.Remote.Files.ContainsKey("$script:RemoteArtifact.tmp")) "the fake did not leave a partial .tmp"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-True (-not $result.Remote.Files.ContainsKey("$script:RemoteArtifact.tmp")) "the partial .tmp survived cleanup"
}

Test-Case "a failure after both uploads removes both temporary files" {
  $result = Invoke-Publication -FailAt "verify-digest"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-SetEqual @($result.Remote.Files.Keys) @() "a temporary file survived cleanup"
}

Test-Case "a digest mismatch is a failure, not an activation" {
  $result = Invoke-Publication -Digest "digest-wrong"
  Assert-True ($null -ne $result.Thrown) "a remote digest mismatch was accepted"
  Assert-True ($result.Remote.Link -ne $script:Basename) "a mismatching artifact was activated"
  Assert-True (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).LocalDisposable "the mismatching artifact was preserved"
}

Test-Case "a failure after moving only the database removes the final database and the staged generation" {
  $result = Invoke-Publication -FailAt "move-generation"
  Assert-True ($result.Remote.Files.ContainsKey($script:RemoteArtifact)) "the fake did not move the database"
  Assert-True ($result.Remote.Files.ContainsKey("$script:RemoteArtifact.generation.tmp")) "the staged generation is missing"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-SetEqual @($result.Remote.Files.Keys) @() "a non-active final or staged file survived cleanup"
}

Test-Case "a rejected candidate is removed by exact-path cleanup" {
  $result = Invoke-Publication -FailAt "verify-candidate"
  Assert-True ($result.Remote.Link -eq $script:PriorBasename) "a failing candidate was activated"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-SetEqual @($result.Remote.Files.Keys) @() "the rejected candidate stayed on the production volume"
}

Test-Case "cleanup only ever names the five paths this run owns" {
  $result = Invoke-Publication -FailAt "activate-symlink"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  foreach ($path in @($result.Remote.Removed)) {
    Assert-True ((Get-RunOwnedRemotePaths) -contains $path) "cleanup named a path this run does not own: $path"
  }
  Assert-True (@($result.Remote.Removed) -notcontains $script:RemoteLink) "cleanup named the production symlink"
}

Test-Case "a remote removal that fails does not throw" {
  $result = Invoke-Publication -FailAt "move-generation"
  $result.Remote.PSObject.Properties.Remove("Remove")
  $result.Remote | Add-Member -MemberType NoteProperty -Name Remove -Value ({ param([string]$Path) throw "ssh unreachable" })
  $threw = $null
  try { Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null } catch { $threw = $_ }
  Assert-True ($null -eq $threw) "a failing remote removal threw and would have masked the original error"
}

Test-Case "a reconciliation that throws does not become the reported failure" {
  $result = Invoke-Publication -FailAt "activate-symlink" -ReadLinkUnavailable
  Assert-True ((Format-Thrown $result.Thrown) -like "*injected failure at activate-symlink*") `
    "the reconciliation error replaced the activation error: $(Format-Thrown $result.Thrown)"
}

Test-Case "cleanup after a failure is idempotent" {
  $result = Invoke-Publication -FailAt "move-generation"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  Assert-SetEqual @($result.Remote.Files.Keys) @() "a second cleanup pass resurrected a file"
}

Write-Host "`n-- no pre-activation failure blocks the next run --"

foreach ($case in @(
    "upload-database", "upload-generation", "verify-digest", "move-database",
    "move-generation", "verify-candidate", "create-staging-link", "activate-symlink")) {
  Test-Case "after cleaning up a failure at $case the next run's precondition passes" {
    $result = Invoke-Publication -FailAt $case
    Assert-NextRunNotBlocked -Result $result
  }.GetNewClosure()
}

Write-Host "`n-- the states are the ones the contract names --"

Test-Case "every contracted state is reachable" {
  $reached = @{}
  foreach ($at in @("", "upload-database", "move-database", "move-generation", "activate-symlink", "confirm-live")) {
    $result = Invoke-Publication -FailAt $at
    $reached[$result.Lifecycle.Remote] = $true
    $reached[$result.Lifecycle.Local] = $true
  }
  $reached[(Invoke-Publication -ReadLinkUnavailable).Lifecycle.Remote] = $true
  $completed = Invoke-Publication
  Complete-ArtifactLifecycle -Lifecycle $completed.Lifecycle
  $reached[$completed.Lifecycle.Local] = $true
  foreach ($state in @("staged-database", "final-database-only", "final-both", "candidate-verified",
                       "active", "verified", "activation-unknown", "built", "retained")) {
    Assert-True $reached.ContainsKey($state) "the contract names a state the lifecycle never reaches: $state"
  }
}

Test-Case "a lifecycle starts building and becomes built" {
  $lifecycle = New-TestLifecycle
  Assert-True ($lifecycle.Local -eq "building") "a new lifecycle is not building"
  Assert-True ($lifecycle.Remote -eq "absent") "a new lifecycle has remote state $($lifecycle.Remote)"
  Set-ArtifactBuilt -Lifecycle $lifecycle
  Assert-True ($lifecycle.Local -eq "built") "a built artifact is not in state built"
}

Test-Case "a failure while still building leaves the artifact disposable" {
  $lifecycle = New-TestLifecycle
  $plan = Get-FailureCleanupPlan -Lifecycle $lifecycle
  Assert-True $plan.LocalDisposable "a half-built artifact was treated as production's"
  Assert-SetEqual $plan.RemotePaths @() "a build failure would delete remote files"
}

Write-Host "`n-- the shipped script wires it in the right places --"

Test-Case "the shipped script publishes through the lifecycle rather than reimplementing it" {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains("nibrs-refresh-lifecycle.ps1")) "the shipped script does not load the lifecycle module"
  Assert-True ($source.Contains("Invoke-ArtifactPublication")) "the shipped script does not publish through the lifecycle"
  Assert-True ($source.Contains("Get-FailureCleanupPlan")) "the failure path does not consult the cleanup plan"
  Assert-True ($source.Contains("Invoke-RemoteFailureCleanup")) "the failure path never cleans up remote files"
  Assert-True ($source.Contains("ResolveLinkTarget")) "the production remote cannot reconcile the link target"
  Assert-True ($source.Contains("readlink -f")) "the production remote does not canonicalise the link target"
  Assert-True ($source.Contains("VerifyAtomicSwap")) "the production remote cannot prove its atomic swap"
}

Test-Case "the capability probe really runs before the snapshot transfer" {
  # The round 2 finding: a unit test proving the probe is 'first inside publication' says nothing,
  # because publication happens after the 176 GB copy. This compares the actual invocations.
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  $probeAt = $source.IndexOf('Invoke-ActivationCapabilityCheck')
  $noOpAt = $source.IndexOf('$before.ActiveGeneration -eq $before.Generation')
  $spaceAt = $source.IndexOf('if ($drive.Free -lt $required)')
  # Anchored on the snapshot scp itself rather than on the argument it happens to be given. The
  # argument changed once already -- the copy now names `$before.SourceCanonical`, the RESOLVED
  # source, so that the object whose journal state was cleared is the object whose bytes arrive --
  # and a placement test that breaks when the payload is corrected is testing the wrong thing.
  # The copy now happens inside the protected snapshot phase, so the anchor is the call that starts
  # that phase. The property is unchanged and still the point: prove the host can swap a symlink BEFORE
  # spending hours and 166 GiB finding out it cannot.
  $copyAt = $source.IndexOf('Invoke-ProtectedSourceSnapshot')
  Assert-True ($probeAt -ge 0) "the shipped script never runs the capability probe"
  Assert-True ($noOpAt -ge 0) "the no-op check is gone; this placement test is stale"
  Assert-True ($spaceAt -ge 0) "the free-space check is gone; this placement test is stale"
  Assert-True ($copyAt -ge 0) "the snapshot copy is gone; this placement test is stale"
  Assert-True ($source.Contains('-Discovered $before')) `
    "the snapshot phase is not given the discovered state, so the copy cannot be bound to what was inspected"
  Assert-True ($noOpAt -lt $probeAt) "the probe runs before the no-op check, so idle runs pay for it"
  Assert-True ($probeAt -lt $spaceAt) "the probe runs after the free-space check"
  Assert-True ($probeAt -lt $copyAt) "the probe runs after the 176 GB snapshot copy -- the whole point is that it does not"
}

Test-Case "the shipped activation uses a per-run staging path" {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains('$StagingLink')) "the activation seam takes no staging path"
  Assert-True (-not $source.Contains("'$" + "Link.staging'")) "the shipped script still uses a shared fixed staging path"
}

Write-Host "`n-- round 3 blocker 2: identity is the canonical path, not the leaf name --"

Test-Case "a relative link target that resolves to our artifact passes" {
  # `ln -sfn '<basename>'` stores a bare name; the host resolves both sides with one resolver.
  $result = Invoke-Publication
  Assert-True ($null -eq $result.Thrown) "a resolved relative target was rejected: $(Format-Thrown $result.Thrown)"
  Assert-True (Test-PublicationCommitted -Lifecycle $result.Lifecycle) "a resolved relative target did not commit"
}

Test-Case "an absolute link target resolving to our artifact passes" {
  $result = Invoke-Publication -ResolveActualReturns "$script:RemoteShared/$script:Basename"
  Assert-True (Test-PublicationCommitted -Lifecycle $result.Lifecycle) "an absolute target did not commit"
}

Test-Case "the same basename in a different directory is NOT our artifact" {
  # The defect this closes: a leaf-name comparison accepted /some/other/path/<our-basename> as the
  # published database.
  $result = Invoke-Publication -ResolveActualReturns "/opt/nibrs/other/$script:Basename"
  Assert-True ($null -ne $result.Thrown) "a same-named file in another directory was accepted as our commit"
  Assert-True ($result.Lifecycle.ActivationState -eq "reconciled-prior-active") `
    "activation state is $($result.Lifecycle.ActivationState)"
  Assert-True (-not (Test-PublicationCommitted -Lifecycle $result.Lifecycle)) "it counted as committed"
}

Test-Case "a directory sharing the leaf name does not pass" {
  # A trailing-slash target used to be accepted. A directory is not the published database.
  $result = Invoke-Publication -ResolveActualReturns "$script:RemoteShared/$script:Basename" -ResolveKindReturns "other"
  Assert-True ($null -ne $result.Thrown) "a directory was accepted as the published database"
  Assert-True ((Format-Thrown $result.Thrown) -like "*kind=other*") `
    "the failure does not say what was found: $(Format-Thrown $result.Thrown)"
}

Test-Case "an unresolvable target is unknown, not a mismatch" {
  # Not evidence that another artifact is live, so it must not authorise deleting this run's files.
  $result = Invoke-Publication -ResolveActualReturns "   "
  Assert-True ($result.Lifecycle.Remote -eq "activation-unknown") "remote state is $($result.Lifecycle.Remote)"
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).RemotePaths `
    @($result.Lifecycle.RemoteStagingLink) "an unresolvable target authorised deleting artifacts"
}

Test-Case "a dangling link is unknown, not a mismatch" {
  # Resolves to a path that is not there. Treating that as "another artifact is live" would let it
  # authorise deleting this run's files on no evidence at all.
  $result = Invoke-Publication -ResolveActualReturns "/opt/nibrs/shared/vanished.db" -ResolveKindReturns "missing"
  Assert-True ($result.Lifecycle.Remote -eq "activation-unknown") "remote state is $($result.Lifecycle.Remote)"
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).RemotePaths `
    @($result.Lifecycle.RemoteStagingLink) "a dangling link authorised deleting artifacts"
}

Test-Case "a resolver that cannot be reached is unknown" {
  $result = Invoke-Publication -ReadLinkUnavailable
  Assert-True ($result.Lifecycle.Remote -eq "activation-unknown") "remote state is $($result.Lifecycle.Remote)"
  Assert-True (-not (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).LocalDisposable) `
    "the local artifact was deleted while the outcome was unknown"
}

Test-Case "both sides are canonicalised by the host, not locally" {
  # If the expected path were canonicalised here, any symlinked parent directory on the host would
  # produce a false mismatch -- and a false mismatch deletes the live database.
  $lifecycle = New-TestLifecycle
  $remote = New-FakeRemote
  $resolution = & $remote.ResolveLinkTarget $lifecycle.RemoteLink $lifecycle.RemoteArtifact
  Assert-True ($resolution.Expected -eq $lifecycle.RemoteArtifact) "the expected path was not sent to the host for resolution"
  Assert-True ($null -ne $resolution.Kind) "the resolver does not report what kind of target it found"
}

Write-Host "`n-- self-review: a concurrent actor between the swap and the read-back --"

Test-Case "an external writer stealing the link after our swap is not our commit" {
  # Our swap really happened, but by read-back time production is serving someone else's artifact.
  # Ours is inactive residue and removing it is correct.
  $result = Invoke-Publication -ResolveActualReturns "$script:RemoteShared/nibrs_rollups-20260824_030000.db"
  Assert-True ($null -ne $result.Thrown) "a stolen link was reported as our commit"
  Assert-True (-not (Test-PublicationCommitted -Lifecycle $result.Lifecycle)) "a stolen link counted as committed"
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $result.Lifecycle).RemotePaths `
    (Get-RunOwnedRemotePaths) "our now-inactive files were left on the production volume"
  Invoke-RemoteFailureCleanup -Lifecycle $result.Lifecycle -Remote $result.Remote | Out-Null
  foreach ($path in @($result.Remote.Removed)) {
    Assert-True ((Get-RunOwnedRemotePaths) -contains $path) "cleanup reached outside this run: $path"
  }
}

Write-Host "`n-- round 3 blocker 3: run identity is unique, not second-resolution --"

Test-Case "two runs in the same second own disjoint remote paths" {
  # `yyyyMMdd_HHmmss` is unique only to one second, and the local workspace lock does not serialize a
  # second checkout, workspace or machine.
  $stamp = "20260822_080002"
  $a = New-TestLifecycle -Basename (New-RunArtifactBasename -Stamp $stamp)
  $b = New-TestLifecycle -Basename (New-RunArtifactBasename -Stamp $stamp)
  Assert-True ($a.Basename -ne $b.Basename) "two runs in the same second produced the same basename"
  $pathsA = @(Get-RunOwnedRemotePath -Lifecycle $a)
  $pathsB = @(Get-RunOwnedRemotePath -Lifecycle $b)
  Assert-True ($pathsA.Count -eq 5) "expected five owned paths, got $($pathsA.Count)"
  foreach ($path in $pathsA) {
    Assert-True ($pathsB -notcontains $path) "the two runs share an owned path: $path"
  }
}

Test-Case "cleanup for one run names none of a same-second run's paths" {
  $stamp = "20260822_080002"
  $a = New-TestLifecycle -Basename (New-RunArtifactBasename -Stamp $stamp)
  $b = New-TestLifecycle -Basename (New-RunArtifactBasename -Stamp $stamp)
  Set-ArtifactBuilt -Lifecycle $a
  $a.Remote = "final-both"
  $planA = Get-FailureCleanupPlan -Lifecycle $a
  foreach ($path in @(Get-RunOwnedRemotePath -Lifecycle $b)) {
    Assert-True ($planA.RemotePaths -notcontains $path) "one run's cleanup would remove another's $path"
  }
}

Test-Case "the nonce survives in the staging link too" {
  $stamp = "20260822_080002"
  $a = New-TestLifecycle -Basename (New-RunArtifactBasename -Stamp $stamp)
  $b = New-TestLifecycle -Basename (New-RunArtifactBasename -Stamp $stamp)
  Assert-True ($a.RemoteStagingLink -ne $b.RemoteStagingLink) "two same-second runs share a staging link"
}

Test-Case "the generated basename still matches the retention glob" {
  # Local retention sweeps `nibrs_rollups-*.db`; a nonce must not fall outside it.
  $name = New-RunArtifactBasename -Stamp "20260822_080002"
  Assert-True ($name -like "nibrs_rollups-*.db") "the generated name is outside the retention glob: $name"
  Assert-True ($name -like "*20260822_080002*") "the generated name lost its stamp: $name"
  # A truncated nonce would still pass the disjointness tests at this volume; the width is asserted
  # here so it cannot quietly shrink.
  $nonce = $name.Replace("nibrs_rollups-20260822_080002-", "").Replace(".db", "")
  Assert-True ($nonce.Length -eq 32) "the nonce is $($nonce.Length) hex characters, expected a full GUID"
  Assert-True ($nonce -match "^[0-9a-f]{32}$") "the nonce is not lowercase hex: $nonce"
}

Test-Case "the shipped script derives its artifact name from the nonce helper" {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains("New-RunArtifactBasename")) "the shipped script still builds its own second-resolution name"
  Assert-True ($source.Contains("ResolveLinkTarget")) "the production remote cannot resolve the link canonically"
}

Write-Host "`n-- self-review: retry and idempotency of the transaction itself --"

Test-Case "a committed lifecycle refuses to publish again" {
  $result = Invoke-Publication
  $threw = $null
  try {
    Invoke-ArtifactPublication -Lifecycle $result.Lifecycle -Remote $result.Remote -ExpectedDigest "digest-ok" `
      -CandidateFreshnessCommand "check-candidate" -LiveFreshnessCommand "check-live" -ScoreboardCommand "scoreboard"
  } catch { $threw = $_ }
  Assert-True ($null -ne $threw) "an already-published artifact was published a second time"
  Assert-True ((Format-Thrown $threw) -like "*not 'built'*") "the refusal does not name the state: $(Format-Thrown $threw)"
}

Test-Case "a retained lifecycle refuses to publish again" {
  $result = Invoke-Publication
  Complete-ArtifactLifecycle -Lifecycle $result.Lifecycle
  $threw = $null
  try {
    Invoke-ArtifactPublication -Lifecycle $result.Lifecycle -Remote $result.Remote -ExpectedDigest "digest-ok" `
      -CandidateFreshnessCommand "check-candidate" -LiveFreshnessCommand "check-live" -ScoreboardCommand "scoreboard"
  } catch { $threw = $_ }
  # Must name the STATE. Without this the test passes on the precondition tripping over this run's own
  # final files -- the right outcome for the wrong reason, and it would survive deleting the guard.
  Assert-True ($null -ne $threw) "a retained artifact was republished"
  Assert-True ((Format-Thrown $threw) -like "*not 'built'*") `
    "the refusal came from somewhere other than the state guard: $(Format-Thrown $threw)"
}

Test-Case "the capability check can be run twice without side effects" {
  $lifecycle = New-TestLifecycle
  $remote = New-FakeRemote
  Invoke-ActivationCapabilityCheck -Lifecycle $lifecycle -Remote $remote
  Invoke-ActivationCapabilityCheck -Lifecycle $lifecycle -Remote $remote
  Assert-True ($lifecycle.Remote -eq "absent") "the capability check moved the remote state"
  Assert-SetEqual (Get-FailureCleanupPlan -Lifecycle $lifecycle).RemotePaths @() "the capability check claimed remote paths"
}

Write-Host "`n-- self-review: the caller's own records cannot contradict each other --"

Test-Case "the shipped script gates its activation record on whether success was recorded" {
  # Without this, a housekeeping failure AFTER last-success.json would also write last-activation.json
  # saying the run did not complete: two records disagreeing about one run.
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  Assert-True ($source.Contains('$successRecorded = $true')) "nothing records that last-success.json was written"
  Assert-True ($source.Contains('$plan.Committed')) "the activation record does not consult the commit state"
  Assert-True ($source.Contains('elseif ($successRecorded)')) "the activation record cannot tell the two cases apart"
}

Test-Case "the freshness commands rely on the shared boundary, not per-command redirects" {
  # The stderr property is owned by `Invoke-StreamingCommand` and asserted in the logging suite. A
  # per-command `2>&1` here would be a second, partial mechanism for the same guarantee -- it covered
  # two call sites and left four, which is how it was wrong the first time.
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "refresh-nibrs-rollups.ps1") -Raw
  foreach ($name in @('$candidateFreshness', '$liveFreshness')) {
    $at = $source.IndexOf("$name = ")
    Assert-True ($at -ge 0) "$name is gone; this guard is stale"
    $line = $source.Substring($at, [Math]::Min(400, $source.Length - $at)).Split("`n")[0]
    Assert-True (-not $line.Contains("2>&1")) "$name still carries a per-command redirect: $line"
  }
}

Test-Case "the staging link and the live link are never the same path" {
  # If they were, cleanup for an unknown outcome would remove the production symlink.
  $lifecycle = New-TestLifecycle
  Assert-True ($lifecycle.RemoteStagingLink -ne $lifecycle.RemoteLink) "the staging link IS the production link"
  Assert-True ((Get-RunOwnedRemotePath -Lifecycle $lifecycle) -notcontains $lifecycle.RemoteLink) `
    "the production symlink is in the run-owned set"
}

Write-Host "`nNIBRS refresh lifecycle: $script:Passed passed, $script:Failed failed"
if ($script:Failed -gt 0) { exit 1 }
