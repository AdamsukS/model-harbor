#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

stop_managed model-harbor 'dist/src/main.js'
stop_managed plasmod "$BIN_DIR/plasmod"
stop_managed ollama 'ollama serve'
printf 'Managed ModelHarbor processes stopped. Data and models were preserved.\n'
