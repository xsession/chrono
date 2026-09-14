#!/usr/bin/env bash
set -euo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
cd "$ROOT"

git init -q
git config user.email test@example.com
git config user.name "Chrono UX Smoke"

# Merge conflict -> resolve -> continue.
echo base > conflict.txt
git add conflict.txt
git commit -qm base
git branch feature
echo main > conflict.txt
git commit -qam main-change
git checkout -q feature
echo feature > conflict.txt
git commit -qam feature-change
git checkout -q master
if git merge feature >/dev/null 2>&1; then
  echo "FAIL: merge unexpectedly completed without conflict" >&2
  exit 1
fi
GITDIR=$(git rev-parse --absolute-git-dir)
test -f "$GITDIR/MERGE_HEAD"
test "$(git diff --name-only --diff-filter=U | wc -l)" -eq 1
printf 'merged\n' > conflict.txt
git add conflict.txt
GIT_EDITOR=true git merge --continue >/dev/null
test ! -f "$GITDIR/MERGE_HEAD"
echo "PASS merge detect/conflict/continue"

# Rebase conflict -> skip.
echo base > rebase.txt
git add rebase.txt
git commit -qm rebase-base
git checkout -qb topic
echo topic > rebase.txt
git commit -qam topic-change
git checkout -q master
echo master > rebase.txt
git commit -qam master-change
git checkout -q topic
if git rebase master >/dev/null 2>&1; then
  echo "FAIL: rebase unexpectedly completed without conflict" >&2
  exit 1
fi
GITDIR=$(git rev-parse --absolute-git-dir)
test -d "$GITDIR/rebase-merge" -o -d "$GITDIR/rebase-apply"
test "$(git diff --name-only --diff-filter=U | wc -l)" -eq 1
GIT_EDITOR=true git rebase --skip >/dev/null
test ! -d "$GITDIR/rebase-merge" -a ! -d "$GITDIR/rebase-apply"
echo "PASS rebase detect/conflict/skip"

# Cherry-pick conflict -> abort.
git checkout -q master
echo base > cherry.txt
git add cherry.txt
git commit -qm cherry-base
git checkout -qb cherry-source
echo source > cherry.txt
git commit -qam cherry-source-change
CHERRY_COMMIT=$(git rev-parse HEAD)
git checkout -q master
echo target > cherry.txt
git commit -qam cherry-target-change
if git cherry-pick "$CHERRY_COMMIT" >/dev/null 2>&1; then
  echo "FAIL: cherry-pick unexpectedly completed without conflict" >&2
  exit 1
fi
GITDIR=$(git rev-parse --absolute-git-dir)
test -f "$GITDIR/CHERRY_PICK_HEAD"
test "$(git diff --name-only --diff-filter=U | wc -l)" -eq 1
git cherry-pick --abort >/dev/null
test ! -f "$GITDIR/CHERRY_PICK_HEAD"
echo "PASS cherry-pick detect/conflict/abort"

# Revert conflict -> abort.
echo base > revert.txt
git add revert.txt
git commit -qm revert-base
echo first > revert.txt
git commit -qam revert-first
REVERT_TARGET=$(git rev-parse HEAD)
echo later > revert.txt
git commit -qam revert-later
if GIT_EDITOR=true git revert "$REVERT_TARGET" >/dev/null 2>&1; then
  echo "FAIL: revert unexpectedly completed without conflict" >&2
  exit 1
fi
GITDIR=$(git rev-parse --absolute-git-dir)
test -f "$GITDIR/REVERT_HEAD"
test "$(git diff --name-only --diff-filter=U | wc -l)" -eq 1
git revert --abort >/dev/null
test ! -f "$GITDIR/REVERT_HEAD"
echo "PASS revert detect/conflict/abort"
