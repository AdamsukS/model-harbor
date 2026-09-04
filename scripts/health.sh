#!/usr/bin/env bash

set -euo pipefail
# shellcheck source=common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"

curl -fsS "${OLLAMA_BASE_URL}/api/tags" >/dev/null
printf 'ollama: ready\n'
curl -fsS "${PLASMOD_BASE_URL}/healthz" >/dev/null
printf 'plasmod: ready\n'
curl -fsS "http://${MODEL_HARBOR_HOST}:${MODEL_HARBOR_PORT}/readyz"
printf '\nmodel-harbor: ready\n'
