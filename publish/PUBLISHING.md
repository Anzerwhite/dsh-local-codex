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

## 推荐路径：GitHub Actions 自动发布（不共享令牌）

按顺序执行（把 `OWNER/REPO` 换成你的 GitHub 仓库）：

```sh
cd /workspace/dsh_ifself

# 1) 填写仓库地址并提交（会同时生成市场目录条目文件）
publish/set-repo.sh OWNER REPO

# 2) 创建 GitHub 仓库后推送
git remote add origin git@github.com:OWNER/REPO.git
git push -u origin main

# 3) GitHub 仓库 Settings → Secrets and variables → Actions → New secret
#    Name: NPM_TOKEN
#    Value: npm automation token（npmjs.com → Access Tokens → Generate New Token，
#           选择 Automation，权限 Read and write）

# 4) 打 tag 触发 CI：npm publish + GitHub Release（附 .tgz）
git tag v0.1.0
git push origin v0.1.0

# 5) 等 Actions 绿了之后验证
pnpm view dsh-local-codex version      # 应显示 0.1.0
```

发布成功后，用户可 `dsh plugin --profile web add dsh-local-codex` 安装；本机也可以把 link 安装换成 npm 版本：

```sh
# 通过 Plugin Manager 移除 dsh-local-codex 后重新安装（或 dsh plugin add）
dsh plugin --profile web add dsh-local-codex
```

**市场目录收录（仓库创建满 1 天后）**：fork
`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，把
`publish/awesome-dsh-plugin-entry.yml` 复制为 `data/plugins/OWNER__REPO.yml`，开 PR。
（本仓库已设置提醒排期；到时把仓库地址给 Lead 也可以让 Lead 生成最终文件。）

## 备选：本地 npm 发布（需要把 token 交给执行者）

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

## 当前状态（2026-11-20 18:4x）

- ✅ GitHub 仓库已创建并推送：<https://github.com/Anzerwhite/dsh-local-codex>，topics 含 `dsh-plugin`。
- ✅ `v0.1.0` tag 已推送，GitHub Actions 成功：`npm publish` 因未配置 `NPM_TOKEN` 而按设计跳过；Release 已附 `dsh-local-codex-0.1.0.tgz`。
- ✅ 本机 live 插件已从该 Release tarball 安装（profile 依赖为 Release URL），完成市场安装路径验证。
- ⏳ npm 发布：在仓库 Secrets 配置 `NPM_TOKEN` 后，用本地 `publish/publish-npm.sh` 发布（或发下一个 tag 交给 CI）。
- ⏳ 目录 PR：仓库创建于 2026-11-20T10:35Z，**2026-11-21 之后**才能过 CI 的 1 天门槛；条目文件已生成在 `publish/awesome-dsh-plugin-entry.yml`。
- 🔐 之前用于建仓/推送的 GitHub token 已从本机删除；请到 GitHub Settings → Developer settings 吊销并重新生成。
