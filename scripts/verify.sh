#!/usr/bin/env bash
# Fast local verification that mirrors CI checks without forcing dependency install.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/ci-common.sh
source "$SCRIPT_DIR/lib/ci-common.sh"

ROOT="$(repo_root)"
cd "$ROOT"

PM="$(detect_package_manager)"
ci_notice "Detected package manager: $PM"

for script in lint typecheck test; do
  ci_group "Run $script"
  run_package_script_if_present "$PM" "$script"
  ci_endgroup
done
