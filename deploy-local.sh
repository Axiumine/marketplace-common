#!/usr/bin/env bash
#
# Builds this package and copies the result into every consumer's node_modules.
#
# WHY THIS EXISTS
# ---------------
# `@axiumine/marketplace-common` is consumed as a published npm package. Every consumer resolves it
# from a copy under node_modules that was patched in place by hand. This script is that
# hand-patching, made repeatable: one command, the same result every time, no repo silently left on
# an older build.
#
# It replaces neither `npm publish` nor `yarn install`. It survives publication because it is what
# closes the gap *between* releases: an edit to src/ is not on the registry until someone publishes
# it, so without this every consumer keeps running the last published build with no error anywhere.
# Delete it only if the workspace ever stops consuming this package by name.
#
# RUN IT AFTER EVERY EDIT TO src/. Nothing else will: a consumer imports from its own node_modules
# copy, so an un-deployed change is invisible to all eight of them and the service keeps running the
# previous build with no error anywhere.
#
#   ./deploy-local.sh            build, then deploy to every consumer found
#   ./deploy-local.sh --dry-run  list what would be written, touch nothing
#   ./deploy-local.sh --no-build deploy the existing dist/ (only if you just built it yourself)
#
# It selects node itself — see the block below. Running it with whatever node happens to be on PATH
# is not a supported mode, because `engines.node` is a hard gate under yarn classic.

set -euo pipefail

PKG_NAME='@axiumine/marketplace-common'
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# marketplace-common → BEs → the workspace root that holds every repo.
ROOT="$(cd "$PKG_DIR/../.." && pwd)"

DRY_RUN=0
BUILD=1
for arg in "$@"; do
	case "$arg" in
		--dry-run) DRY_RUN=1 ;;
		--no-build) BUILD=0 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

# --------------------------------------------------------------------------------------------
# Node selection
#
# `engines.node` is a HARD gate under yarn classic — a mismatch aborts with `The engine "node" is
# incompatible with this module` and builds nothing, it is not a warning — and this machine's
# default node is older than the pin. Both git hooks in `.githooks/` already select node this way;
# this script needs the same, because it is started by hand and no hook runs before it.
#
# The wanted version is read from `.nvmrc` with plain `cat`, not through `node -p`, so the
# selection still works when there is no node on PATH at all — which is exactly the case nvm is
# there to fix. `package.json` stays the authority on what is acceptable: the check below reads
# `engines.node` through whichever node ended up selected, so a `.nvmrc` that has drifted out of
# the engine range fails here, with the two values named, instead of failing inside `yarn build`.
# --------------------------------------------------------------------------------------------
WANTED_NODE="$(tr -d 'v \t\r\n' < "$PKG_DIR/.nvmrc" 2> /dev/null || true)"

node_satisfies() {
	local current required
	current="$(node -v 2> /dev/null | tr -d 'v')"
	required="$(node -p "require('$PKG_DIR/package.json').engines.node" 2> /dev/null | tr -d '^~>= ')"
	[ -n "$current" ] && [ -n "$required" ] || return 1
	# caret semantics: same major, and not older than the pin.
	[ "${current%%.*}" = "${required%%.*}" ] || return 1
	[ "$(printf '%s\n%s\n' "$required" "$current" | sort -V | head -n 1)" = "$required" ]
}

if ! node_satisfies; then
	# nvm.sh trips over unbound variables, so -u comes off around the source.
	NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
	if [ -s "$NVM_SH" ] && [ -n "$WANTED_NODE" ]; then
		echo "==> node $(node -v 2> /dev/null || echo '(not found)') does not satisfy engines.node — switching to $WANTED_NODE via nvm"
		set +u
		# shellcheck disable=SC1090
		. "$NVM_SH" > /dev/null 2>&1 || true
		nvm use "$WANTED_NODE" > /dev/null 2>&1 || true
		set -u
	fi
fi

if ! node_satisfies; then
	{
		echo
		echo "deploy-local.sh: BLOCKED — node $(node -v 2> /dev/null || echo '(not found)') does not satisfy"
		echo "engines.node in package.json, and nvm could not be used to switch — either it is not installed"
		echo "at \${NVM_DIR:-\$HOME/.nvm}/nvm.sh, or ${WANTED_NODE:-the .nvmrc version} is not installed under it."
		echo
		echo 'Fix it with:'
		echo
		printf '    nvm install %s && nvm use %s\n' "${WANTED_NODE:-24.18.0}" "${WANTED_NODE:-24.18.0}"
		echo
	} >&2
	exit 1
fi

# --------------------------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------------------------
if [ "$BUILD" -eq 1 ]; then
	echo "==> yarn build"
	(cd "$PKG_DIR" && yarn build)
fi

if [ ! -d "$PKG_DIR/dist" ]; then
	echo "dist/ does not exist — run without --no-build" >&2
	exit 1
fi

VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
MAJOR="${VERSION%%.*}"
echo "==> deploying $PKG_NAME@$VERSION"

# --------------------------------------------------------------------------------------------
# Discover consumers
#
# By declaration, not by what happens to be installed: a repo that declares the dependency but has
# never had it installed is exactly the case that must not be skipped silently. maxdepth 4 covers
# `<root>/<repo>/package.json` and `<root>/BEs/dev/<repo>/package.json`, which is every repo here.
#
# `.stryker-tmp/` is excluded because a mutation run copies its whole repo into
# `.stryker-tmp/sandbox-XXXXXX/` — manifest included — and an interrupted run leaves those copies
# behind. They are throwaway duplicates of a repo already in this list, so deploying into them
# writes megabytes nothing imports and, worse, reports a consumer count higher than the number of
# repos that exist.
# --------------------------------------------------------------------------------------------
mapfile -t MANIFESTS < <(
	find "$ROOT" -maxdepth 4 -name package.json \
		-not -path '*/node_modules/*' \
		-not -path '*/.stryker-tmp/*' \
		-not -path "$PKG_DIR/*" \
		-exec grep -l "\"$PKG_NAME\"" {} \; | sort
)

if [ "${#MANIFESTS[@]}" -eq 0 ]; then
	echo "no consumer found under $ROOT — is the workspace layout still what this script assumes?" >&2
	exit 1
fi

DEPLOYED=0
for manifest in "${MANIFESTS[@]}"; do
	repo="$(dirname "$manifest")"
	dest="$repo/node_modules/$PKG_NAME"

	# The declared range and the built version have to agree, or the next `yarn install` in that repo
	# undoes this deployment — quietly, by fetching (or failing to fetch) something else. Four repos
	# were sitting on `^1.21.0` with a 3.0.0 copy installed when this script was written, which is
	# precisely the drift a by-hand patch produces and nothing reports.
	declared="$(node -p "
		const p = require('$manifest');
		(p.dependencies ?? {})['$PKG_NAME'] ?? (p.devDependencies ?? {})['$PKG_NAME'] ?? ''
	")"
	declared_major="$(printf '%s' "$declared" | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
	if [ -n "$declared" ] && [ "$declared_major" != "$MAJOR" ]; then
		echo "    !! $(basename "$repo") declares '$declared' but this is $VERSION — bump its package.json"
	fi

	if [ "$DRY_RUN" -eq 1 ]; then
		echo "    would write $dest"
		continue
	fi

	mkdir -p "$dest"
	# --delete so a file removed from dist/ disappears downstream too. Without it a deleted module
	# keeps resolving from the stale copy and the consumer never learns it is gone.
	rsync -a --delete "$PKG_DIR/dist/" "$dest/dist/"
	cp "$PKG_DIR/package.json" "$dest/package.json"

	echo "    -> $(basename "$repo")"
	DEPLOYED=$((DEPLOYED + 1))
done

if [ "$DRY_RUN" -eq 1 ]; then
	echo "==> dry run, nothing written (${#MANIFESTS[@]} consumers)"
else
	echo "==> deployed to $DEPLOYED consumer(s)"
	echo "    restart any running service — Node caches the module graph at import time."
fi
