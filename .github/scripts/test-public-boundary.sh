#!/usr/bin/env bash
# Exercises public-boundary.py against throwaway repositories. Violating
# strings are assembled at runtime so this file never trips the gate itself.
set -euo pipefail

PYTHON="${PYTHON:-$(command -v python3 || command -v python)}"
if [ -z "$PYTHON" ]; then
  echo "public boundary test: python3/python not found" >&2
  exit 1
fi

to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

readonly SCRIPT_POSIX="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/public-boundary.py"
readonly SCRIPT="$(to_native_path "$SCRIPT_POSIX")"
readonly TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

readonly BOARD_ID="EOS""-1234"
readonly HOME_PATH="/home/someone/""AIOS/project"
readonly SAMPLE_HOME_PATH="/home/""ubuntu/project"
readonly NO_PR=(env -u PR_TITLE -u PR_BODY -u PR_HEAD_REF -u PR_BASE_SHA -u PR_HEAD_SHA)

fresh_repo() {
  local dir="$TEMP_ROOT/$1"
  git init -q "$dir"
  git -C "$dir" config core.autocrlf false
  printf 'clean public text\n' >"$dir/README.md"
  echo "$dir"
}

stage_all() {
  git -C "$1" add -A
}

expect_clean() {
  if ! MSYS2_ARG_CONV_EXCL="*" "${NO_PR[@]}" "$@" >"$TEMP_ROOT/out" 2>&1; then
    echo "public boundary test: expected clean: $*" >&2
    cat "$TEMP_ROOT/out" >&2
    exit 1
  fi
}

expect_rule() {
  local rule="$1"
  shift
  if MSYS2_ARG_CONV_EXCL="*" "${NO_PR[@]}" "$@" >"$TEMP_ROOT/out" 2>&1; then
    echo "public boundary test: expected [$rule] failure: $*" >&2
    exit 1
  fi
  grep -q -- "\[$rule\]" "$TEMP_ROOT/out" || {
    echo "public boundary test: missing [$rule] in output" >&2
    cat "$TEMP_ROOT/out" >&2
    exit 1
  }
}

expect_label() {
  grep -q -- "$1" "$TEMP_ROOT/out" || {
    echo "public boundary test: missing '$1' in output" >&2
    cat "$TEMP_ROOT/out" >&2
    exit 1
  }
}

# A clean tree passes, and so does this repository.
repo="$(fresh_repo clean)"
stage_all "$repo"
expect_clean "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"
expect_clean "$PYTHON" "$SCRIPT"

# Content rules: each sample must trip the named rule.
content_case() {
  local rule="$1" text="$2" file="${3:-notes.md}"
  local repo
  repo="$(fresh_repo "case$RANDOM$RANDOM")"
  printf '%s\n' "$text" >"$repo/$file"
  stage_all "$repo"
  expect_rule "$rule" "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"
}

# Internal board IDs
content_case internal-board-id "fixes $BOARD_ID"
content_case internal-board-id "fixes eos""-1234 in lower case"
content_case internal-board-id "branch_EOS""_652 and more"
content_case internal-board-id "test eos""652_p2"

# Agent handoff and session metadata
content_case agent-handoff-metadata "author_""dispatch: abc123"
content_case agent-handoff-metadata "author_orca_""session_id=abc123"
content_case agent-handoff-metadata "author ""session：abc123"
content_case agent-handoff-metadata "dispatch=""ctx_sample0001"
content_case agent-handoff-metadata "orca_session_""id:00000000"

# Private local paths
content_case private-home-path "path=$HOME_PATH" run.sh
content_case private-home-path "cache=/home/""maintainer/.cache/x"
content_case private-home-path "mac=/Users/""maintainer/src"
content_case private-home-path 'win=C:\''Users\''Maintainer\work'
content_case private-home-path "dir=~/""AIOS/repo"
content_case private-home-path 'dir=$HOME/''AIOS/repo'
content_case private-home-path 'share=\\''wsl$\Ubuntu'
content_case private-home-path 'share=\\''wsl.''local''host\Ubuntu'
content_case private-home-path "state=.""local/share/vyane/db"

# Placeholder prefixes do not exempt a different account name.
content_case private-home-path "/home/""runner-other/work"
content_case private-home-path "/Users/""runner.private/work"
content_case private-home-path 'C:\''Users\''runner-private\work'
content_case private-home-path "/home/""ubuntu/""AIOS/repo"

# Private network and internal addresses
content_case private-network-address "db=beacon"".sqlite"
content_case private-network-address "host=10.""0.0.1"
content_case private-network-address "host=192.""168.1.25"
content_case private-network-address "host=172.""16.4.8"
content_case private-network-address "host=172.""31.255.1"
content_case private-network-address "host=100.""64.0.1"
content_case private-network-address "host=100.""127.10.2"
content_case private-network-address "url=https://box.tailnet.""ts.net/api"
content_case private-network-address "url=http://local""host:8080/health"

# Credentials and private keys
content_case credential-or-key "token=ghp_""1234567890abcdefghij1234"
content_case credential-or-key "token=github_pat_""1234567890abcdefghij1234"
content_case credential-or-key "key=sk-""1234567890abcdefghij1234"
content_case credential-or-key "aws=AKIA""1234567890ABCDEF"
content_case credential-or-key "-----""BEGIN RSA PRIVATE KEY""-----"

# Allowed placeholders, public words, Meridian snapshot word, and confirmed public email stay clean.
repo="$(fresh_repo placeholders)"
cat >"$repo/notes.md" <<EOF
HOME=/home/u
/Users/runner/work
C:\Users\Public\Documents
C:\Users\runneradmin\work
eos_token_id = 2
EOS2 marker
/home/ubuntu
$SAMPLE_HOME_PATH
Meridian public snapshot reference
Maple <hzlhu@qq.com>
version 172.15.0.1 and 172.32.0.1 and 100.63.0.1 and 100.128.0.1
https://nebula.zleo.ai/projects/meridian
EOF
stage_all "$repo"
expect_clean "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

# Symlink handling (exercised whenever the host filesystem supports POSIX symlinks).
repo="$(fresh_repo samplehome-symlink)"
if ln -s "$SAMPLE_HOME_PATH" "$repo/link" 2>/dev/null && [ -L "$repo/link" ]; then
  stage_all "$repo"
  expect_clean "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

  repo="$(fresh_repo symlink)"
  ln -s "$HOME_PATH" "$repo/link"
  stage_all "$repo"
  expect_rule private-home-path "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"
fi

# UTF-16 text is decoded (generated via Python so Windows Git Bash needs no iconv).
repo="$(fresh_repo utf16)"
"$PYTHON" -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_bytes(("fixes " + sys.argv[2] + "\n").encode("utf-16"))' \
  "$(to_native_path "$repo/notes.txt")" "$BOARD_ID"
stage_all "$repo"
expect_rule internal-board-id "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

# Oversized files are reported instead of silently skipped.
repo="$(fresh_repo large)"
"$PYTHON" -c 'import pathlib, sys; pathlib.Path(sys.argv[1]).write_bytes(b"a" * 3000000)' \
  "$(to_native_path "$repo/big.txt")"
stage_all "$repo"
expect_clean "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"
grep -q '::warning::.*not scanned' "$TEMP_ROOT/out" || {
  echo "public boundary test: oversized file must be reported" >&2
  exit 1
}

# Untracked files are not part of the public tree.
repo="$(fresh_repo untracked)"
stage_all "$repo"
printf 'fixes %s\n' "$BOARD_ID" >"$repo/scratch.md"
expect_clean "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

# Path rules.
repo="$(fresh_repo deliver)"
printf 'hand-off\n' >"$repo/DELIVER""-RESULT.md"
stage_all "$repo"
expect_rule delivery-note "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

repo="$(fresh_repo pathid)"
mkdir -p "$repo/tests"
printf '// test\n' >"$repo/tests/eos""652_p2.mjs"
stage_all "$repo"
expect_rule internal-board-id-in-path "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

repo="$(fresh_repo eostoken)"
mkdir -p "$repo/t"
printf '{}\n' >"$repo/t/v.eos2.json"
stage_all "$repo"
expect_clean "$PYTHON" "$SCRIPT" --root "$(to_native_path "$repo")"

# Pull request metadata: title, body, branch name, and commits all fail strictly.
repo="$(fresh_repo pr)"
stage_all "$repo"
repo_native="$(to_native_path "$repo")"
expect_clean env PR_TITLE="docs: $SAMPLE_HOME_PATH" PR_BODY="Example: $SAMPLE_HOME_PATH" PR_HEAD_REF="fix/self-hosted-activity-graph" \
  "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_rule private-home-path env PR_BODY="/home/""ubuntu-private/work" "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "pull request body:"
expect_rule internal-board-id env PR_TITLE="feat($BOARD_ID): x" "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "pull request title:"
expect_rule private-home-path env PR_BODY="see $HOME_PATH" "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "pull request body:"
expect_rule internal-board-id env PR_HEAD_REF="feat/$BOARD_ID-fix" "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "pull request branch:"
expect_rule agent-handoff-metadata env PR_HEAD_REF="fix/dispatch=""ctx_abc123" "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "pull request branch:"

# Commit messages and emails in base..head are checked.
git -C "$repo" -c user.name=Maple -c user.email=hzlhu@qq.com commit -q -m "base"
base="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" -c user.name=Maple -c user.email=hzlhu@qq.com commit -q --allow-empty -m "docs: $SAMPLE_HOME_PATH"
expect_clean env PR_BASE_SHA="$base" PR_HEAD_SHA="$(git -C "$repo" rev-parse HEAD)" \
  "$PYTHON" "$SCRIPT" --root "$repo_native"

base="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" -c user.name=Maple -c user.email=hzlhu@qq.com commit -q --allow-empty -m "path=/home/""ubuntu-private/work"
expect_rule private-home-path env PR_BASE_SHA="$base" PR_HEAD_SHA="$(git -C "$repo" rev-parse HEAD)" \
  "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "message:"

base="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" -c user.name=Maple -c user.email=hzlhu@qq.com commit -q --allow-empty -m "fix($BOARD_ID): x"
expect_rule internal-board-id env PR_BASE_SHA="$base" PR_HEAD_SHA="$(git -C "$repo" rev-parse HEAD)" \
  "$PYTHON" "$SCRIPT" --root "$repo_native"
expect_label "message:"

echo "public boundary tests passed"
