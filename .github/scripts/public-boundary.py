#!/usr/bin/env python3
"""Keep private maintainer context out of this public repository.

Checks every tracked file path and text file (symlinks by target), and
optionally pull request metadata passed through the environment:

    PR_TITLE, PR_BODY          failures when they carry private context
    PR_HEAD_REF                failure when the branch name carries private context
    PR_BASE_SHA, PR_HEAD_SHA   commits in base..head: messages and emails

The patterns below are written so that this file never matches itself.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
MAX_TEXT_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]
    hint: str


# Placeholder account names that tests and docs may use in example paths.
SAMPLE_UNIX_HOME_NAMES = (
    "u|user|username|runner|someone|example|me|you|alice|bob|name|test|tester|"
    "vyane|dev|ci|root|nobody|ubuntu"
)
SAMPLE_WIN_USER_NAMES = (
    "Public|Default|runneradmin|ContainerAdministrator|user|username|runner|example|tester"
)
IPV4_OCTET = r"(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"

CONTENT_RULES = (
    Rule(
        "internal-board-id",
        re.compile(r"(?<![A-Za-z0-9])EOS[-_]?\d{2,}(?![0-9])", re.IGNORECASE),
        "internal tracker IDs belong in the private tracker, not in public files",
    ),
    Rule(
        "agent-handoff-metadata",
        re.compile(
            r"(?<![^\W_])(?:[a]uthor[ _-]*(?:dispatch|orca[ _-]*session|session)(?:[ _-]*id)?)[ \t]*[:=：]"
            r"|\b[d]ispatch=[c]tx_[A-Za-z0-9]+"
            r"|\b[o]rca_session_id:",
            re.IGNORECASE,
        ),
        "agent hand-off and session metadata must not appear in public repositories",
    ),
    Rule(
        "private-home-path",
        re.compile(
            r"(?:/[h]ome|/[U]sers)/(?!(?:" + SAMPLE_UNIX_HOME_NAMES + r")(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+(?:/|\b)"
            r"|(?:/[h]ome|/[U]sers)/[^/\s]+[/]AIOS\b"
            r"|(?i:[A-Za-z]:\\[U]sers\\(?!(?:" + SAMPLE_WIN_USER_NAMES + r")(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+)"
            r"|(?:~|\$HOME|\$\{HOME\})[/]AIOS\b"
            r"|\\\\[w]sl(?:\$|\.[l]ocalhost\b)"
            r"|\.[l]ocal/share/vyane\b"
        ),
        "use repository-relative paths, a placeholder account, or an environment variable",
    ),
    Rule(
        "private-network-address",
        re.compile(
            r"\b[b]eacon[.]sqlite\b"
            r"|(?<![0-9.])(?:"
            r"10\." + IPV4_OCTET + r"\." + IPV4_OCTET + r"\." + IPV4_OCTET
            + r"|192\.168\." + IPV4_OCTET + r"\." + IPV4_OCTET
            + r"|172\.(?:1[6-9]|2\d|3[01])\." + IPV4_OCTET + r"\." + IPV4_OCTET
            + r"|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\." + IPV4_OCTET + r"\." + IPV4_OCTET
            + r")(?![0-9.])"
            r"|\.[A-Za-z0-9-]+\.[t]s\.net\b"
            r"|\b[l]ocalhost(?::\d+)?\b",
            re.IGNORECASE,
        ),
        "private network addresses and internal hostnames must not appear in public files",
    ),
    Rule(
        "credential-or-key",
        re.compile(
            r"\b(?:[g]hp_[A-Za-z0-9]{20,}|[g]ithub_pat_[A-Za-z0-9_]{20,}|[s]k-[A-Za-z0-9_-]{20,}|[A]KIA[0-9A-Z]{16})\b"
            r"|-{5}[B]EGIN [A-Z ]*PRIVATE KEY-{5}"
        ),
        "credentials and private keys must never be committed or posted publicly",
    ),
)

PATH_RULES = (
    Rule(
        "delivery-note",
        re.compile(r"(^|/)[D]ELIVER-[^/]*$", re.IGNORECASE),
        "agent delivery notes are hand-off material and must not be committed",
    ),
    Rule(
        "internal-board-id-in-path",
        re.compile(r"(^|[/_.-])eos[-_]?\d{2,}(?=[_./-]|$)", re.IGNORECASE),
        "rename the file without the internal tracker ID",
    ),
)


@dataclass(frozen=True)
class Finding:
    where: str
    rule: Rule
    excerpt: str

    def render(self) -> str:
        return f"{self.where}: [{self.rule.name}] {self.excerpt!r} — {self.rule.hint}"


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        check=True,
        capture_output=True,
    ).stdout
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def read_text(path: Path, warnings: list[str]) -> str | None:
    """Return the text to scan, or None for binary files.

    A symlink is scanned by its target string, which is what git stores.
    Anything skipped for a reason other than being binary is reported.
    """
    try:
        if path.is_symlink():
            return os.readlink(path)
        if not path.is_file():
            return None
        if path.stat().st_size > MAX_TEXT_BYTES:
            warnings.append(f"{path}: larger than {MAX_TEXT_BYTES} bytes, not scanned")
            return None
        data = path.read_bytes()
    except OSError as err:
        warnings.append(f"{path}: unreadable ({err}), not scanned")
        return None
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", "replace")
    if b"\0" in data:
        return None
    return data.decode("utf-8", "replace")


def scan_text(where: str, text: str) -> list[Finding]:
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for rule in CONTENT_RULES:
            match = rule.pattern.search(line)
            if match:
                findings.append(Finding(f"{where}:{lineno}", rule, match.group(0)))
    return findings


def scan_path(where: str, rel: str) -> list[Finding]:
    findings = []
    for rule in PATH_RULES:
        if rule.pattern.search(rel):
            findings.append(Finding(where, rule, rel))
    return findings


def scan_repository(root: Path, warnings: list[str]) -> list[Finding]:
    findings = []
    for rel in tracked_files(root):
        findings.extend(scan_path(rel, rel))
        text = read_text(root / rel, warnings)
        if text is not None:
            findings.extend(scan_text(rel, text))
    return findings


def scan_commits(root: Path, base: str, head: str) -> list[Finding]:
    """Scan messages and author/committer emails of the commits in a PR."""
    out = subprocess.run(
        ["git", "-C", str(root), "log", "--format=%H%x00%ae%x00%ce%x00%B%x1e", f"{base}..{head}"],
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8", "replace")
    findings = []
    for record in out.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        sha, author, committer, body = record.split("\0", 3)
        where = f"commit {sha[:12]}"
        findings.extend(scan_text(f"{where} author", author))
        findings.extend(scan_text(f"{where} committer", committer))
        findings.extend(scan_text(f"{where} message", body))
    return findings


def scan_pull_request(root: Path, env: dict[str, str]) -> list[Finding]:
    failures = []
    for key, label in (
        ("PR_TITLE", "pull request title"),
        ("PR_BODY", "pull request body"),
        ("PR_HEAD_REF", "pull request branch"),
    ):
        value = env.get(key, "")
        if value:
            failures.extend(scan_text(label, value))
    head_ref = env.get("PR_HEAD_REF", "")
    if head_ref:
        for finding in scan_path("pull request branch", head_ref):
            if finding.rule.name != "internal-board-id-in-path":
                failures.append(finding)
    base, head = env.get("PR_BASE_SHA", ""), env.get("PR_HEAD_SHA", "")
    if base and head:
        failures.extend(scan_commits(root, base, head))
    return failures


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    args = parser.parse_args(argv)

    root = args.root.resolve()
    skipped: list[str] = []
    failures = scan_repository(root, skipped)
    failures.extend(scan_pull_request(root, dict(os.environ)))

    for message in skipped:
        print(f"::warning::{message}")
    for finding in failures:
        print(f"::error::{finding.render()}")
    if failures:
        print(f"public boundary: {len(failures)} finding(s)", file=sys.stderr)
        return 1
    print("public boundary: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
