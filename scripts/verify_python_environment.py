"""Authoritative reverse containment for the harness's Python environment.

WHAT THIS REPLACES, AND WHY. An earlier version of this correction claimed that comparing `pip freeze`
against the lock proved every locked package was genuinely required. It does not. `pip freeze` proves
only that everything in the lock was installed -- a package added to the lock with a forged `# via`
comment is installed, appears in both lists, and passes. The repository-side `# via` check has the same
blind spot for the same reason: it reads a comment, and a comment can lie.

Real reachability can only come from the installed distributions' own dependency metadata, evaluated for
the environment actually running. That is what this script does, and it is the authoritative check:

    declared direct roots  subset-of  metadata-reachable  ==  locked  ==  installed locked

MARKERS ARE EVALUATED, NOT IGNORED. `pandas` requires `tzdata; sys_platform == "win32"` and
`numpy>=2.3.3; python_version >= "3.14"`; it also declares roughly ninety `extra == "..."` requirements
for optional features. Treating markers as absent would pull scipy, matplotlib, PyQt5 and the rest into
the reachable set and the comparison would fail; treating a true marker as false would drop tzdata on
Windows and it would fail the other way. Both directions have controls in the P1.2b evidence.

THE PARSER, AND ITS COUPLING. Marker and requirement parsing uses pip's VENDORED copy of `packaging`
(`pip._vendor.packaging`), because adding a `packaging` distribution to the lock to check the lock would
be circular, and because no undeclared parser may be introduced. That is a real coupling to a private
module path, so this script REFUSES TO RUN unless the interpreter's pip is exactly the version recorded
in `requirements-harness.in` as `# harness-env: pip==<version>`. If pip is upgraded, that line moves and
this coupling is re-reviewed deliberately rather than discovered by a broken run.

Read-only. Installs nothing, contacts no index.
"""
import importlib.metadata as md
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
DECLARATION = REPO / "requirements-harness.in"
LOCK = REPO / "requirements-harness.txt"

# Distributions the ENVIRONMENT supplies, not the lock: `python -m venv` seeds pip via ensurepip. They
# are excluded from the installed set rather than expected in the lock.
PROVIDED_BY_ENVIRONMENT = {"pip", "setuptools", "wheel"}

problems = []


def fail(message):
    problems.append(message)
    print(f"  FAIL  {message}")


def ok(message):
    print(f"  ok    {message}")


def read_declaration():
    """Direct roots, and the pinned pip version this script's parser coupling is reviewed against."""
    roots, pinned_pip = [], None
    for line in DECLARATION.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        m = re.match(r"^#\s*harness-env:\s*pip==([0-9][0-9A-Za-z.\-]*)\s*$", stripped)
        if m:
            pinned_pip = m.group(1)
            continue
        if not stripped or stripped.startswith("#"):
            continue
        roots.append(re.split(r"[<>=!;\[ ]", stripped)[0])
    return roots, pinned_pip


def read_lock():
    names = []
    for line in LOCK.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Za-z0-9._-]+)==", line)
        if m:
            names.append(m.group(1))
    return names


def build_environment(canonicalize=None):
    """The marker environment for THIS interpreter, with extras explicitly not requested.

    `--strip-extras` generated the lock, so nothing was installed for an extra. Supplying `extra: ""`
    makes every `extra == "..."` marker evaluate to False instead of raising on an undefined name.
    """
    from pip._vendor.packaging.markers import default_environment

    env = dict(default_environment())
    env["extra"] = ""
    return env


def installed_distributions():
    """canonical name -> (distribution name, version), excluding environment-supplied packages."""
    from pip._vendor.packaging.utils import canonicalize_name

    found = {}
    for dist in md.distributions():
        name = dist.metadata["Name"]
        if not name:
            continue
        canonical = canonicalize_name(name)
        if canonical in PROVIDED_BY_ENVIRONMENT:
            continue
        found[canonical] = (name, dist.version)
    return found


def reachable_from(roots, installed, environment):
    """Canonical names reachable from `roots` through real metadata, honouring markers.

    `environment` is passed in rather than computed here so the P1.2b controls can evaluate the same
    traversal under a different platform and show that markers are genuinely applied.
    """
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.utils import canonicalize_name

    seen, frontier, unsatisfied = set(), list(roots), []
    while frontier:
        canonical = canonicalize_name(frontier.pop())
        if canonical in seen:
            continue
        seen.add(canonical)
        entry = installed.get(canonical)
        if entry is None:
            unsatisfied.append(canonical)
            continue
        for raw in md.requires(entry[0]) or []:
            try:
                req = Requirement(raw)
            except Exception as exc:                      # a requirement we cannot parse is a defect
                unsatisfied.append(f"{canonical}: unparseable requirement {raw!r} ({exc})")
                continue
            if req.marker is not None and not req.marker.evaluate(environment):
                continue
            frontier.append(req.name)
    return seen, unsatisfied


def main():
    from pip._vendor.packaging.utils import canonicalize_name
    import pip

    roots_raw, pinned_pip = read_declaration()
    if not roots_raw:
        fail(f"{DECLARATION.name} declares no direct packages")
        return 1

    # The parser coupling, asserted before the parser is trusted.
    if pinned_pip is None:
        fail(f"{DECLARATION.name} has no `# harness-env: pip==<version>` line; the vendored-parser "
             "coupling is undocumented")
    elif pip.__version__ != pinned_pip:
        fail(f"pip is {pip.__version__}, not the recorded {pinned_pip}; "
             "pip._vendor.packaging is a private module path and the coupling must be re-reviewed "
             "deliberately rather than discovered by a broken run")
    else:
        ok(f"pip is exactly the recorded {pinned_pip}, so the vendored packaging parser is the reviewed one")

    if not (sys.prefix != sys.base_prefix):
        fail("this is not a virtual environment; refusing to verify a shared interpreter")
    else:
        ok(f"running inside a virtual environment ({sys.prefix})")

    roots = [canonicalize_name(r) for r in roots_raw]
    locked = {canonicalize_name(n) for n in read_lock()}
    installed = installed_distributions()
    environment = build_environment()

    reachable, unsatisfied = reachable_from(roots, installed, environment)

    if unsatisfied:
        fail("declared or required distributions are not installed: " + ", ".join(sorted(unsatisfied)))
    else:
        ok(f"every requirement reachable from the declaration is installed ({len(reachable)} package(s))")

    missing_roots = [r for r in roots if r not in reachable]
    if missing_roots:
        fail("declared direct roots not reachable: " + ", ".join(missing_roots))
    else:
        ok(f"declared direct roots are reachable: {', '.join(roots)}")

    # THE CHECK THE FORGED `# via` DEFEATED BEFORE. Reachability is computed from metadata, so a package
    # in the lock that nothing actually requires has no path here regardless of what a comment claims.
    not_required = sorted(locked - reachable)
    if not_required:
        fail("locked but NOT reachable from any declared root through real dependency metadata: "
             + ", ".join(not_required)
             + " -- a `# via` comment is not evidence; nothing requires these")
    else:
        ok("every locked package is reachable from a declared root through real metadata")

    not_locked = sorted(reachable - locked)
    if not_locked:
        fail("reachable through metadata but absent from the lock: " + ", ".join(not_locked))
    else:
        ok("nothing reachable is missing from the lock")

    installed_locked = set(installed)
    if installed_locked != locked:
        extra = sorted(installed_locked - locked)
        absent = sorted(locked - installed_locked)
        fail("the installed set does not equal the lock"
             + (f"; installed but not locked: {', '.join(extra)}" if extra else "")
             + (f"; locked but not installed: {', '.join(absent)}" if absent else ""))
    else:
        ok(f"the installed set equals the lock exactly ({len(locked)} package(s))")

    print("")
    print(f"    roots     : {', '.join(sorted(roots))}")
    print(f"    reachable : {', '.join(sorted(reachable))}")
    print(f"    locked    : {', '.join(sorted(locked))}")
    print(f"    markers   : sys_platform={environment.get('sys_platform')} "
          f"python_version={environment.get('python_version')} extra=<unset>")
    print("")
    if problems:
        print(f"python environment verification: {len(problems)} problem(s)")
        return 1
    print("python environment verification: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
