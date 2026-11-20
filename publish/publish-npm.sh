#!/bin/sh
# Publish dsh-local-codex to the public npm registry.
# Requires NPM_TOKEN (npm automation token with publish rights for the package).
set -eu
cd "$(dirname "$0")/.."
if [ -z "${NPM_TOKEN:-}" ]; then
  echo "NPM_TOKEN is required" >&2
  exit 1
fi
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$HOME/.npmrc.publish"
chmod 600 "$HOME/.npmrc.publish"
npm_config_userconfig="$HOME/.npmrc.publish" \
  pnpm publish --access public --no-git-checks --registry https://registry.npmjs.org
