#!/usr/bin/env bash
# =============================================================================
# The data files live on their own branch, "data", WITHOUT history.
#
# Every robot (weekly cards, daily prices, art fingerprints, metagame) used to
# commit its output to main, and git keeps every old copy forever: ~14 MB a
# week of history nobody needs. Now each run
#
#   pull   puts the current data files in ./data (from the data branch; the
#          very first time, from the copies still in main),
#   ...    the build reads and writes ./data (OUT_DIR=data),
#   push   replaces the data branch with ONE fresh commit holding ./data --
#          force-pushed, so the branch never grows -- and, once the site
#          passes the files through (_redirects), takes the old copies out
#          of main.
#
# The site keeps serving the same addresses (/prices-slim.tsv.gz, ...):
# Netlify passes them through to raw.githubusercontent.com/<repo>/data/...,
# see _redirects. The app and the Android app need no change.
#
# All workflows share the concurrency group "bulk-data", so two of them never
# pull and push the branch at the same time.
# =============================================================================
set -euo pipefail

FILES="oracle-slim.jsonl.gz rulings-slim.jsonl.gz bulk-meta.json tags-slim.jsonl.gz tags-index.json combos-slim.jsonl.gz prices-slim.tsv.gz prices-meta.json arthash.tsv.gz arthash-meta.json meta.json"
DATA_DIR="${DATA_DIR:-data}"
STAMP=".data-before.sha"

sums(){ ( cd "$DATA_DIR" && find . -maxdepth 1 -type f ! -name '.*' -printf '%f\n' | sort | xargs -r sha256sum ) || true; }

case "${1:-}" in
  pull)
    rm -rf "$DATA_DIR"; mkdir -p "$DATA_DIR"
    # "Not there" (exit 2) and "GitHub had a hiccup" (anything else) are very
    # different: only the first may start a new branch from main's copies.
    if git ls-remote --exit-code --heads origin data >/dev/null; then rc=0; else rc=$?; fi
    if [ "$rc" = "0" ]; then
      git fetch --quiet --depth=1 origin data
      git archive FETCH_HEAD | tar -x -C "$DATA_DIR"
      echo "Data branch found: $(ls "$DATA_DIR" | wc -l) files."
      echo "yes" > "$DATA_DIR/.had-branch"
    elif [ "$rc" != "2" ]; then
      echo "::error::Could not ask GitHub for the data branch (exit $rc). Stopping, nothing touched."
      exit 1
    else
      for f in $FILES; do [ -f "$f" ] && cp "$f" "$DATA_DIR/"; done
      echo "No data branch yet: starting it from the $(ls "$DATA_DIR" | wc -l) files in main."
    fi
    sums > "$DATA_DIR/$STAMP"
    ;;

  push)
    msg="${2:-Data update}"
    git config user.name  "deckhand-bot"
    git config user.email "deckhand-bot@users.noreply.github.com"
    had="no"; [ -f "$DATA_DIR/.had-branch" ] && had="yes"
    before="$(cat "$DATA_DIR/$STAMP" 2>/dev/null || true)"
    rm -f "$DATA_DIR/$STAMP" "$DATA_DIR/.had-branch"
    after="$(sums)"
    # A build only adds or replaces files. One that vanished means something
    # went wrong; never publish a branch with less in it than before.
    lost=""
    for f in $(printf '%s\n' "$before" | awk 'NF==2{print $2}'); do
      [ -f "$DATA_DIR/$f" ] || lost="$lost $f"
    done
    if [ -n "$lost" ]; then
      echo "::error::These files were there before the build and are gone now:$lost. Not publishing."
      exit 1
    fi
    if [ "$had" = "yes" ] && [ "$before" = "$after" ]; then
      echo "Nothing changed: the data branch stays as it is."
    else
      # One commit, no parent: the branch is replaced, never extended.
      idx="$(mktemp)"; rm -f "$idx"     # git wants to create the index itself
      GIT_INDEX_FILE="$idx" git --work-tree="$DATA_DIR" add -A .
      tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
      rm -f "$idx"
      commit="$(git commit-tree "$tree" -m "$msg — $(date -u +%Y-%m-%d)")"
      git push --quiet --force origin "$commit:refs/heads/data"
      echo "Data branch replaced: $(ls "$DATA_DIR" | wc -l) files, one commit."
    fi

    # Once the site passes the files through, the old copies leave main.
    if grep -q "raw.githubusercontent.com" _redirects 2>/dev/null; then
      branch="${GITHUB_REF_NAME:-main}"
      for attempt in 1 2 3 4 5; do
        present=""
        for f in $FILES; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 && present="$present $f"; done
        [ -z "$present" ] && { echo "Main holds no data files."; break; }
        git rm -q --cached $present
        git commit -q -m "Data files moved to the data branch (no more history)"
        if git push --quiet origin "HEAD:$branch"; then echo "Removed from main:$present"; break; fi
        echo "Main moved on; trying again ($attempt/5)."
        git fetch --quiet --depth=1 origin "$branch"
        git reset -q --hard FETCH_HEAD
        sleep $((attempt * 5))
      done
    fi
    ;;

  *)
    echo "usage: $0 pull | push \"message\"" >&2; exit 2 ;;
esac
