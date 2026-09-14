#!/usr/bin/env bash
set -euo pipefail

export GIT_AUTHOR_NAME='Chrono Test'
export GIT_AUTHOR_EMAIL='chrono@example.test'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

new_repo() {
  local name="$1"
  local repo="$ROOT/$name"
  git init -q "$repo"
  git -C "$repo" config user.name "$GIT_AUTHOR_NAME"
  git -C "$repo" config user.email "$GIT_AUTHOR_EMAIL"
  printf '%s\n' "$repo"
}

assert_unmerged() {
  local repo="$1"
  test -n "$(git -C "$repo" ls-files --unmerged)"
}

assert_resolved() {
  local repo="$1"
  test -z "$(git -C "$repo" ls-files --unmerged)"
}

# 1. Standard content conflict exposes stages 1/2/3 and current-side checkout resolves it.
repo="$(new_repo content-current)"
printf 'base\n' > "$repo/file.txt"
git -C "$repo" add file.txt && git -C "$repo" commit -qm base
git -C "$repo" switch -qc incoming
printf 'incoming\n' > "$repo/file.txt" && git -C "$repo" commit -qam incoming
git -C "$repo" switch -q master
printf 'current\n' > "$repo/file.txt" && git -C "$repo" commit -qam current
if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 11; fi
assert_unmerged "$repo"
for stage in 1 2 3; do git -C "$repo" ls-files --unmerged | grep -q " $stage[[:space:]]"; done
git -C "$repo" checkout-index --stage=2 --force -- file.txt
grep -qx 'current' "$repo/file.txt"
git -C "$repo" add -A -- file.txt
assert_resolved "$repo"
printf 'PASS content conflict current-side resolution\n'

# 2. Manual merged output stages and clears the higher-order index entries.
repo="$(new_repo manual-merged)"
printf 'base\n' > "$repo/file.txt"
git -C "$repo" add file.txt && git -C "$repo" commit -qm base
git -C "$repo" switch -qc incoming
printf 'incoming\n' > "$repo/file.txt" && git -C "$repo" commit -qam incoming
git -C "$repo" switch -q master
printf 'current\n' > "$repo/file.txt" && git -C "$repo" commit -qam current
if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 12; fi
printf 'manual merged result\n' > "$repo/file.txt"
git -C "$repo" add -A -- file.txt
assert_resolved "$repo"
grep -qx 'manual merged result' "$repo/file.txt"
printf 'PASS manual merged output staging\n'

# 3. Add/add has no stage 1; selecting incoming stage 3 resolves correctly.
repo="$(new_repo add-add)"
printf 'seed\n' > "$repo/seed.txt"
git -C "$repo" add seed.txt && git -C "$repo" commit -qm base
git -C "$repo" switch -qc incoming
printf 'incoming add\n' > "$repo/new file.txt" && git -C "$repo" add 'new file.txt' && git -C "$repo" commit -qm incoming
git -C "$repo" switch -q master
printf 'current add\n' > "$repo/new file.txt" && git -C "$repo" add 'new file.txt' && git -C "$repo" commit -qm current
if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 13; fi
assert_unmerged "$repo"
test -z "$(git -C "$repo" ls-files --unmerged -- 'new file.txt' | awk '$3 == 1')"
git -C "$repo" checkout-index --stage=3 --force -- 'new file.txt'
git -C "$repo" add -A -- 'new file.txt'
assert_resolved "$repo"
grep -qx 'incoming add' "$repo/new file.txt"
printf 'PASS add/add incoming-side resolution\n'

# 4. Modify/delete supports accepting the missing side as deletion.
repo="$(new_repo modify-delete)"
printf 'base\n' > "$repo/file.txt"
git -C "$repo" add file.txt && git -C "$repo" commit -qm base
git -C "$repo" switch -qc incoming
printf 'incoming edit\n' > "$repo/file.txt" && git -C "$repo" commit -qam incoming
git -C "$repo" switch -q master
git -C "$repo" rm -q file.txt && git -C "$repo" commit -qm delete
if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 14; fi
assert_unmerged "$repo"
test -z "$(git -C "$repo" ls-files --unmerged -- file.txt | awk '$3 == 2')"
rm -f "$repo/file.txt"
git -C "$repo" add -A -- file.txt
assert_resolved "$repo"
test ! -e "$repo/file.txt"
printf 'PASS modify/delete deletion resolution\n'

# 5. Binary conflicts can be resolved by selecting an index side without text decoding.
repo="$(new_repo binary)"
printf 'A\0base\n' > "$repo/data.bin"
git -C "$repo" add data.bin && git -C "$repo" commit -qm base
git -C "$repo" switch -qc incoming
printf 'A\0incoming\n' > "$repo/data.bin" && git -C "$repo" commit -qam incoming
git -C "$repo" switch -q master
printf 'A\0current\n' > "$repo/data.bin" && git -C "$repo" commit -qam current
if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 15; fi
assert_unmerged "$repo"
git -C "$repo" checkout-index --stage=3 --force -- data.bin
git -C "$repo" add -A -- data.bin
assert_resolved "$repo"
cmp -s "$repo/data.bin" <(printf 'A\0incoming\n')
printf 'PASS binary incoming-side resolution\n'

# 6. Symlink conflict can use checkout-index side selection and preserve symlink mode.
if command -v readlink >/dev/null 2>&1; then
  repo="$(new_repo symlink)"
  ln -s base-target "$repo/link"
  git -C "$repo" add link && git -C "$repo" commit -qm base
  git -C "$repo" switch -qc incoming
  rm "$repo/link" && ln -s incoming-target "$repo/link" && git -C "$repo" add link && git -C "$repo" commit -qm incoming
  git -C "$repo" switch -q master
  rm "$repo/link" && ln -s current-target "$repo/link" && git -C "$repo" add link && git -C "$repo" commit -qm current
  if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 16; fi
  assert_unmerged "$repo"
  git -C "$repo" checkout-index --stage=2 --force -- link
  test "$(readlink "$repo/link")" = 'current-target'
  git -C "$repo" add -A -- link
  assert_resolved "$repo"
  printf 'PASS symlink current-side resolution\n'
fi


# 7. Submodule gitlink conflicts are resolved in the index by selecting a commit side.
repo="$(new_repo gitlink-super)"
sub="$ROOT/gitlink-sub"
git init -q "$sub"
git -C "$sub" config user.name "$GIT_AUTHOR_NAME"
git -C "$sub" config user.email "$GIT_AUTHOR_EMAIL"
printf 'base\n' > "$sub/f" && git -C "$sub" add f && git -C "$sub" commit -qm base
base_oid="$(git -C "$sub" rev-parse HEAD)"
git -C "$sub" switch -qc incoming
printf 'incoming\n' > "$sub/f" && git -C "$sub" commit -qam incoming
incoming_oid="$(git -C "$sub" rev-parse HEAD)"
git -C "$sub" switch -q master
printf 'current\n' > "$sub/f" && git -C "$sub" commit -qam current
current_oid="$(git -C "$sub" rev-parse HEAD)"

git -C "$sub" checkout -q "$base_oid"
git -C "$repo" -c protocol.file.allow=always submodule add -q "$sub" sm
git -C "$repo" commit -qam base
git -C "$repo" switch -qc incoming
git -C "$repo/sm" checkout -q "$incoming_oid"
git -C "$repo" add sm && git -C "$repo" commit -qm incoming
git -C "$repo" switch -q master
git -C "$repo/sm" checkout -q "$current_oid"
git -C "$repo" add sm && git -C "$repo" commit -qm current
if git -C "$repo" merge incoming >/dev/null 2>&1; then exit 17; fi
assert_unmerged "$repo"
read -r mode oid stage _ < <(git -C "$repo" ls-files --unmerged -- sm | awk '$3 == 3 {print $1, $2, $3, $4}')
test "$mode" = '160000'
test "$oid" = "$incoming_oid"
git -C "$repo" update-index --add --cacheinfo "$mode" "$oid" sm
assert_resolved "$repo"
test "$(git -C "$repo" ls-files -s -- sm | awk '{print $2}')" = "$incoming_oid"
printf 'PASS submodule gitlink incoming-side index resolution\n'
