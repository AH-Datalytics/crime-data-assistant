# Artifact publication transaction for the NIBRS rollup refresh: explicit ownership, local and remote.
#
# WHY THIS EXISTS. Two defects in a row in this component -- the 2026-08-20 partial-snapshot leak and
# the 2026-08-22 log-handle collision -- fired the baseline's protocol row 3 (stop the increment,
# reassess the component's design). Both had the same cause: ownership was never modelled. The script
# carried one boolean, `$completed`, and inferred everything else from where in a 200-line try block a
# failure happened, so "what does this failure own?" had no answer you could test.
#
# Ownership is therefore data. A lifecycle object records what exists locally and remotely, every
# transition advances it, and cleanup is a PURE FUNCTION of the recorded state.
#
# THE INVARIANT: ONLY AN EXACT READ-BACK ESTABLISHES THE COMMIT.
#
# A returned exit code is not evidence about an external side effect. ssh can move the symlink and then
# lose the connection (the caller sees failure while production serves the new artifact), and it can
# return success having selected nothing at all (a malformed command, an external writer, a future seam
# regression). So the link is read back after EVERY activation attempt and must name this exact run:
#
#   read-back names this run      -> committed. If the call had also errored, that error is retained as
#                                    a warning: observed reality outranks a lost acknowledgement.
#   read-back names another       -> not committed. Remove this run's exact paths; production is
#                                    serving something else, so ours is inactive residue.
#   read-back impossible          -> `activation-unknown`. Remove NOTHING but the staging link. An
#                                    orphaned file costs disk; deleting the live database costs an
#                                    outage.
#
# WHY THE OTHER SIDE EFFECTS DO NOT NEED READ-BACK. The same ambiguity exists for the two `mv` calls,
# and it is absorbed rather than resolved: entry-time pessimism claims both sides of every move, and
# removal is idempotent, so cleanup is correct whichever side the file landed on. The uploads are
# covered by the digest check on the database and, for the generation sidecar, by the candidate
# freshness check -- a truncated or corrupt sidecar fails `generation-mismatch` before anything is
# activated. `Remove` is idempotent by construction (`rm -f`). Activation is the one side effect whose
# ambiguity cannot be absorbed, because it is the commit.
#
# ORDER MATTERS, AND IT IS THE CALLER'S JOB TOO. The atomic-swap capability probe is NOT in this
# function: publication runs after the 176 GB snapshot copy, so "first inside publication" would be far
# too late to save the transfer. It is exported separately for the caller's preflight, and the shipped
# script's placement is asserted against the actual snapshot-copy call site.
#
# POST-COMMIT. Once read-back proves a verified candidate is live, publication has succeeded. The live
# check and the scoreboard record warnings of DIFFERENT kinds -- one says the artifact is not visible
# through the production path, the other says a log did not get written -- and neither fails the run or
# forces the next one to rebuild 176 GB.
#
# Every remote operation is reached through the $Remote seam, never by calling ssh or scp here, which
# is what makes the failure-injection suite possible.

Set-StrictMode -Version Latest

# Local ownership. Only `building` and `built` are disposable partials.
$script:LocalStates = @("building", "built", "active", "activation-unknown", "retained")

# Remote ownership, in the order the transitions reach them.
$script:RemoteStates = @(
  "absent",              # nothing of this run's is on the remote
  "staged-database",     # <artifact>.tmp may exist, possibly partial
  "staged-both",         # <artifact>.tmp and <artifact>.generation.tmp may exist
  "final-database-only", # the database is at its final path; the generation file is still staged
  "final-both",          # both final files in place, not yet verified as a candidate
  "candidate-verified",  # the candidate passed freshness at its own path; a staging link may exist
  "active",              # read-back proved the symlink names this artifact -- production owns it
  "verified",            # the live path was confirmed after the swap
  "activation-unknown"   # the swap may or may not have applied; no artifact may be deleted
)

# States in which no ARTIFACT may be removed: this run created nothing, or production owns them, or we
# cannot prove it does not.
$script:NoArtifactCleanupStates = @("absent", "active", "verified", "activation-unknown")

# Activation outcomes that mean production is serving this run's artifact.
$script:CommittedActivationStates = @("applied", "reconciled-active")

<#
.SYNOPSIS
A new lifecycle for one run's artifact. Starts local `building`, remote `absent`.

.DESCRIPTION
The staging link is derived from the artifact basename, which is stamp-unique. A single fixed
`<link>.staging` would be shared: two publishers could overwrite each other's, and neither would own
it for cleanup. The local workspace lock is not a remote ownership proof.
#>
function New-ArtifactLifecycle {
  param(
    [Parameter(Mandatory = $true)][string]$LocalArtifact,
    [Parameter(Mandatory = $true)][string]$RemoteArtifact,
    [Parameter(Mandatory = $true)][string]$Basename,
    [Parameter(Mandatory = $true)][string]$RemoteLink
  )
  return [pscustomobject]@{
    LocalArtifact          = $LocalArtifact
    LocalGeneration        = "$LocalArtifact.generation"
    RemoteArtifact         = $RemoteArtifact
    RemoteGeneration       = "$RemoteArtifact.generation"
    RemoteStagedArtifact   = "$RemoteArtifact.tmp"
    RemoteStagedGeneration = "$RemoteArtifact.generation.tmp"
    RemoteStagingLink      = "$RemoteLink.staging-$Basename"
    RemoteLink             = $RemoteLink
    Basename               = $Basename
    Local                  = "building"
    Remote                 = "absent"
    Transitions            = @()
    ActivationState        = "not-attempted"
    ObservedLinkTarget     = $null
    ActivatedAtUtc         = $null
    PostCommitWarnings     = @()
  }
}

function Set-ArtifactBuilt {
  param([Parameter(Mandatory = $true)]$Lifecycle)
  $Lifecycle.Local = "built"
}

function Complete-ArtifactLifecycle {
  param([Parameter(Mandatory = $true)]$Lifecycle)
  $Lifecycle.Local = "retained"
}

<#
.SYNOPSIS
Every remote path this run may have created. The production symlink is never among them.
#>
function Get-RunOwnedRemotePath {
  param([Parameter(Mandatory = $true)]$Lifecycle)
  return @(
    $Lifecycle.RemoteStagedArtifact,
    $Lifecycle.RemoteStagedGeneration,
    $Lifecycle.RemoteArtifact,
    $Lifecycle.RemoteGeneration,
    $Lifecycle.RemoteStagingLink
  )
}

<#
.SYNOPSIS
Did production end up serving this run's artifact?
#>
function Test-PublicationCommitted {
  param([Parameter(Mandatory = $true)]$Lifecycle)
  return ($script:CommittedActivationStates -contains $Lifecycle.ActivationState)
}

<#
.SYNOPSIS
Prove the host can replace a symlink atomically. CALL THIS IN THE RUN PREFLIGHT.

.DESCRIPTION
Deliberately not part of `Invoke-ArtifactPublication`: publication is reached only after the 176 GB
snapshot copy, the build and the benchmark, so checking there would cost the whole transfer before
discovering the commit mechanism is unavailable. The caller must run it after the no-op/source-state
check -- so idle runs do not pay for it -- and before the free-space check and the snapshot copy.
#>
function Invoke-ActivationCapabilityCheck {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)]$Remote
  )
  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "verify-activation-capability" -Action {
    & $Remote.VerifyAtomicSwap
  }.GetNewClosure() | Out-Null
}

<#
.SYNOPSIS
Run one transition: record it, advance the remote state PESSIMISTICALLY on entry, then act.

.DESCRIPTION
`$EntryRemoteState` names what may exist once this operation has been *attempted*, not what exists
once it has succeeded. A transfer killed halfway leaves a partial `.tmp`, and a state recorded only on
success would not know to clean it. Removal is idempotent, so claiming a path that turns out to be
absent costs nothing; failing to claim one leaks a rollup database onto the production volume.

Activation passes no entry state: reconciliation owns that ambiguity, not pessimism.
#>
function Invoke-LifecycleTransition {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$EntryRemoteState,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  if ($EntryRemoteState) { $Lifecycle.Remote = $EntryRemoteState }
  $Lifecycle.Transitions += $Name
  return & $Action
}

function Add-PostCommitWarning {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)][string]$Step,
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $Lifecycle.PostCommitWarnings += [pscustomobject]@{ Step = $Step; Kind = $Kind; Message = $Message }
  Write-Host "[rollup-refresh] WARNING ($Kind) $Step): $Message"
}

<#
.SYNOPSIS
Generate a remote-safe, genuinely unique artifact basename for one run.

.DESCRIPTION
The run stamp is `yyyyMMdd_HHmmss`, which is unique only to the second. Two publishers starting in the
same second -- a second checkout, a second workspace, another machine -- would derive the SAME five
remote paths and the same staging link, and the local workspace lock does not serialize any of those.
A nonce makes the owned path set genuinely disjoint per run, which is what the cleanup and precondition
guarantees actually depend on.
#>
function New-RunArtifactBasename {
  param(
    [Parameter(Mandatory = $true)][string]$Stamp,
    [string]$Nonce
  )
  if ([string]::IsNullOrWhiteSpace($Nonce)) {
    # The FULL GUID, not a truncation. There is no path-length pressure here, so trimming it would
    # trade collision resistance for nothing. Still probabilistically unique rather than guaranteed --
    # the guarantee this buys is that two runs starting in the same second do not share a path set.
    $Nonce = [Guid]::NewGuid().ToString("N")
  }
  return "nibrs_rollups-$Stamp-$Nonce.db"
}

<#
.SYNOPSIS
Read the live link back and set the lifecycle from what is OBSERVED, not from what was returned.

.DESCRIPTION
Runs after every activation attempt, success or failure. `$ActivationError` is whatever `Activate`
threw, or $null when it returned success -- either way the link decides.
#>
function Resolve-ActivationOutcome {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)]$Remote,
    $ActivationError
  )
  # Both sides are canonicalised BY THE HOST, in one call, with the same resolver. Comparing basenames
  # would accept `/some/other/dir/<our-basename>`, and canonicalising our expected path locally would
  # break the moment any parent directory is itself a symlink.
  $resolution = $null
  $readable = $true
  try {
    $resolution = & $Remote.ResolveLinkTarget $Lifecycle.RemoteLink $Lifecycle.RemoteArtifact
  } catch {
    $readable = $false
    Write-Host "[rollup-refresh] Could not resolve the active link to reconcile activation: $($_.Exception.Message)"
  }

  $observed = ""
  $expected = ""
  $kind = ""
  if ($readable -and $null -ne $resolution) {
    $observed = "$($resolution.Actual)".Trim()
    $expected = "$($resolution.Expected)".Trim()
    $kind = "$($resolution.Kind)".Trim()
  }

  # `missing` means the link resolves to a path that is not there -- a dangling link. That is an
  # unresolvable target, not evidence that another artifact is live, so it must not authorise
  # deleting this run's files.
  if (-not $readable -or [string]::IsNullOrWhiteSpace($observed) -or [string]::IsNullOrWhiteSpace($expected) -or $kind -eq "missing") {
    $Lifecycle.Remote = "activation-unknown"
    $Lifecycle.Local = "activation-unknown"
    $Lifecycle.ActivationState = "unknown"
    Write-Host "[rollup-refresh] ACTIVATION STATE UNKNOWN for $($Lifecycle.Basename). No artifact will be removed; this needs human reconciliation."
    if ($ActivationError) { throw $ActivationError }
    throw "Activation returned success but the production link could not be read; the outcome is unknown."
  }

  $Lifecycle.ObservedLinkTarget = $observed

  # Exact identity: the same canonical absolute path, and a regular file at the end of it. A directory
  # that happens to share the leaf name is not the published database.
  if ($observed -ne $expected -or $kind -ne "file") {
    $Lifecycle.ActivationState = "reconciled-prior-active"
    Write-Host "[rollup-refresh] Activation did not select this artifact; the live link resolves to '$observed' (kind=$kind), expected '$expected'."
    if ($ActivationError) { throw $ActivationError }
    throw "Activation returned success but the production link resolves to '$observed' (kind=$kind), not '$expected'."
  }

  # Read-back proves it. This is the only thing that does.
  $Lifecycle.Remote = "active"
  $Lifecycle.Local = "active"
  $Lifecycle.ActivatedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
  if ($ActivationError) {
    $Lifecycle.ActivationState = "reconciled-active"
    Add-PostCommitWarning -Lifecycle $Lifecycle -Step "activate-symlink" -Kind "activation-transport" `
      -Message "activation reported an error but read-back proves $($Lifecycle.Basename) is live: $($ActivationError.Exception.Message)"
  } else {
    $Lifecycle.ActivationState = "applied"
  }
}

<#
.SYNOPSIS
Publish a built artifact as a transaction: stage, verify the candidate, commit, then report telemetry.

.PARAMETER Remote
The seam: TestClear, Upload, Digest, Move, Activate, ReadLink, Run, Remove. Production supplies
ssh/scp; the tests supply a fake that can fail at any transition, apply the swap and then report
failure, or return success having changed nothing.

.PARAMETER CandidateFreshnessCommand
The freshness contract against the candidate's OWN final path, before the symlink moves.

.PARAMETER LiveFreshnessCommand
The same contract through the production symlink afterwards. Post-commit: a failure is a warning.
#>
function Invoke-ArtifactPublication {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)]$Remote,
    [Parameter(Mandatory = $true)][string]$ExpectedDigest,
    [Parameter(Mandatory = $true)][string]$CandidateFreshnessCommand,
    [Parameter(Mandatory = $true)][string]$LiveFreshnessCommand,
    [Parameter(Mandatory = $true)][string]$ScoreboardCommand,
    [scriptblock]$ConfirmSourceUnchanged
  )
  if ($Lifecycle.Local -ne "built") {
    throw "Refusing to publish: the artifact is in state '$($Lifecycle.Local)', not 'built'."
  }

  $runOwned = Get-RunOwnedRemotePath -Lifecycle $Lifecycle

  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "precondition" -Action {
    & $Remote.TestClear $runOwned
  }.GetNewClosure() | Out-Null

  if ($ConfirmSourceUnchanged) { & $ConfirmSourceUnchanged }

  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "upload-database" -EntryRemoteState "staged-database" -Action {
    & $Remote.Upload $Lifecycle.LocalArtifact $Lifecycle.RemoteStagedArtifact "upload-database"
  }.GetNewClosure() | Out-Null

  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "upload-generation" -EntryRemoteState "staged-both" -Action {
    & $Remote.Upload $Lifecycle.LocalGeneration $Lifecycle.RemoteStagedGeneration "upload-generation"
  }.GetNewClosure() | Out-Null

  $remoteDigest = Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "verify-digest" -Action {
    & $Remote.Digest $Lifecycle.RemoteStagedArtifact
  }.GetNewClosure()
  if ($remoteDigest -ne $ExpectedDigest) {
    throw "Remote SHA-256 mismatch: uploaded copy reports $remoteDigest, local artifact is $ExpectedDigest."
  }

  # The generation file must be final BEFORE the candidate is verified: the freshness contract reads the
  # artifact's `.generation` sidecar, so checking with the sidecar still staged would fail for a reason
  # that has nothing wrong with the artifact.
  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "move-database" -EntryRemoteState "final-database-only" -Action {
    & $Remote.Move $Lifecycle.RemoteStagedArtifact $Lifecycle.RemoteArtifact "move-database"
  }.GetNewClosure() | Out-Null

  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "move-generation" -EntryRemoteState "final-both" -Action {
    & $Remote.Move $Lifecycle.RemoteStagedGeneration $Lifecycle.RemoteGeneration "move-generation"
  }.GetNewClosure() | Out-Null

  # Verified at its OWN path. Through the symlink it would only re-verify the artifact already live --
  # and with `-Force`, where the previous artifact can carry the same generation, that check would pass
  # while this candidate was never selected.
  Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "verify-candidate" -Action {
    & $Remote.Run "verify-candidate" $CandidateFreshnessCommand
  }.GetNewClosure() | Out-Null
  $Lifecycle.Remote = "candidate-verified"

  # The last moment at which refusing is still free.
  if ($ConfirmSourceUnchanged) { & $ConfirmSourceUnchanged }

  # ---- the commit point --------------------------------------------------------------------------
  $activationError = $null
  try {
    Invoke-LifecycleTransition -Lifecycle $Lifecycle -Name "activate-symlink" -Action {
      & $Remote.Activate $Lifecycle.Basename $Lifecycle.RemoteLink $Lifecycle.RemoteStagingLink
    }.GetNewClosure() | Out-Null
  } catch {
    $activationError = $_
  }

  # Unconditional. A zero exit is not evidence, so this decides -- and it throws for every outcome
  # except an exact match.
  Resolve-ActivationOutcome -Lifecycle $Lifecycle -Remote $Remote -ActivationError $activationError
  # ---- publication has succeeded from here on ----------------------------------------------------

  # The live check is downgraded to a warning ONLY because read-back has already proved the link names
  # this run and the candidate already passed freshness at its own path. It is recorded as its own kind:
  # "not visible through the production path" is a different fact from "a log did not get written".
  Invoke-PostCommitStep -Lifecycle $Lifecycle -Remote $Remote -Name "confirm-live" `
    -Kind "live-path-verification" -Command $LiveFreshnessCommand
  if (-not (@($Lifecycle.PostCommitWarnings) | Where-Object { $_.Kind -eq "live-path-verification" })) {
    $Lifecycle.Remote = "verified"
  }

  Invoke-PostCommitStep -Lifecycle $Lifecycle -Remote $Remote -Name "latency-scoreboard" `
    -Kind "telemetry" -Command $ScoreboardCommand
}

<#
.SYNOPSIS
Run one post-commit step. Records a warning of the given kind instead of throwing.
#>
function Invoke-PostCommitStep {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)]$Remote,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Command
  )
  $Lifecycle.Transitions += $Name
  try {
    & $Remote.Run $Name $Command
  } catch {
    Add-PostCommitWarning -Lifecycle $Lifecycle -Step $Name -Kind $Kind `
      -Message "failed after activation: $($_.Exception.Message)"
    Write-Host "[rollup-refresh] The artifact is live and publication stands; this is post-commit, not the commit."
  }
}

<#
.SYNOPSIS
What a failure in the current state owns. A pure function of the lifecycle -- no I/O, no guessing.

.DESCRIPTION
`LocalDisposable` is true only while the artifact is still `building` or `built`. From the commit point
on -- and equally when the commit point's outcome is unknown -- production may be serving it.

`RemotePaths` is exact-path, never a wildcard sweep of a directory holding production's live data:

  * `absent`             -- the precondition has not passed. If it FAILED, the paths it objected to were
                            not created by this run, and deleting them would fight whatever did.
  * `active` / `verified`-- production owns these files.
  * `activation-unknown` -- the staging link ONLY. That path is provably never what production reads, so
                            removing it cannot affect what is being served, and leaving it is residue.
                            No artifact is touched.
  * anything else        -- all five run-owned paths. `mv` is atomic, so a failed move leaves the file on
                            one side or the other and cleanup cannot know which; removal is idempotent,
                            so naming both costs nothing and missing one leaks a rollup database.
#>
function Get-FailureCleanupPlan {
  param([Parameter(Mandatory = $true)]$Lifecycle)

  $localDisposable = @("building", "built") -contains $Lifecycle.Local
  $remotePaths = @()
  $reason = ""

  if ($Lifecycle.Remote -eq "activation-unknown") {
    $remotePaths = @($Lifecycle.RemoteStagingLink)
    $reason = "the activation outcome is unknown; only the staging link is removed and no artifact is touched"
  } elseif ($script:NoArtifactCleanupStates -contains $Lifecycle.Remote) {
    if ($Lifecycle.Remote -eq "absent") {
      $reason = "the precondition never passed, so this run created nothing remotely"
    } else {
      $reason = "production is serving this artifact"
    }
  } else {
    $remotePaths = Get-RunOwnedRemotePath -Lifecycle $Lifecycle
    $reason = "run-owned files staged or finalised but never activated"
  }

  return [pscustomobject]@{
    LocalDisposable             = $localDisposable
    LocalPaths                  = if ($localDisposable) { @($Lifecycle.LocalArtifact, $Lifecycle.LocalGeneration) } else { @() }
    RemotePaths                 = $remotePaths
    RemoteReason                = $reason
    LocalState                  = $Lifecycle.Local
    RemoteState                 = $Lifecycle.Remote
    ActivationState             = $Lifecycle.ActivationState
    Committed                   = (Test-PublicationCommitted -Lifecycle $Lifecycle)
    RequiresHumanReconciliation = ($Lifecycle.Remote -eq "activation-unknown")
  }
}

<#
.SYNOPSIS
Execute the remote half of the cleanup plan. Best effort, exact path, never throws.
#>
function Invoke-RemoteFailureCleanup {
  param(
    [Parameter(Mandatory = $true)]$Lifecycle,
    [Parameter(Mandatory = $true)]$Remote
  )
  $plan = Get-FailureCleanupPlan -Lifecycle $Lifecycle
  $removed = @()
  if ($plan.RemotePaths.Count -eq 0) {
    Write-Host "[rollup-refresh] No remote cleanup needed: $($plan.RemoteReason)."
    return $removed
  }
  Write-Host "[rollup-refresh] Removing remote files from the failed run ($($plan.RemoteReason))..."
  foreach ($path in $plan.RemotePaths) {
    try {
      & $Remote.Remove $path
      $removed += $path
    } catch {
      # Never rethrow: the error that caused this cleanup is the one a human needs.
      Write-Host "[rollup-refresh] Could not remove remote ${path}: $($_.Exception.Message)"
    }
  }
  return $removed
}
