#!/bin/sh
# Point the package at its public GitHub repository and regenerate the market
# catalog entry. Run this once, BEFORE pushing the release tag.
#
#   publish/set-repo.sh <owner> <repo>
#
set -eu
if [ "$#" -ne 2 ]; then
  echo "usage: $0 <owner> <repo>" >&2
  exit 1
fi
OWNER="$1"
REPO="$2"
cd "$(dirname "$0")/.."
python3 - "$OWNER" "$REPO" <<'PY'
import json
import sys

owner, repo = sys.argv[1], sys.argv[2]
url = f"https://github.com/{owner}/{repo}"

with open('package.json') as fh:
    data = json.load(fh)
data['repository'] = {'type': 'git', 'url': f'git+{url}.git'}
data['homepage'] = f'{url}#readme'
data['bugs'] = {'url': f'{url}/issues'}
with open('package.json', 'w') as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write('\n')

entry = f"""# awesome-dsh-plugin submission entry.
# Copy to awesome-dsh-plugin/data/plugins/{owner}__{repo}.yml and open a PR
# once this GitHub repository is at least 1 day old.
url: {url}
name: {owner}/{repo}
category: dev
description:
  en: 'Per-session Codex mode: send a trigger word or /codex, and that one DSH session is handled by your local Codex CLI, with streamed replies plus command and file-change tool cards inline.'
  zh: '按会话切换的本机 Codex 模式：发触发词或 /codex 把单个会话交给本机 Codex，回复流式显示，命令与文件改动以工具卡片同步展示在同一对话流。'
# Prebuilt tarball attached by .github/workflows/release.yml; lets the market
# install without npm. Pinned tag, so the versioned asset name cannot rot.
tarball: {url}/releases/download/v0.1.1/dsh-local-codex-0.1.1.tgz
"""
with open('publish/awesome-dsh-plugin-entry.yml', 'w') as fh:
    fh.write(entry)
print(f'updated package.json + publish/awesome-dsh-plugin-entry.yml for {owner}/{repo}')
PY
git add package.json publish/awesome-dsh-plugin-entry.yml
git -c user.name='dsh-local-codex release' -c user.email='release@localhost' commit -q -m "chore: point package metadata at $OWNER/$REPO"
echo "repository metadata committed."
echo "next: git remote add origin git@github.com:$OWNER/$REPO.git && git push -u origin main"
