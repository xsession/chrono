#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
repo="$root/repo"
git init -q -b main "$repo"
git -C "$repo" config user.name "Chrono Test"
git -C "$repo" config user.email "chrono@example.test"
echo base > "$repo/base.txt"
git -C "$repo" add base.txt
git -C "$repo" commit -qm "base"
base=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" switch -qc feature

echo a > "$repo/a.txt"; git -C "$repo" add a.txt; git -C "$repo" commit -qm "A commit"; A=$(git -C "$repo" rev-parse HEAD)
echo b > "$repo/b.txt"; git -C "$repo" add b.txt; git -C "$repo" commit -qm "B commit"; B=$(git -C "$repo" rev-parse HEAD)
echo c > "$repo/c.txt"; git -C "$repo" add c.txt; git -C "$repo" commit -qm "C commit"; C=$(git -C "$repo" rev-parse HEAD)
echo d > "$repo/d.txt"; git -C "$repo" add d.txt; git -C "$repo" commit -qm "D commit"; D=$(git -C "$repo" rev-parse HEAD)
# Keep another branch on a commit in the rewrite range so --update-refs can be verified.
git -C "$repo" branch marker "$C"
marker_before=$(git -C "$repo" rev-parse marker)

# Equivalent to the Rust planner: inject an exact todo through GIT_SEQUENCE_EDITOR.
todo="$root/todo"
editor="$root/editor.sh"
cat > "$todo" <<PLAN
pick $C C commit
exec git commit --amend -m 'C renamed'
update-ref refs/heads/marker
pick $A A commit
squash $B B commit
drop $D D commit
PLAN
cat > "$editor" <<'SH'
#!/bin/sh
cat "$CHRONO_REBASE_TODO" > "$1"
SH
chmod +x "$editor"
CHRONO_REBASE_TODO="$todo" GIT_SEQUENCE_EDITOR="sh '$editor'" GIT_EDITOR=true git -C "$repo" rebase -i --update-refs --onto "$base" "$base" >/dev/null

count=$(git -C "$repo" rev-list --count "$base"..HEAD)
[[ "$count" == "2" ]] || { echo "FAIL expected 2 rewritten commits, got $count"; exit 1; }
subjects=$(git -C "$repo" log --reverse --format=%s "$base"..HEAD)
grep -qx "C renamed" <<<"$(head -n1 <<<"$subjects")" || { echo "FAIL reword"; exit 1; }
[[ -f "$repo/a.txt" && -f "$repo/b.txt" && -f "$repo/c.txt" ]] || { echo "FAIL expected files after reorder/squash"; exit 1; }
[[ ! -e "$repo/d.txt" ]] || { echo "FAIL dropped commit still present"; exit 1; }
marker_after=$(git -C "$repo" rev-parse marker)
[[ "$marker_after" != "$marker_before" ]] || { echo "FAIL --update-refs did not move related branch"; exit 1; }
[[ "$(git -C "$repo" show -s --format=%s marker)" == "C renamed" ]] || { echo "FAIL updated marker does not follow rewritten C commit"; exit 1; }

echo "PASS reorder/reword/squash/drop/update-refs"

# Edit/pause behavior must leave Git in a rebase operation that normal Continue can finish.
git -C "$repo" switch -q main
git -C "$repo" switch -qc edit-case
echo e > "$repo/e.txt"; git -C "$repo" add e.txt; git -C "$repo" commit -qm "E commit"; E=$(git -C "$repo" rev-parse HEAD)
echo f > "$repo/f.txt"; git -C "$repo" add f.txt; git -C "$repo" commit -qm "F commit"; F=$(git -C "$repo" rev-parse HEAD)
cat > "$todo" <<PLAN
edit $E E commit
pick $F F commit
PLAN
set +e
CHRONO_REBASE_TODO="$todo" GIT_SEQUENCE_EDITOR="sh '$editor'" GIT_EDITOR=true git -C "$repo" rebase -i --onto "$base" "$base" >/dev/null 2>&1
status=$?
set -e
# Git may return zero for an intentional edit stop on some versions; state on disk is authoritative.
[[ -d "$repo/.git/rebase-merge" || -d "$repo/.git/rebase-apply" ]] || { echo "FAIL edit did not pause rebase (exit $status)"; exit 1; }
GIT_EDITOR=true git -C "$repo" rebase --continue >/dev/null
[[ ! -d "$repo/.git/rebase-merge" && ! -d "$repo/.git/rebase-apply" ]] || { echo "FAIL rebase did not continue"; exit 1; }
[[ "$(git -C "$repo" rev-list --count "$base"..HEAD)" == "2" ]] || { echo "FAIL edit-case commit count"; exit 1; }

echo "PASS edit/pause/continue"
echo "PASS interactive rebase planner smoke suite"
