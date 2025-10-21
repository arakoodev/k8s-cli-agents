#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] CODE_URL=${CODE_URL}"
[ -z "${CODE_URL:-}" ] && { echo "[fatal] CODE_URL is required"; exit 2; }

# Basic validation to prevent command injection.
# This is not foolproof and should be improved with more robust validation.
if [[ "${COMMAND:-}" =~ [;&|] ]]; then
  echo "[fatal] Invalid characters in COMMAND"
  exit 1
fi

cd /work
case "$CODE_URL" in
  *.zip)  curl -fL "$CODE_URL" -o bundle.zip ;;
  *.tgz|*.tar.gz) curl -fL "$CODE_URL" -o bundle.tgz ;;
  *.git|*.git*) git clone --depth=1 "$CODE_URL" src ;;
  *)
    echo "[warning] Unknown file extension, assuming zip"
    curl -fL "$CODE_URL" -o bundle.zip ;;
esac

if [ -n "${CODE_CHECKSUM_SHA256:-}" ]; then
  if [ -f bundle.zip ]; then
    echo "${CODE_CHECKSUM_SHA256}  bundle.zip" | sha256sum -c -
  elif [ -f bundle.tgz ]; then
    echo "${CODE_CHECKSUM_SHA256}  bundle.tgz" | sha256sum -c -
  fi
fi

mkdir -p src
if [ -f bundle.zip ]; then unzip -q bundle.zip -d src || { echo "unzip failed"; exit 3; }; fi
if [ -f bundle.tgz ]; then tar -xzf bundle.tgz -C src --strip-components=1 || tar -xzf bundle.tgz -C src; fi

cd /work/src
# If the archive contains a single directory, cd into it.
if [ $(ls -1 | wc -l) -eq 1 ] && [ -d "$(ls -1 | head -n1)" ]; then
  cd "$(ls -1 | head -n1)"
fi

echo "[entrypoint] installing...";
# Default INSTALL_CMD to 'npm install' if not set
: "${INSTALL_CMD:=npm install}"
bash -lc "${INSTALL_CMD}"

echo "[entrypoint] launching ttyd..."
export CLAUDE_PROMPT="${CLAUDE_PROMPT}"
exec ttyd -p 7681 bash -lc "${COMMAND}"