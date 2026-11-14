# 发布到 DSH 插件市场

结论：**能发**。但「DSH 插件市场」其实是两套东西，上架路径不同。

| 市场 | 是什么 | 取决于 |
|---|---|---|
| **dshmarket**（本机已装 1.70.1） | 精选列表的可视化集市 | 是否被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录 |
| **官方 Discover**（dsh 0.2.1+） | 可自定义索引源的发现页 | 索引源里有你（也可以用官方同一个索引） |

dshmarket 的 README 写得很直白：*「市场里的插件列表来自精选列表 awesome-dsh-plugin——想让你的插件上架，请去那边提 PR」*，而且安装侧*只允许精选列表内的来源，其它一律拒绝*。所以**上架 = 让 awesome-dsh-plugin 收录**，不是往某个后台提交。

## 硬性要求（来自 awesome-dsh-plugin/contributing.md）

1. **`package.json` 必须声明 `dsh.bundle`** —— 这是能被 `dsh plugin add` 装上的前提。官方明确说：*最常见的被拒原因是只声明了 `dsh.client`*。本项目两处都有。
2. 仓库加 **`dsh-plugin`** topic。
3. 公开的 GitHub 仓库 —— 条目文件是**按仓库**命名的（`data/plugins/littleyellowbicycle__<repo>.yml`），所以必须有公开 repo。
4. `engines.dsh` 或 `@deepseek-ai/dsh-*` peer 要写清宿主版本；peer 范围若不带显式 prerelease 分支，会静默排除所有 prerelease 版宿主 —— 所以这里写的是 `>=0.2.0-0` 而不是 `>=0.2.0`。

## 步骤

### 1. 推到公开 GitHub 仓库

仓库名建议就叫 `dsh-atc`（条目文件名依赖它）。

```powershell
cd /path/to/dsh-atc
git init
git add .
git commit -m "feat: Agent 空管中心 for DeepSeek Harness"
git remote add origin https://github.com/littleyellowbicycle/dsh-atc.git
git push -u origin main
```

然后在 GitHub 仓库页面加上 topic **`dsh-plugin`**。

并在 `package.json` 补上（当前故意留空，等仓库地址确定）：

```json
"repository": { "type": "git", "url": "git+https://github.com/littleyellowbicycle/dsh-atc.git" },
"homepage": "https://github.com/littleyellowbicycle/dsh-atc#readme",
"bugs": { "url": "https://github.com/littleyellowbicycle/dsh-atc/issues" }
```

### 2. 发布 npm 包（可选，但推荐）

不发布也能上架（市场会走 build-from-source），但发布后**安装免 `allowBuilds` 构建授权**，市场还能显示下载量。

**状态：已发布。** `dsh-atc@0.16.0` 在 registry 上，`latest` 指向它。首次发布时 npm 的 staged publishing 会先留一个 `0.0.0-stage` 占位版本，真实版本上传后自动被覆盖，无需处理。

发新版本：

```powershell
# 0. 改 package.json 的 version（不要重复发布同一版本，npm 会拒绝）
npm.cmd pack --dry-run     # 先看会打包哪些文件

# 1. 登录（本机 .npmrc 指向 npmmirror，所以必须显式指定 registry）
npm.cmd login --auth-type=web --registry=https://registry.npmjs.org/

# 2. 发布
npm.cmd publish --registry=https://registry.npmjs.org/
```

两条容易踩的：

- **npm 现在强制要求账号开启 2FA 才能发布**。没开会一直报 `403 ... Two-factor authentication ... is required`。去 https://www.npmjs.com/settings/<用户名>/profile 开启 `Authorization and writes`，之后发布会在浏览器里确认一次。
- Windows 上 PowerShell 执行策略禁止跑 `npm.ps1`，命令要写 `npm.cmd`。
- `prepublishOnly` 会跑 `check` + `test` + 脱敏自查，任一失败就自己拒绝发布。

### 3. 给 awesome-dsh-plugin 提 PR

只加**一个文件** `data/plugins/littleyellowbicycle__dsh-atc.yml`：

**状态：已提 PR → [#15224](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15224)（1 file, +7）**，等维护者合并。合并后 CI 每天重建 `plugins.json`，dshmarket 才看得到。

```yaml
url: https://github.com/littleyellowbicycle/dsh-atc
name: littleyellowbicycle/dsh-atc
category: session
description:
  en: One sidebar panel listing every local coding agent's sessions (DSH, codex, opencode, WorkBuddy) with attention-first grouping, folded history and zero model calls.
  zh: 在右栏一屏看完本机所有 agent 的会话（DSH/codex/opencode/WorkBuddy），按注意力分档、历史折叠，全程零 token。
```

注意事项：

- **`description.en` 是唯一必填项**，中文可以留给维护者补。
- 描述里出现 `: `（冒号+空格）**必须加引号**，否则 YAML 会解析失败。
- 一个 PR **最多加 3 条**。
- 可选 `icon:`，必须是 GitHub 托管的位图（png/jpg/webp），不写就回退到作者头像。
- **不要手工改两个 README**，它们由 `data/plugins/*.yml` 生成。

### 4. 等 CI

合并后 CI 每日刷新 `plugins.json` 与 star／下载量，dshmarket 打开即见，无需你做别的。

## 分类怎么选

官方 slug 全集：`agi, ui, usage, theme, model, identity, session, memory, tools, wsl, browser, vision, voice, docs, skill, workflow, git, notify, dev, security, remote, market, fun`

这个插件二选一：

- **`session`**（会话与消息）—— 更贴事实：它就是一张会话表
- **`workflow`**（工作流与自动化）—— 更贴用途：多 agent 协同观察

我倾向 `session`。注意**不要**选 `theme`，那个分类会自动进 dsh-market 的主题 Tab。

## 审核会看什么

官方列了 8 条，对本项目相关的：

- **有没有可疑代码**：混淆、凭据外传、意外的安装期行为。本项目零依赖、只读本地文件、不发网络请求（客户端只打自己的同源路由），这一点是加分项。
- **是不是 meta-package**：只列依赖、自己没有行为的包不收录 —— 本项目有自己的宿主路由和 UI，不属于。
- **PR 是否越界改别的条目**。

收录 ≠ 安全审计，官方在 README 顶部也有免责声明。

## 或者：自建索引源

不想进精选列表也行。官方 Discover（`@deepseek-ai/dsh-plugin-market`）支持**任意索引源**：自己托管一份 `index.json`，在 插件 → 发现 → 索引源 里填进去即可。dshmarket 也支持用 `DSHM_REGISTRY_URL` 指向镜像。
