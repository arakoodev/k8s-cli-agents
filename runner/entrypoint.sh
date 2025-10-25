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
mkdir -p src

case "$CODE_URL" in
  *github.com/*/tree/*)
    # GitHub tree URL: https://github.com/owner/repo/tree/ref/folder
    echo "[entrypoint] Detected GitHub tree URL, extracting folder..."

    # Parse URL components
    GITHUB_REGEX="github.com/([^/]+)/([^/]+)/tree/([^/]+)/(.+)"
    if [[ "$CODE_URL" =~ $GITHUB_REGEX ]]; then
      OWNER="${BASH_REMATCH[1]}"
      REPO="${BASH_REMATCH[2]}"
      REF="${BASH_REMATCH[3]}"
      FOLDER="${BASH_REMATCH[4]}"

      echo "[entrypoint] Owner: $OWNER, Repo: $REPO, Ref: $REF, Folder: $FOLDER"

      # Download tarball and extract specific folder
      curl -fL "https://api.github.com/repos/$OWNER/$REPO/tarball/$REF" | \
        tar xz --wildcards "*/$FOLDER" --strip-components=1 -C /work/src || {
        echo "[fatal] Failed to download/extract GitHub tree folder"
        exit 3
      }

      echo "[entrypoint] Successfully extracted $FOLDER from GitHub"
      # Skip checksum validation for GitHub tree URLs
      CODE_CHECKSUM_SHA256=""
    else
      echo "[fatal] Could not parse GitHub tree URL"
      exit 3
    fi
    ;;
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

# Extract archives (GitHub tree URLs already extracted)
if [ -f bundle.zip ]; then unzip -q bundle.zip -d src || { echo "unzip failed"; exit 3; }; fi
if [ -f bundle.tgz ]; then tar -xzf bundle.tgz -C src --strip-components=1 || tar -xzf bundle.tgz -C src; fi

cd /work/src
# If the archive contains a single directory, cd into it.
# (Skip this for GitHub tree URLs as they're already in the right place)
if [ -z "$FOLDER" ] && [ $(ls -1 | wc -l) -eq 1 ] && [ -d "$(ls -1 | head -n1)" ]; then
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
