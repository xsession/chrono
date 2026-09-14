#!/usr/bin/env bash
set -euo pipefail
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
repo="$root/repo"
git init -q -b main "$repo"
git -C "$repo" config user.name "Alice"
git -C "$repo" config user.email "alice@example.test"
mkdir -p "$repo/src"
printf 'alpha\nbeta\ngamma\n' > "$repo/src/app.txt"
git -C "$repo" add .
git -C "$repo" commit -qm "initial parser"
base=$(git -C "$repo" rev-parse HEAD)

git -C "$repo" switch -qc feature
sed -i '2s/beta/BETA_TIMEOUT/' "$repo/src/app.txt"
git -C "$repo" commit -qam "fix timeout parser"
feature1=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" config user.name "Bob"
git -C "$repo" config user.email "bob@example.test"
printf 'delta\n' >> "$repo/src/app.txt"
git -C "$repo" commit -qam "extend parser"
feature2=$(git -C "$repo" rev-parse HEAD)

git -C "$repo" switch -q main
git -C "$repo" config user.name "Alice"
git -C "$repo" config user.email "alice@example.test"
echo docs > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm "document parser"
main2=$(git -C "$repo" rev-parse HEAD)

# Search primitives used by Git Intelligence.
git -C "$repo" log --all --grep='timeout' --format=%H | grep -qx "$feature1"
git -C "$repo" log --all --author='Bob' --format=%H | grep -qx "$feature2"
# @me prefers the configured email, avoiding regex ambiguity between name/email.
git -C "$repo" log --all --author='alice@example.test' --format=%H | grep -q "$base"
git -C "$repo" log --all --format=%H -- src/app.txt | grep -q "$feature2"
git -C "$repo" log --all -G'TIMEOUT' --format=%H | grep -qx "$feature1"
echo "PASS rich commit search primitives"

# Common-base comparison semantics.
mb=$(git -C "$repo" merge-base main feature)
[[ "$mb" == "$base" ]] || { echo "FAIL merge base"; exit 1; }
counts=$(git -C "$repo" rev-list --left-right --count main...feature)
[[ "$counts" == $'1\t2' || "$counts" == '1  2' || "$counts" =~ ^1[[:space:]]+2$ ]] || { echo "FAIL compare counts: $counts"; exit 1; }
git -C "$repo" diff --numstat "$mb..feature" | grep -q 'src/app.txt'
echo "PASS merge-base compare"

# File and line history.
[[ "$(git -C "$repo" log feature --format=%H -- src/app.txt | wc -l)" -ge 3 ]]
git -C "$repo" log -L 2,2:src/app.txt feature --format=%H --no-patch | grep -q "$feature1"
echo "PASS file and line history"

# Blame porcelain must expose author, summary and content per line.
blame=$(git -C "$repo" blame --line-porcelain feature -- src/app.txt)
grep -q '^author Bob$' <<<"$blame"
grep -q '^summary extend parser$' <<<"$blame"
grep -q $'^\tdelta$' <<<"$blame"
echo "PASS blame porcelain"

# Contributor aggregation source data.
people=$(git -C "$repo" log --all --format='%an%x1f%ae%x1f%aI%x1e')
grep -q 'Alice' <<<"$people"
grep -q 'Bob' <<<"$people"
echo "PASS contributor log"

# Multi-worktree WIP model.
wt="$root/feature-wt"
git -C "$repo" worktree add -q "$wt" feature
echo dirty >> "$wt/src/app.txt"
porcelain=$(git -C "$repo" worktree list --porcelain)
grep -q "worktree $wt" <<<"$porcelain"
[[ -n "$(git -C "$wt" status --porcelain=v1)" ]]
echo "PASS multi-worktree WIP primitives"

echo "PASS Git Intelligence smoke suite"
