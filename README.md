# dsh-fleet-board

DeepSeek Harness 的多 Agent 看板：在右栏加一个 tab，一屏看完**本机所有 agent** 正在干什么。

零 token —— 宿主侧只读本地会话存储、纯本地推断状态，不经过任何模型。

## 它解决什么

同时用 DSH / codex / opencode / WorkBuddy / Trae / MiniMax 时，注意力会被切成 N 份。这个插件把「谁在跑、谁停了、谁在等我」压到一屏。

## 数据源

| 工具 | 存储 | 读取方式 |
|---|---|---|
| dsh | `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd` + `$DSH_HOME/storages/workspace.json` | 目录 mtime + 工作区映射 |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` | 文件 mtime + 头部 `cwd` / `model_provider` |
| opencode | `~/.local/share/opencode/opencode.db` | sqlite（`session` + `message.time_updated`） |
| workbuddy | `~/.workbuddy/workbuddy.db` | sqlite（`sessions.status/last_activity_at`） |

Trae / MiniMax 暂无稳定结构化字段，待补。任何一个源失败只降级该源（UI 上标 `✕`），不影响整板。

## 界面怎么排

本机能有 500+ 条历史会话，**平铺等于没有信息**。所以默认按注意力分四段，只展开前面几段：

```
✓ 没有需要你处理的          ← 有事时才出现，且永远在最前
▾ 正在跑 4    opencode 1 · dsh 2 · workbuddy 1
▾ 最近动过 2  dsh 1 · workbuddy 1
▸ 更早 118    点开查看       ← 默认折叠，展开最多 60 条
```

判据：`needs-you`/`failed` → 第一段；`running` → 第二段；其余按 `recentMinutes` 切「最近动过 / 更早」。组标题上的数字是条数，右边是各工具分布。底栏写明「显示 124 / 共 521」，因为每个源最多取 `perSource` 条。

## 可调参数

宿主每次轮询都会读 `$DSH_HOME/fleet-board.json`（不存在就用默认值），**改完不用重启**：

```json
{ "perSource": 40, "runningSeconds": 120, "recentMinutes": 30, "attentionHours": 24 }
```

| 键 | 作用 |
|---|---|
| `perSource` | 每个源最多取多少条（影响「显示 N」） |
| `runningSeconds` | 无自带状态时，多少秒内有动静算「在跑」 |
| `recentMinutes` | 「最近动过 / 更早」的分界 |
| `attentionHours` | 失败态只在这么多小时内算「要你处理」，更早的失败是历史 |

模板见 [fleet-board.example.json](fleet-board.example.json)。

## 状态词典

各源的自带状态按这套规则映射，不猜：

| 原始状态 | 归到 |
|---|---|
| `working` / `active` | 在跑 |
| `error` | 失败（且只在 `attentionHours` 内进「要你处理」） |
| `terminated` | 已停 |
| `completed` / `archived` | 完成 |
| `waiting` / `pending` / `confirm` / `approv` | 等你 |
| 其余 | 按最后活动时间推断 |

## 状态怎么来的

全部宿主侧推断，不调模型：

- 存储自带状态（如 WorkBuddy 的 `sessions.status`）优先，命中 `wait/pending/confirm/approv` → **等你**
- 否则按最后活动时间：< 2 分钟 → **在跑**；< 30 分钟 → **刚停**；更久 → **空闲**

「等你」和「失败」计入 tab 标题上的数字，所以收起时也能看到有几条要处理。

## 额度 / 上下文

每行第二行的小字是各源**实际能提供**的信息，不编造：

| 源 | 显示 | 来源 |
|---|---|---|
| workbuddy | `ctx 25% · 17.3 点` | `session_usage` 的 `used/size` 与 `credit_json` |
| codex | `volcengine` | rollout 头部的 `model_provider` |
| dsh / opencode | 无 | 其存储不提供 per-session 成本 |

顶栏「今日 ¥1.18」来自 DSH `storages/cost-meter/ledger.json`（该账本按**天**记，不按会话，所以只进汇总条）。

## 安装（desktop profile）

```powershell
# 1. 备份
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" `
          "$env:USERPROFILE\.dsh\profiles\desktop\package.json.bak"

# 2. 在 package.json 里加两处
#    dependencies."dsh-fleet-board" = "link:/path/to/dsh-fleet-board"
#    dsh.profile.bundles 追加 "dsh-fleet-board"

# 3. 用 runtime 自带 pnpm 装（不要用系统 pnpm）
$rt = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
cd "$env:USERPROFILE\.dsh\profiles\desktop"
& "$rt\node\bin\node.exe" "$rt\pnpm\bin\pnpm.cjs" install
```

**必须重启桌面端**：宿主侧插件只在启动时组合进 profile，热加载不生效。

## 使用

右栏「+」→ 选「多 Agent 看板」。tab 上括号里的数字 = 等你决策 + 失败的条数。

## 本地开发

```powershell
node scripts/probe.mjs        # 不开 DSH，直接打印看板数据（dry run）
node --test tests/contract.test.mjs   # 宿主路由 + 客户端接线的契约测试
node scripts/render-check.mjs # 用真 React 把真数据渲染成 HTML，产出 render-check.html
node --check lib/index.js     # 语法检查
```

改了 `lib/` 要重启桌面端；改了 `client/client.js` 刷新页面即可（link 安装，文件就地生效）。

### 真机无头验证（不碰 desktop profile）

```powershell
# 1. 建一个独立测试 profile（CLI 可管理，desktop 不行）
dsh --profile fleet-test --from-default-profile web --dump-config
dsh plugin --profile fleet-test add "link:/path/to/dsh-fleet-board"

# 2. 起一个独立 web 实例
dsh --profile fleet-test --port 60200 --no-open

# 3. 无头 Edge 打开、点开右栏、点我们的入口、截图
node scripts/live-check.mjs 'http://127.0.0.1:60200/?token=<token>' `
  '--click=打开右侧边栏' '--click=多 Agent 看板'
```

`live-check.png` 是当次面板截图，`__dshFleetBoard.registered` 为 true 表示客户端在真宿主里注册成功。

## 卸载

删掉 `package.json` 里那两处，重跑 pnpm install，重启。
