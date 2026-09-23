#!/bin/bash
# Agent-operational tooling for building this repo's Docker images inside a
# GitHub Codespace over SSH - not a product-engineering convention other
# contributors need, so it stays out of the product's own scripts/.
#
# Exists because the same disk-exhaustion failure recurred multiple times
# before this was written, each time recovered with an ad hoc, and once
# destructive, prune. This is the standing fix: a checked script instead of
# a rule that has to be remembered and applied correctly under pressure.
# Use it instead of hand-typed `docker compose build`/prune sequences.
#
# Usage: codespace-safe-build.sh <compose-file> <service> [extra compose build args...]

set -euo pipefail

COMPOSE_FILE="${1:?usage: codespace-safe-build.sh <compose-file> <service> [args...]}"
SERVICE="${2:?usage: codespace-safe-build.sh <compose-file> <service> [args...]}"
shift 2

DISK_FLOOR_KB=$((20 * 1024 * 1024)) # 20GB, in df's 1K-block units
LOG_DIR="$(dirname "$COMPOSE_FILE")/.build-logs"
LOG_FILE="$LOG_DIR/${SERVICE}-$(date +%Y%m%d-%H%M%S).log"

# Refuse to run if a build is already active: pruning (below) while a build
# is running has corrupted in-progress builds before (containerd-overlayfs
# snapshot removed out from under a build that still needed it transiently) -
# unrelated errors like "failed to apply diff: no such file or directory".
if pgrep -f "docker compose .*build" >/dev/null 2>&1; then
	echo "REFUSING: a docker compose build is already running (pgrep matched). Wait for it or investigate before retrying." >&2
	exit 1
fi

free_kb() {
	df --output=avail -k / | tail -1 | tr -d ' '
}

avail=$(free_kb)
if [ "$avail" -lt "$DISK_FLOOR_KB" ]; then
	echo "Disk below 20GB floor (${avail}KB free) - pruning least-destructive first (dangling images + stopped containers)." >&2
	docker container prune -f
	docker image prune -f
	avail=$(free_kb)
	if [ "$avail" -lt "$DISK_FLOOR_KB" ]; then
		echo "Still below floor (${avail}KB free) after dangling-only prune. Escalating to a FULL prune (-af) - this destroys the classic builder's own layer cache, so the next build from here is a full rebuild, not incremental." >&2
		docker image prune -af
	fi
fi

mkdir -p "$LOG_DIR"
echo "Building service '$SERVICE' from $COMPOSE_FILE - log: $LOG_FILE"

# Capture the REAL exit code via PIPESTATUS, not tail's - a genuinely failed
# build once reported "exited with code 0" to the calling harness because a
# `| tail` pipe's exit status is the last command's (tail's), not the
# build's. Piping through tee (not tail) for a bounded, current view while
# preserving the true build exit status.
DOCKER_BUILDKIT=0 COMPOSE_DOCKER_CLI_BUILD=0 \
	docker compose -f "$COMPOSE_FILE" build "$SERVICE" "$@" 2>&1 | tee "$LOG_FILE"
build_status="${PIPESTATUS[0]}"

if [ "$build_status" -ne 0 ]; then
	echo "BUILD FAILED (exit $build_status) - see $LOG_FILE" >&2
	exit "$build_status"
fi

echo "Build succeeded - log: $LOG_FILE"
