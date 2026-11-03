#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Cursor profile install hook. Called by provision.sh as root.
#
# Usage: install.sh <CONTAINER_USER> <CONTAINER_HOME>
#
# The upstream installer (https://cursor.com/install) unpacks into $HOME of
# whoever runs it, and provision.sh runs as root, whose home the container user
# usually cannot read. So fetch the same tarball the installer would, at a
# pinned version, into a world-readable prefix instead.
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION="${CURSOR_CLI_VERSION:?CURSOR_CLI_VERSION is required (set in agent.env)}"
PREFIX="/opt/cursor-agent"

case "$(uname -m)" in
    x86_64|amd64)  ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *) echo "ERROR: unsupported architecture $(uname -m) for cursor-agent." >&2; exit 1 ;;
esac

URL="https://downloads.cursor.com/lab/${VERSION}/linux/${ARCH}/agent-cli-package.tar.gz"
DEST="$PREFIX/versions/$VERSION"

if [ -x "$DEST/cursor-agent" ]; then
    echo "==> cursor-agent ${VERSION} already installed."
else
    echo "==> Installing cursor-agent ${VERSION} (${ARCH})"
    mkdir -p "$DEST"
    curl -fsSL "$URL" | tar --strip-components=1 -xzf - -C "$DEST"
    chmod -R a+rX "$PREFIX"
fi

ln -sf "$DEST/cursor-agent" /usr/local/bin/cursor-agent
cursor-agent --version
