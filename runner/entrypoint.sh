#!/usr/bin/env bash
set -euo pipefail
echo "[entrypoint] CODE_URL=${CODE_URL}"
[ -z "${CODE_URL:-}" ] && { echo "[fatal] CODE_URL is required"; exit 2; }
cd /work
case "$CODE_URL" in
  *.zip)  curl -fL "$CODE_URL" -o bundle.zip ;;
  *.tgz|*.tar.gz) curl -fL "$CODE_URL" -o bundle.tgz ;;
  *.git|*.git*) git clone --depth=1 "$CODE_URL" src ;;
  *) curl -fL "$CODE_URL" -o bundle.zip ;;
esac
if [ -n "${CODE_CHECKSUM_SHA256:-}" ] && [ -f bundle.zip ]; then
  echo "${CODE_CHECKSUM_SHA256}  bundle.zip" | sha256sum -c -
fi
mkdir -p src
if [ -f bundle.zip ]; then unzip -q bundle.zip -d src || { echo "unzip failed"; exit 3; }; fi
if [ -f bundle.tgz ]; then tar -xzf bundle.tgz -C src --strip-components=0 || tar -xzf bundle.tgz -C src; fi
cd /work/src; [ $(ls -1 | wc -l) -eq 1 ] && [ -d "$(ls -1 | head -n1)" ] && cd "$(ls -1 | head -n1)"
echo "[entrypoint] installing..."; bash -lc "${INSTALL_CMD}"
echo "[entrypoint] launching ttyd..." ; export CLAUDE_PROMPT="${CLAUDE_PROMPT}" ; exec ttyd -p 7681 bash -lc "${COMMAND}"
