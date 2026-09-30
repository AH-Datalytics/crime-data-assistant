"""Canaries for the escape-integrity gate's TWO views.

WHY THIS FILE EXISTS AT ALL. The gate's canaries had been run by hand and thrown away. A gate whose
own correctness is unproven is the same shape of defect as the vacuous `ssh` tripwire it was built to
prevent: it reports PASS, everyone believes it, and nobody can show it would ever say otherwise. So
the canaries are executable and committed, and they run in `pretest` immediately after the gate.

WHAT IT PROVES, AND WHY EACH HALF IS NECESSARY.

  Verdict A scans INDEX BLOBS -- what propagates to every other checkout. It is checkout-independent
  by construction, which canary A5 demonstrates directly: the same commit, cloned once with
  core.autocrlf=false and once with core.autocrlf=true, yields an identical verdict A.

  Verdict B scans the WORKING TREE -- the bytes the tests and the runtime actually execute. Canary B1
  is the case that verdict A structurally cannot see: the index is clean, and the file on disk holds
  an unstaged control byte. The suite runs the file on disk. Without verdict B the run is green and
  the executed code is corrupt.

NON-VACUITY. Every canary here would also pass against a gate that did nothing but print PASS, so the
last section MUTATES THE GATE'S OWN SOURCE and requires the canaries to break. Three mutations, each
targeting one new rule:

  M1  worktree scan replaced by the index scan  ->  B1 must stop failing
  M2  `eol=lf` enforcement removed              ->  B3 must stop failing
  M3  ordinary CRLF permission removed          ->  B2 must stop passing

Each mutation asserts its own textual substitution actually landed, so a mutation that silently
no-ops cannot masquerade as evidence.

NO ESCAPE SEQUENCES APPEAR IN THIS FILE. Every control byte is built from an integer constant --
`bytes([BACKSPACE])`, never a two-character escape. That is deliberate and it is the whole subject
matter: the defect class being tested is a source file that contains a raw control byte where an
escape belongs, and this file must not be able to acquire one by accident. It is itself tracked, so
the gate scans it too.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "check-control-characters.py")

NUL = 0x00
BACKSPACE = 0x08
TAB = 0x09
LF = 0x0A
CR = 0x0D
UNIT_SEPARATOR = 0x1F

passed = 0
failures = []


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True)


def git(cwd, *args):
    result = run(["git"] + list(args), cwd)
    if result.returncode != 0:
        raise AssertionError("git %s failed in %s: %s"
                            % (" ".join(args), cwd, result.stderr.decode("utf-8", "replace")))
    return result.stdout.decode("utf-8", "replace")


def new_repo(root, name, autocrlf="false"):
    """A throwaway repository with line-ending configuration pinned for determinism.

    autocrlf and eol are set explicitly so a canary's result never depends on the global Git config
    of whoever runs the suite.
    """
    path = os.path.join(root, name)
    os.makedirs(path)
    git(path, "init", "--quiet")
    git(path, "config", "core.autocrlf", autocrlf)
    git(path, "config", "core.eol", "lf")
    git(path, "config", "user.email", "canary@example.invalid")
    git(path, "config", "user.name", "canary")
    return path


def write_bytes(repo, relpath, data):
    full = os.path.join(repo, relpath.replace("/", os.sep))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as handle:
        handle.write(data)


def line(text, ending=LF):
    """A text line terminated by the given ending byte(s), built without escapes."""
    if ending == CR:
        return text.encode("ascii") + bytes([CR])
    if ending == "crlf":
        return text.encode("ascii") + bytes([CR, LF])
    return text.encode("ascii") + bytes([LF])


def gate(repo, gate_path=None):
    """Run the gate in `repo`. Returns (exit code, verdict A, verdict B, stdout)."""
    result = run([sys.executable, gate_path or GATE], repo)
    out = result.stdout.decode("utf-8", "replace")
    verdicts = {}
    for raw in out.splitlines():
        text = raw.strip()
        for key in ("verdict A", "verdict B"):
            if text.startswith(key) and text.endswith(("PASS", "FAIL")):
                verdicts[key[-1]] = text.rsplit(":", 1)[1].strip()
    if result.returncode == 2:
        raise AssertionError("gate crashed in %s: %s"
                             % (repo, result.stderr.decode("utf-8", "replace")))
    if set(verdicts) != {"A", "B"}:
        raise AssertionError("gate did not report both verdicts in %s. stdout:\n%s" % (repo, out))
    return result.returncode, verdicts["A"], verdicts["B"], out


def check(name, body):
    global passed
    try:
        body()
    except AssertionError as exc:
        failures.append("%s: %s" % (name, exc))
        print("  FAIL  %s" % name)
        print("        %s" % exc)
        return
    passed += 1
    print("  ok    %s" % name)


def expect(actual, wanted, what):
    if actual != wanted:
        raise AssertionError("%s: expected %r, got %r" % (what, wanted, actual))


# ---------------------------------------------------------------------------------------------------
# The attribute parse, asserted directly.
#
# This is not decoration. The first version of the parser kept only the token carrying the `attr/`
# prefix, which discarded `eol=lf` and `eol=crlf` -- so BOTH eol branches in the gate were dead and
# nothing failed, because a dropped attribute is indistinguishable from an absent one. Every canary
# below tests the parse only through its downstream effect, and that is precisely how a silent parse
# defect survives. So the parse gets its own assertions.
# ---------------------------------------------------------------------------------------------------

def load_gate_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("escape_gate", GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canary_p1_attribute_parse(_root):
    gate_module = load_gate_module()
    tab = chr(TAB)

    declared_lf = gate_module.parse_eol_record("i/lf    w/crlf  attr/text eol=lf   " + tab + "hashed.json")
    expect(declared_lf["path"], "hashed.json", "path")
    expect(declared_lf["index_eol"], "lf", "index eol")
    expect(declared_lf["worktree_eol"], "crlf", "worktree eol")
    if "eol=lf" not in declared_lf["attrs"]:
        raise AssertionError("eol=lf was dropped from the attribute tokens: %r" % declared_lf["attrs"])
    if "text" not in declared_lf["attrs"]:
        raise AssertionError("text was dropped from the attribute tokens: %r" % declared_lf["attrs"])

    declared_crlf = gate_module.parse_eol_record("i/crlf  w/crlf  attr/text eol=crlf " + tab + "f.txt")
    if "eol=crlf" not in declared_crlf["attrs"]:
        raise AssertionError("eol=crlf was dropped: %r" % declared_crlf["attrs"])

    bare = gate_module.parse_eol_record("i/lf    w/lf    attr/              " + tab + "plain.md")
    expect(bare["attrs"], [], "a path with no attributes")

    # And the two decisions that consume it, so a future parse change cannot pass this canary while
    # inverting the rules.
    expect(gate_module.crlf_allowed_for(gate_module.INDEX_VIEW, declared_crlf["attrs"]), True,
           "index view permits CRLF where eol=crlf is declared")
    expect(gate_module.crlf_allowed_for(gate_module.INDEX_VIEW, bare["attrs"]), False,
           "index view rejects undeclared CRLF")
    expect(gate_module.crlf_allowed_for(gate_module.WORKTREE_VIEW, declared_lf["attrs"]), False,
           "worktree view rejects CRLF where eol=lf is declared")
    expect(gate_module.crlf_allowed_for(gate_module.WORKTREE_VIEW, bare["attrs"]), True,
           "worktree view permits ordinary CRLF")
    # eol=crlf must not be read as eol=lf by substring accident.
    expect(gate_module.crlf_allowed_for(gate_module.WORKTREE_VIEW, declared_crlf["attrs"]), True,
           "worktree view does not mistake eol=crlf for eol=lf")


# ---------------------------------------------------------------------------------------------------
# Verdict A -- repository integrity, scanning index blobs.
# ---------------------------------------------------------------------------------------------------

def canary_a1_clean(root):
    repo = new_repo(root, "a1")
    write_bytes(repo, "clean.py", line("value = 1") + line("other = 2"))
    write_bytes(repo, "tabbed.py", b"if True:" + bytes([LF, TAB]) + b"pass" + bytes([LF]))
    git(repo, "add", "-A")
    code, a, b, _ = gate(repo)
    expect(a, "PASS", "clean LF content, verdict A")
    expect(b, "PASS", "clean LF content, verdict B")
    expect(code, 0, "exit code on a clean repository")


def canary_a2_control_byte(root):
    repo = new_repo(root, "a2")
    # A word boundary that became a backspace: the original defect, verbatim in shape.
    write_bytes(repo, "rule.js", b"const re = /agency_monthly" + bytes([BACKSPACE]) + b"/;" + bytes([LF]))
    git(repo, "add", "-A")
    code, a, _, out = gate(repo)
    expect(a, "FAIL", "a staged 0x08, verdict A")
    if "control byte 0x08" not in out:
        raise AssertionError("the 0x08 was not named in the report:\n%s" % out)
    expect(code, 1, "exit code")


def canary_a3_lone_cr(root):
    repo = new_repo(root, "a3")
    # The rule this gate's own first draft got wrong: a CR with no LF after it.
    write_bytes(repo, "notes.md", line("first", CR) + line("second"))
    git(repo, "add", "-A")
    code, a, _, out = gate(repo)
    expect(a, "FAIL", "a staged lone CR, verdict A")
    if "lone CR" not in out:
        raise AssertionError("the lone CR was not named in the report:\n%s" % out)
    expect(code, 1, "exit code")


def canary_a4_undeclared_crlf(root):
    repo = new_repo(root, "a4")
    write_bytes(repo, "doc.md", line("first", "crlf") + line("second", "crlf"))
    git(repo, "add", "-A")
    code, a, _, out = gate(repo)
    expect(a, "FAIL", "CRLF recorded with no attribute declaring it, verdict A")
    if "CRLF where attributes require LF" not in out:
        raise AssertionError("the undeclared CRLF was not named:\n%s" % out)
    expect(code, 1, "exit code")


def canary_a4b_declared_crlf(root):
    repo = new_repo(root, "a4b")
    write_bytes(repo, "fixture.txt", line("first", "crlf") + line("second", "crlf"))
    # Staged BEFORE the attribute exists, which is how CRLF legitimately ends up recorded: the
    # attribute was added later and the index was never renormalised. With `text eol=crlf` in force
    # at add time Git normalises to LF, and this branch would be unreachable -- so only
    # .gitattributes is staged afterwards. Staging `-A` here would re-normalise fixture.txt to LF and
    # quietly turn this canary into a duplicate of A1.
    git(repo, "add", "fixture.txt")
    write_bytes(repo, ".gitattributes", line("fixture.txt text eol=crlf"))
    git(repo, "add", ".gitattributes")
    attrs = git(repo, "ls-files", "--eol", "--", "fixture.txt")
    if "eol=crlf" not in attrs:
        raise AssertionError("the canary did not achieve a declared eol=crlf: %s" % attrs.strip())
    if "i/crlf" not in attrs:
        raise AssertionError("the canary did not achieve CRLF in the index: %s" % attrs.strip())
    code, a, b, _ = gate(repo)
    expect(a, "PASS", "CRLF recorded where eol=crlf is declared, verdict A")
    expect(b, "PASS", "CRLF on disk where eol=crlf is declared, verdict B")
    expect(code, 0, "exit code")


def canary_a5_checkout_independent(root):
    """The design claim, tested directly: verdict A does not depend on the checkout's line endings."""
    source = new_repo(root, "a5-source")
    write_bytes(source, "clean.py", line("value = 1") + line("other = 2"))
    git(source, "add", "-A")
    git(source, "commit", "--quiet", "-m", "seed")

    verdicts = {}
    for autocrlf in ("false", "true"):
        clone = os.path.join(root, "a5-clone-" + autocrlf)
        # `-c` applies to the checkout the clone performs, so the working tree really does land as
        # LF in one clone and CRLF in the other. Verified: the CRLF clone reports w/crlf below.
        git(root, "-c", "core.autocrlf=" + autocrlf, "clone", "--quiet", source, clone)
        git(clone, "config", "core.autocrlf", autocrlf)
        wanted = "w/crlf" if autocrlf == "true" else "w/lf"
        listing = git(clone, "ls-files", "--eol")
        if wanted not in listing:
            raise AssertionError("the clone with autocrlf=%s did not produce %s, so this canary "
                                 "would compare two identical checkouts: %s"
                                 % (autocrlf, wanted, listing.strip()))
        _, a, b, _ = gate(clone)
        verdicts[autocrlf] = (a, b)

    expect(verdicts["false"][0], "PASS", "verdict A with autocrlf=false")
    expect(verdicts["true"][0], "PASS", "verdict A with autocrlf=true")
    if verdicts["false"][0] != verdicts["true"][0]:
        raise AssertionError("verdict A differed across checkouts: %r" % verdicts)
    # And the point of the split: the CRLF working tree the second clone now has is fine.
    expect(verdicts["true"][1], "PASS", "verdict B on a legitimately CRLF checkout")


def canary_a7_lone_cr_without_source_extension(root):
    """The hole rule 2 covered only by luck.

    Git's binary heuristic calls a lone CR binary with no NUL present, so the binary exclusion skipped
    the file. In A3 the path happened to end `.md`, so rule 2 flagged it. Here the path is a `.csv`
    and rule 2 is silent -- rule 3 is the only thing that can see it.
    """
    repo = new_repo(root, "a7")
    write_bytes(repo, "data/rows.csv", line("id,name", CR) + line("1,alpha"))
    git(repo, "add", "-A")

    listing = git(repo, "ls-files", "--eol", "--", "data/rows.csv")
    if "i/-text" not in listing:
        raise AssertionError("the canary assumes Git calls a lone-CR file binary; it did not: %s"
                             % listing.strip())

    code, a, b, out = gate(repo)
    expect(a, "FAIL", "a lone CR in a non-source-extension path, verdict A")
    if "contains no NUL byte" not in out:
        raise AssertionError("rule 3 did not fire:\n%s" % out)
    if "lone CR" not in out:
        raise AssertionError("rule 3 fired but the offending byte was never named:\n%s" % out)
    expect(b, "FAIL", "the same file on disk, verdict B")
    expect(code, 1, "exit code")


def canary_a8_genuine_binary_excluded(root):
    """A real binary is excluded. Rule 3 must not turn every asset into a finding."""
    repo = new_repo(root, "a8")
    payload = bytes([NUL, 0xFF, 0x01, BACKSPACE, 0x7F, NUL])
    write_bytes(repo, "assets/blob.bin", payload)
    write_bytes(repo, "clean.py", line("value = 1"))
    git(repo, "add", "-A")
    code, a, b, out = gate(repo)
    expect(a, "PASS", "a NUL-bearing binary asset, verdict A")
    expect(b, "PASS", "a NUL-bearing binary asset, verdict B")
    expect(code, 0, "a genuine binary must not fail the run")
    if "blob.bin" in out:
        raise AssertionError("the binary asset should not have been reported at all:\n%s" % out)


def canary_a9_declared_binary_excluded(root):
    """A path whose attributes DECLARE -text is a decision, not a heuristic verdict.

    This is the LFS-pointer case that exists in the real repository (`*.db filter=lfs ... -text`).
    Rule 3 must stay silent on it, or every declared-binary path becomes a permanent finding.
    """
    repo = new_repo(root, "a9")
    write_bytes(repo, ".gitattributes", line("*.pack -text"))
    # No NUL, but plenty of bytes a text scan would object to.
    write_bytes(repo, "store.pack", bytes([0x01, BACKSPACE, CR, 0x02]) + line("tail"))
    git(repo, "add", "-A")
    listing = git(repo, "ls-files", "--eol", "--", "store.pack")
    if "i/-text" not in listing:
        raise AssertionError("the canary did not achieve a declared binary: %s" % listing.strip())
    code, a, b, out = gate(repo)
    expect(a, "PASS", "a declared-binary path, verdict A")
    expect(b, "PASS", "a declared-binary path, verdict B")
    expect(code, 0, "a declared binary must not fail the run")
    if "store.pack" in out:
        raise AssertionError("a declared binary should not be reported:\n%s" % out)


def canary_a6_source_binary(root):
    repo = new_repo(root, "a6")
    # A TypeScript source Git classifies binary because a NUL sits where an escape belonged.
    write_bytes(repo, "digest.ts", b'const key = "' + bytes([NUL]) + b'null";' + bytes([LF]))
    git(repo, "add", "-A")
    code, a, _, out = gate(repo)
    expect(a, "FAIL", "a source file Git classifies binary, verdict A")
    if "classifies this source file as BINARY" not in out:
        raise AssertionError("rule 2 did not fire:\n%s" % out)
    expect(code, 1, "exit code")


# ---------------------------------------------------------------------------------------------------
# Verdict B -- working-tree executability, scanning the bytes on disk.
# ---------------------------------------------------------------------------------------------------

def canary_b1_unstaged_control_byte(root):
    """THE mutation this view exists for: clean index, corrupt file on disk.

    Verdict A is structurally blind here and correctly says PASS. The suite executes the file on
    disk, so the run must still fail.
    """
    repo = new_repo(root, "b1")
    clean = b"const re = /agency_monthly/;" + bytes([LF])
    write_bytes(repo, "rule.js", clean)
    git(repo, "add", "-A")
    git(repo, "commit", "--quiet", "-m", "clean")

    # Unstaged corruption, exactly as a shell-interpolated escape would produce it.
    write_bytes(repo, "rule.js", b"const re = /agency_monthly" + bytes([BACKSPACE]) + b"/;" + bytes([LF]))

    staged = git(repo, "diff", "--cached", "--name-only").strip()
    if staged:
        raise AssertionError("the canary staged something; the index must be clean: %r" % staged)
    blob = subprocess.run(["git", "cat-file", "blob", ":rule.js"], cwd=repo,
                          capture_output=True).stdout
    if bytes([BACKSPACE]) in blob:
        raise AssertionError("the canary corrupted the index too; it must corrupt only the worktree")

    code, a, b, out = gate(repo)
    expect(a, "PASS", "clean index, verdict A")
    expect(b, "FAIL", "unstaged 0x08 on disk, verdict B")
    if "control byte 0x08" not in out:
        raise AssertionError("the unstaged 0x08 was not named:\n%s" % out)
    expect(code, 1, "pretest must fail on an unstaged control byte")


def canary_b1b_other_forbidden_bytes(root):
    """Not just 0x08: any forbidden control byte, unstaged, must fail verdict B."""
    for label, byte in (("nul", NUL), ("unit-separator", UNIT_SEPARATOR)):
        repo = new_repo(root, "b1b-" + label)
        write_bytes(repo, "core.py", line("DELIM = chr(31)"))
        git(repo, "add", "-A")
        write_bytes(repo, "core.py", b'DELIM = "' + bytes([byte]) + b'"' + bytes([LF]))
        code, a, b, out = gate(repo)
        expect(a, "PASS", "%s: clean index, verdict A" % label)
        expect(b, "FAIL", "%s: unstaged control byte on disk, verdict B" % label)
        if ("control byte 0x%02x" % byte) not in out:
            raise AssertionError("%s was not named:\n%s" % (label, out))
        expect(code, 1, "%s: exit code" % label)


def canary_b2_ordinary_crlf_permitted(root):
    """A CRLF working tree with no eol attribute is a configuration, not a defect."""
    repo = new_repo(root, "b2")
    write_bytes(repo, "doc.md", line("first") + line("second"))
    git(repo, "add", "-A")
    write_bytes(repo, "doc.md", line("first", "crlf") + line("second", "crlf"))
    code, a, b, out = gate(repo)
    expect(a, "PASS", "LF in the index, verdict A")
    expect(b, "PASS", "ordinary CRLF on disk, verdict B")
    expect(code, 0, "an ordinary CRLF working tree must not fail the run")
    if "CRLF" not in out:
        raise AssertionError("verdict B did not state its CRLF policy:\n%s" % out)


def canary_b3_crlf_violates_declared_lf(root):
    """Where eol=lf is declared, something downstream depends on LF. CRLF on disk breaks it."""
    repo = new_repo(root, "b3")
    write_bytes(repo, ".gitattributes", line("hashed.json text eol=lf"))
    write_bytes(repo, "hashed.json", line("{") + line('  "a": 1') + line("}"))
    git(repo, "add", "-A")
    declared = git(repo, "ls-files", "--eol", "--", "hashed.json")
    if "eol=lf" not in declared:
        raise AssertionError("the canary did not achieve a declared eol=lf: %s" % declared.strip())

    write_bytes(repo, "hashed.json", line("{", "crlf") + line('  "a": 1', "crlf") + line("}", "crlf"))
    code, a, b, out = gate(repo)
    expect(a, "PASS", "LF in the index, verdict A")
    expect(b, "FAIL", "CRLF on disk where eol=lf is declared, verdict B")
    if "CRLF where attributes require LF" not in out:
        raise AssertionError("the declared-LF violation was not named:\n%s" % out)
    expect(code, 1, "exit code")


def canary_b4_lone_cr_on_disk(root):
    repo = new_repo(root, "b4")
    write_bytes(repo, "notes.md", line("first") + line("second"))
    git(repo, "add", "-A")
    write_bytes(repo, "notes.md", line("first", CR) + line("second"))
    code, a, b, out = gate(repo)
    expect(a, "PASS", "clean index, verdict A")
    expect(b, "FAIL", "lone CR on disk, verdict B")
    if "lone CR" not in out:
        raise AssertionError("the lone CR on disk was not named:\n%s" % out)
    expect(code, 1, "exit code")


def canary_b5_tab_permitted(root):
    repo = new_repo(root, "b5")
    write_bytes(repo, "indented.py", b"if True:" + bytes([LF, TAB]) + b"pass" + bytes([LF]))
    git(repo, "add", "-A")
    code, a, b, _ = gate(repo)
    expect(a, "PASS", "TAB, verdict A")
    expect(b, "PASS", "TAB, verdict B")
    expect(code, 0, "exit code")


def canary_b6_absent_path_reported(root):
    """A tracked path missing from disk is skipped -- but never silently."""
    repo = new_repo(root, "b6")
    write_bytes(repo, "gone.py", line("value = 1"))
    write_bytes(repo, "here.py", line("value = 2"))
    git(repo, "add", "-A")
    os.remove(os.path.join(repo, "gone.py"))
    code, a, b, out = gate(repo)
    expect(a, "PASS", "verdict A")
    expect(b, "PASS", "verdict B")
    expect(code, 0, "a deleted tracked file is not this gate's defect")
    if "absent from the working tree" not in out or "gone.py" not in out:
        raise AssertionError("the absent path was not reported:\n%s" % out)
    if "scanned 1 file(s) on disk" not in out:
        raise AssertionError("verdict B did not state how many files it actually read:\n%s" % out)


def canary_b7_verdicts_are_independent(root):
    """Both verdicts are always reported, and one failing does not suppress the other."""
    repo = new_repo(root, "b7")
    # Corrupt in the index, repaired on disk: the mirror image of B1.
    write_bytes(repo, "rule.js", b"const re = /x" + bytes([BACKSPACE]) + b"/;" + bytes([LF]))
    git(repo, "add", "-A")
    write_bytes(repo, "rule.js", b"const re = /x/;" + bytes([LF]))
    code, a, b, out = gate(repo)
    expect(a, "FAIL", "corrupt index, verdict A")
    expect(b, "PASS", "repaired working tree, verdict B")
    expect(code, 1, "a corrupt index must still fail the run")
    if "verdict A" not in out or "verdict B" not in out:
        raise AssertionError("both verdicts must always be printed:\n%s" % out)


# ---------------------------------------------------------------------------------------------------
# Non-vacuity: mutate the gate itself and require the canaries to break.
# ---------------------------------------------------------------------------------------------------

def mutated_gate(root, name, original, replacement):
    with open(GATE, "rb") as handle:
        source = handle.read().decode("utf-8")
    occurrences = source.count(original)
    if occurrences != 1:
        raise AssertionError("mutation %s expected exactly 1 site for %r, found %d -- the mutation "
                             "would not have landed, so it proves nothing"
                             % (name, original, occurrences))
    path = os.path.join(root, "mutant-" + name + ".py")
    with open(path, "wb") as handle:
        handle.write(source.replace(original, replacement).encode("utf-8"))
    return path


def mutation_m1_worktree_scan_removed(root):
    """Point verdict B at the index instead of the disk. B1 must stop failing."""
    mutant = mutated_gate(
        root, "m1",
        "contents, absent = worktree_bytes(repo_root(), paths)",
        "contents, absent = blob_bytes(paths), []")
    repo = new_repo(root, "m1-repo")
    write_bytes(repo, "rule.js", b"const re = /x/;" + bytes([LF]))
    git(repo, "add", "-A")
    write_bytes(repo, "rule.js", b"const re = /x" + bytes([BACKSPACE]) + b"/;" + bytes([LF]))

    code, a, b, _ = gate(repo, mutant)
    expect(a, "PASS", "mutant verdict A")
    expect(b, "PASS", "mutant verdict B -- it is now scanning the index, so it cannot see the disk")
    expect(code, 0, "the mutant passes, which is what makes canary B1 evidence")

    live_code, _, live_b, _ = gate(repo)
    expect(live_b, "FAIL", "the real gate on the same repository")
    expect(live_code, 1, "the real gate's exit code on the same repository")


def mutation_m2_declared_lf_unenforced(root):
    """Allow CRLF on disk unconditionally. B3 must stop failing."""
    mutant = mutated_gate(
        root, "m2",
        '    return "eol=lf" not in attrs',
        "    return True")
    repo = new_repo(root, "m2-repo")
    write_bytes(repo, ".gitattributes", line("hashed.json text eol=lf"))
    write_bytes(repo, "hashed.json", line("{") + line("}"))
    git(repo, "add", "-A")
    write_bytes(repo, "hashed.json", line("{", "crlf") + line("}", "crlf"))

    _, _, b, _ = gate(repo, mutant)
    expect(b, "PASS", "mutant verdict B with eol=lf unenforced")
    _, _, live_b, _ = gate(repo)
    expect(live_b, "FAIL", "the real gate on the same repository")


def mutation_m3_ordinary_crlf_rejected(root):
    """Forbid CRLF on disk outright. B2 must stop passing -- the false-refusal side of the rule.

    This is the mutation that keeps the fix honest. Rejecting every worktree CRLF would make B3 pass
    and look strictly safer, while failing every developer whose Git is configured the way Git for
    Windows ships. The cost of over-refusal is a real cost, so it gets a test.
    """
    mutant = mutated_gate(
        root, "m3",
        '    return "eol=lf" not in attrs',
        "    return False")
    repo = new_repo(root, "m3-repo")
    write_bytes(repo, "doc.md", line("first") + line("second"))
    git(repo, "add", "-A")
    write_bytes(repo, "doc.md", line("first", "crlf") + line("second", "crlf"))

    code, a, b, _ = gate(repo, mutant)
    expect(a, "PASS", "mutant verdict A")
    expect(b, "FAIL", "mutant verdict B rejects an ordinary CRLF checkout")
    expect(code, 1, "the mutant fails a legitimate configuration")

    live_code, _, live_b, _ = gate(repo)
    expect(live_b, "PASS", "the real gate permits an ordinary CRLF checkout")
    expect(live_code, 0, "the real gate's exit code on an ordinary CRLF checkout")


def mutation_m5_size_limit_is_visible_not_silent(root):
    """Rule 3 reads a Git-classified binary to look for a NUL, so it needs a size bound.

    A bound is a hole: past it the gate takes Git's word and a lone CR in a very large file goes
    unseen. That is an acceptable trade only if it is VISIBLE, so this shrinks the limit and requires
    the deferral to be reported rather than silently applied. An untested bound that quietly drops
    files is the same shape of defect as the exclusion rule 3 was added to fix.
    """
    mutant = mutated_gate(
        root, "m5",
        "BINARY_INSPECTION_LIMIT = 8 * 1024 * 1024",
        "BINARY_INSPECTION_LIMIT = 4")
    repo = new_repo(root, "m5-repo")
    write_bytes(repo, "data/rows.csv", line("id,name", CR) + line("1,alpha"))
    git(repo, "add", "-A")

    code, a, _, out = gate(repo, mutant)
    expect(a, "PASS", "verdict A once the file exceeds the inspection limit")
    expect(code, 0, "exit code")
    if "exceeded the" not in out or "inspection limit" not in out:
        raise AssertionError("the deferral was applied SILENTLY -- a skipped file must be reported:\n%s"
                             % out)
    if "taken at Git's word" not in out:
        raise AssertionError("the report does not say the file was left unexamined:\n%s" % out)

    # And with the real limit the same file is caught, which is what makes this a bound and not a bug.
    live_code, live_a, _, live_out = gate(repo)
    expect(live_a, "FAIL", "the real gate on the same repository")
    expect(live_code, 1, "the real gate's exit code")
    if "exceeded the" in live_out:
        raise AssertionError("the real gate deferred a 24-byte file, so the limit is misconfigured")


def mutation_m4_rule3_removed(root):
    """Stop recovering Git-classified binaries. A7 must stop failing."""
    mutant = mutated_gate(
        root, "m4",
        "    for path, data in blob_bytes(inspect).items():",
        "    for path, data in {}.items():")
    repo = new_repo(root, "m4-repo")
    write_bytes(repo, "data/rows.csv", line("id,name", CR) + line("1,alpha"))
    git(repo, "add", "-A")

    code, a, _, out = gate(repo, mutant)
    expect(a, "PASS", "mutant verdict A -- the lone CR is hidden behind the binary exclusion again")
    expect(code, 0, "the mutant passes, which is what makes canary A7 evidence")
    if "lone CR" in out:
        raise AssertionError("the mutant still named the byte, so the mutation did not disable rule 3")

    live_code, live_a, _, _ = gate(repo)
    expect(live_a, "FAIL", "the real gate on the same repository")
    expect(live_code, 1, "the real gate's exit code on the same repository")


# ---------------------------------------------------------------------------------------------------

def on_rm_error(func, path, _exc):
    """Git leaves objects read-only on Windows; make them writable and retry."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


CANARIES = [
    ("P1  the ls-files attribute parse keeps eol=lf and eol=crlf", canary_p1_attribute_parse),
    ("A1  clean LF content passes both views", canary_a1_clean),
    ("A2  a staged 0x08 fails verdict A", canary_a2_control_byte),
    ("A3  a staged lone CR fails verdict A", canary_a3_lone_cr),
    ("A4  undeclared CRLF in the index fails verdict A", canary_a4_undeclared_crlf),
    ("A4b declared eol=crlf permits CRLF in the index", canary_a4b_declared_crlf),
    ("A5  verdict A is identical across autocrlf=false and autocrlf=true", canary_a5_checkout_independent),
    ("A6  a source file Git calls binary is flagged", canary_a6_source_binary),
    ("A7  a lone CR in a non-source path is still caught (rule 3)", canary_a7_lone_cr_without_source_extension),
    ("A8  a genuine NUL-bearing binary is excluded", canary_a8_genuine_binary_excluded),
    ("A9  a path declaring -text is excluded without comment", canary_a9_declared_binary_excluded),
    ("B1  clean index + unstaged 0x08 on disk fails the run", canary_b1_unstaged_control_byte),
    ("B1b unstaged NUL and 0x1F on disk fail the run", canary_b1b_other_forbidden_bytes),
    ("B2  an ordinary CRLF working tree passes", canary_b2_ordinary_crlf_permitted),
    ("B3  CRLF on disk where eol=lf is declared fails", canary_b3_crlf_violates_declared_lf),
    ("B4  a lone CR on disk fails", canary_b4_lone_cr_on_disk),
    ("B5  TAB passes both views", canary_b5_tab_permitted),
    ("B6  a tracked path absent from disk is reported, not silently skipped", canary_b6_absent_path_reported),
    ("B7  a corrupt index and a clean disk report separately", canary_b7_verdicts_are_independent),
    ("M1  removing the worktree scan makes B1 pass", mutation_m1_worktree_scan_removed),
    ("M2  unenforcing declared eol=lf makes B3 pass", mutation_m2_declared_lf_unenforced),
    ("M3  rejecting ordinary CRLF makes B2 fail", mutation_m3_ordinary_crlf_rejected),
    ("M4  removing rule 3 makes A7 pass", mutation_m4_rule3_removed),
    ("M5  the binary-inspection size bound defers VISIBLY, never silently", mutation_m5_size_limit_is_visible_not_silent),
]


def main():
    root = tempfile.mkdtemp(prefix="escape-gate-canaries-")
    try:
        for name, body in CANARIES:
            check(name, lambda body=body: body(root))
    finally:
        shutil.rmtree(root, onerror=on_rm_error)

    print("escape-integrity gate canaries: %d passed, %d failed" % (passed, len(failures)))
    if failures:
        for failure in failures:
            print("  " + failure)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
