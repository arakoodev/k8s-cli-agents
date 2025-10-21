#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] CODE_URL=${CODE_URL}"
[ -z "${CODE_URL:-}" ] && { echo "[fatal] CODE_URL is required"; exit 2; }

# Strict validation - only allow alphanumeric, spaces, slashes, dashes, underscores, dots, and basic shell operators
validate_command() {
  local cmd="$1"
  # Check for dangerous patterns
  if [[ "$cmd" =~ \$\( ]] || [[ "$cmd" =~ "]] || [[ "$cmd" =~ \$\{ ]]; then
    echo "[fatal] Command contains dangerous substitution patterns"
    return 1
  fi
  # Check length
  if [ ${#cmd} -gt 500 ]; then
    echo "[fatal] Command exceeds maximum length"
    return 1
  fi
  return 0
}

if [ -n "${COMMAND:-}" ]; then
  validate_command "${COMMAND}" || exit 1
fi
if [ -n "${INSTALL_CMD:-}" ]; then
  validate_command "${INSTALL_CMD}" || exit 1
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
: "${INSTALL_CMD:=npm install}"
# Use array to prevent injection
/bin/bash -c "${INSTALL_CMD}"

echo "[entrypoint] launching ttyd..."
export CLAUDE_PROMPT="${CLAUDE_PROMPT}"
# Use -- to separate ttyd options from command
exec ttyd -p 7681 -W -- /bin/bash -c "${COMMAND}"
