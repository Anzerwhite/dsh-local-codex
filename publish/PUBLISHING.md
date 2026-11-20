# 发布到 DSH 插件市场（清单与步骤）

面向 **dshmarket / awesome-dsh-plugin 社区目录**（用户侧「插件 → Discover / 插件市场」读取的同一份目录）。
官方 DeepSeek 目录不开放第三方提交；社区市场是唯一公开曝光通道。

## 发布前事实（2026-11-20 核对）

- npm 包名：`dsh-local-codex`（`dsh-codex-mode` 已被他人占用；`dsh-codex-bridge` / `dsh-codex-sync` 也已存在）。
- 包已可通过 `pnpm publish`（`pnpm publish --dry-run` 通过），tarball `dist/dsh-local-codex-0.1.0.tgz` 已端到端验证。
- 目录收录要求（摘自 awesome-dsh-plugin/contributing.md）：
  1. 仓库 `package.json` 声明 `dsh.bundle.patch`（✅ 本包已声明）。
  2. 真实可用代码（✅ 已在本机 DSH web + headless E2E 验收）。
  3. **GitHub 仓库创建满 1 天**（CI 自动检查）。
  4. 仓库添加 `dsh-plugin` topic。
  5. 在 `awesome-dsh-plugin` 仓库新增 `data/plugins/<owner>__<repo>.yml`，一个插件一个文件，一个 PR 最多 3 条。
  6. 描述必须真实对应代码，不带营销词；分类选最贴近的（本插件建议 `dev`）。
  7. 建议发布 npm（安装免构建）；也可以只发 GitHub Release tarball（条目里加 `tarball:`）。
- 合并后 CI 重新生成 README 并发布 `dsh-plugin-catalog`（jsDelivr 上的 format-1 索引），市场随后刷新目录。

## 步骤 A：npm 发布（推荐）

```sh
cd /workspace/dsh_ifself
export NPM_TOKEN=<你的 npm automation token>
publish/publish-npm.sh           # 等价于：
# printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > ~/.npmrc.publish
# npm_config_userconfig=~/.npmrc.publish pnpm publish --access public --no-git-checks --registry https://registry.npmjs.org
```

发布后验证：

```sh
pnpm view dsh-local-codex version          # 0.1.0
dsh plugin --profile web add dsh-local-codex
```

## 步骤 B：GitHub 仓库

1. 把 `package.json` 的 `repository` / `homepage` / `bugs` 里的 `PLACEHOLDER` 换成实际仓库。
2. 创建仓库并推送（仓库创建时间从这里开始算，满 1 天后才能提交目录 PR）：

   ```sh
   git remote add origin git@github.com:OWNER/REPO.git
   git push -u origin main
   ```

3. 在仓库设置里添加 topic：`dsh-plugin`（也建议 `dsh`、`deepseek-harness`、`codex`）。
4. （不发 npm 才需要）创建 GitHub Release，附上 `dist/dsh-local-codex-0.1.0.tgz`，按条目里的 `tarball:` 写 URL。

## 步骤 C：提交目录条目（仓库满 1 天后）

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`。
2. 复制 `publish/awesome-dsh-plugin-entry.yml` 为 `data/plugins/<owner>__<repo>.yml`，替换 `OWNER/REPO`。
3. 开 PR（只加这一个文件，不改 README），等待 CI + 维护者评审。
4. 合并后市场目录自动刷新；用户可在「插件市场 / Discover」里搜到并通过 npm 一键安装。

## 现在的阻塞项

- 本机 **没有 npm 登录凭据**（`pnpm whoami` 未授权），无法替用户发布。
- 本机 **没有可用 GitHub 凭据**（`ssh -T git@github.com` 被拒，无 gh CLI/token），无法建仓库/推代码/开 PR。
- 仓库创建满 1 天是 CI 硬性门槛：即使今天拿到凭据，目录 PR 也要明天才能提交。

把 npm token、GitHub owner/repo（或 token）给到 Lead 后，A/B 两步可以在今天完成，C 由 Lead 排期/提醒或用户自己执行。
