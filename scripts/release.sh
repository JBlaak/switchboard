#!/usr/bin/env bash
# Cut a release: bump the version, tag it, push, wait for the build, publish.
#
#   make release
#
# Versions are 2.<minor>.<patch>. The first release is 2.0.0; after that it
# asks whether this one is a patch or a minor. Pushing the v* tag is what makes
# CI build and attach the DMGs and zips to a *draft* release;
# the running apps only see a release once it is published, which is the last
# step here.
set -euo pipefail

REPO="JBlaak/switchboard"
MAJOR=2

die() { echo "release: $*" >&2; exit 1; }
ask() { local reply; read -r -p "$1 [y/N] " reply; [[ "$reply" =~ ^[Yy]$ ]]; }

cd "$(git rev-parse --show-toplevel)"

# ── Preconditions ──
[[ "$(git branch --show-current)" == "main" ]] || die "not on main"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "uncommitted changes"
git fetch --quiet --tags origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || die "main is not in sync with origin/main"
command -v gh >/dev/null || die "gh is not installed"

# ── Next version ──
previous="$(git tag --list "v${MAJOR}.*" --sort=-v:refname | head -n1)"
if [[ -z "$previous" ]]; then
  next="${MAJOR}.0.0"
  echo "No v${MAJOR}.x release yet; this one is v${next}."
else
  IFS=. read -r _ minor patch <<<"${previous#v}"
  echo "Latest release: ${previous}"
  read -r -p "Patch (${MAJOR}.${minor}.$((patch + 1))) or minor (${MAJOR}.$((minor + 1)).0)? [p/m] " kind
  case "$kind" in
    p|P|patch) next="${MAJOR}.${minor}.$((patch + 1))" ;;
    m|M|minor) next="${MAJOR}.$((minor + 1)).0" ;;
    *) die "answer p or m" ;;
  esac
  log_range="${previous}..HEAD"
  echo
  echo "Changes since ${previous}:"
  git log --oneline --no-merges "$log_range" | sed 's/^/  /'
  [[ -n "$(git log --oneline "$log_range")" ]] || die "nothing to release since ${previous}"
fi
tag="v${next}"
git rev-parse --quiet --verify "refs/tags/${tag}" >/dev/null && die "${tag} already exists"

echo
ask "Release ${tag}?" || die "cancelled"

# ── Bump, tag, push ──
npm version "$next" --no-git-tag-version >/dev/null
git commit --quiet -m "${tag}" -- package.json package-lock.json
git tag -a "$tag" -m "$tag"
git push --quiet origin main
git push --quiet origin "$tag"
echo "Pushed ${tag}."

# ── Wait for the build ──
echo "Waiting for the build to start…"
run_id=""
for _ in $(seq 1 30); do
  run_id="$(gh run list --repo "$REPO" --workflow build.yml --branch "$tag" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 5
done
[[ -n "$run_id" ]] || die "no build appeared for ${tag}; check https://github.com/${REPO}/actions"
gh run watch "$run_id" --repo "$REPO" --exit-status || die "the build failed; ${tag} is tagged but not released"

# ── Publish ──
gh release view "$tag" --repo "$REPO" --json assets --jq '.assets[].name' | sed 's/^/  /'
if ask "Publish the draft release ${tag} now? Running apps will offer it as an update."; then
  notes_args=(-f "tag_name=${tag}")
  [[ -n "$previous" ]] && notes_args+=(-f "previous_tag_name=${previous}")
  notes="$(gh api "repos/${REPO}/releases/generate-notes" "${notes_args[@]}" --jq .body)"
  gh release edit "$tag" --repo "$REPO" --draft=false --notes "$notes" >/dev/null
  echo "Published https://github.com/${REPO}/releases/tag/${tag}"
else
  echo "Left as a draft. Publish it with:"
  echo "  gh release edit ${tag} --repo ${REPO} --draft=false --notes \"…\""
fi
