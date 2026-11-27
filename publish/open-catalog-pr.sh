#!/bin/sh
# Prepare (and, once the GitHub repo is at least 1 day old, open) the
# awesome-dsh-plugin catalog PR for this plugin.
#
#   publish/open-catalog-pr.sh --prepare-only   # fork + branch + entry file, no PR
#   publish/open-catalog-pr.sh                  # also open the PR (after the 1-day gate)
#
# Reads GITHUB_TOKEN from /workspace/dsh_ifself/dsh-local-codex/.config (gitignored).
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .config ]; then
  echo "missing .config with GITHUB_TOKEN=..." >&2
  exit 1
fi
MODE="${1:-}"
python3 - "$MODE" <<'PY'
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

MODE = sys.argv[1] if len(sys.argv) > 1 else ""
API = "https://api.github.com"
OWNER = "Anzerwhite"
REPO = "dsh-local-codex"
UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin"
FORK = f"{OWNER}/awesome-dsh-plugin"
BRANCH = f"add/{OWNER}-{REPO}"
FILE_PATH = f"data/plugins/{OWNER}__{REPO}.yml"

raw = open(".config").read()
token_match = re.search(r"GITHUB_TOKEN\s*=\s*(\S+)", raw)
if not token_match:
    sys.exit("no GITHUB_TOKEN in .config")
TOKEN = token_match.group(1).strip("\"'\r")
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "dsh-local-codex-release",
}


def gh(method, path, data=None, allow=(200, 201, 204)):
    url = path if path.startswith("http") else API + path
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            payload = response.read()
            if response.status not in allow:
                raise SystemExit(f"unexpected HTTP {response.status} for {method} {path}")
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        payload = error.read().decode(errors="replace")
        raise SystemExit(f"HTTP {error.code} for {method} {path}: {payload[:500]}")


user = gh("GET", "/user")
if user.get("login") != OWNER:
    sys.exit(f"token belongs to {user.get('login')}, expected {OWNER}")

# 1. The repo must be at least 1 day old before the upstream CI accepts the entry.
repo = gh("GET", f"/repos/{OWNER}/{REPO}")
created = datetime.fromisoformat(repo["created_at"].replace("Z", "+00:00"))
age = datetime.now(timezone.utc) - created
if age.total_seconds() < 86400 and MODE != "--prepare-only":
    remaining = 86400 - age.total_seconds()
    sys.exit(f"repository is only {age}; wait {int(remaining)}s (1-day CI gate). Use --prepare-only to stage the branch now.")

# 2. Fork (idempotent) and wait for its default branch.
try:
    gh("GET", f"/repos/{FORK}")
    print("fork exists:", FORK)
except SystemExit:
    gh("POST", f"/repos/{UPSTREAM}/forks", {}, allow=(200, 201, 202, 204))
    print("forking:", FORK)
for _ in range(60):
    try:
        gh("GET", f"/repos/{FORK}/branches/main")
        break
    except SystemExit:
        time.sleep(2)
else:
    sys.exit("fork branch did not appear in time")

# 3. Branch from the current upstream main so the PR contains only our entry.
upstream_main = gh("GET", f"/repos/{UPSTREAM}/git/ref/heads/main")["object"]["sha"]
try:
    gh("GET", f"/repos/{FORK}/git/ref/heads/{BRANCH}")
    gh("PATCH", f"/repos/{FORK}/git/refs/heads/{BRANCH}", {"sha": upstream_main, "force": True})
    print("branch reset:", BRANCH)
except SystemExit:
    gh("POST", f"/repos/{FORK}/git/refs", {"ref": f"refs/heads/{BRANCH}", "sha": upstream_main})
    print("branch created:", BRANCH)

# 4. Clean entry content (drop template comments) and commit it on the branch.
source = open("publish/awesome-dsh-plugin-entry.yml").read().splitlines()
lines = [line for line in source if line.strip() and not line.lstrip().startswith("#")]
content = "\n".join(lines).strip() + "\n"
payload = {
    "message": f"Add {OWNER}/{REPO}",
    "content": base64.b64encode(content.encode()).decode(),
    "branch": BRANCH,
}
try:
    existing = gh("GET", f"/repos/{FORK}/contents/{FILE_PATH}?ref={BRANCH}")
    payload["sha"] = existing["sha"]
except SystemExit:
    pass
gh("PUT", f"/repos/{FORK}/contents/{FILE_PATH}", payload)
print("entry file:", f"https://github.com/{FORK}/blob/{BRANCH}/{FILE_PATH}")

if MODE == "--prepare-only":
    print("prepare-only: branch staged, PR not opened")
    sys.exit(0)

# 5. Open the PR (idempotent: report an existing one).
head = f"{OWNER}:{BRANCH}"
existing = gh("GET", f"/repos/{UPSTREAM}/pulls?head={head}&state=all")
if isinstance(existing, list) and existing:
    print("PR already exists:", existing[0]["html_url"])
    sys.exit(0)

body = (
    f"Adds [{OWNER}/{REPO}]({repo['html_url']}): a per-session Codex mode for DeepSeek Harness. "
    "A trigger word or `/codex` hands one DSH session to the local Codex CLI; replies stream inline and "
    "commands/file changes appear as native tool cards. Session-scoped, persisted across restarts, "
    "new sessions default off.\n\n"
    "- Repo declares `dsh.bundle.patch` and installs with `dsh plugin add`.\n"
    f"- Prebuilt release tarball: {repo['html_url']}/releases/download/v0.1.0/dsh-local-codex-0.1.0.tgz\n"
    "- Repo has the `dsh-plugin` topic."
)
pr = gh("POST", f"/repos/{UPSTREAM}/pulls", {
    "title": f"Add {OWNER}/{REPO}",
    "head": head,
    "base": "main",
    "body": body,
    "draft": False,
})
print("PR opened:", pr["html_url"])
PY
