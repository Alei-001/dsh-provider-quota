# dsh-provider-quota

DeepSeek Harness 的供应商额度指示器：在输入框里「联网搜索」按钮的左边显示当前模型供应商的剩余额度，点开是完整明细。

```
  [ ⬤ 94% ]  [ 🌐 联网搜索 ]        ← 随会话模型切换
```

切换模型时指示器跟着切换。如果这个供应商没有适配器，**那里什么都不显示** —— 空位好过拿别家的数字糊弄。

## 功能

- **跟随会话模型**：读当前会话的模型选择，换模型即时换数据。
- **套餐和余额都能画**：百分比型（圆环 + 进度条 + 重置时间）和金额型（API 余额，没有百分比）共用一套渲染。
- **阈值可配**：百分比预警/危险阈值，外加金额预警/危险阈值。
- **配置就在插件页**：折叠卡片，和 DSH 其他插件一致；界面文案走 Client locale（中/英）。
- **只依赖 React**：不加载任何 Harness Client 包，控件全部自带。

## 适配的供应商

| 供应商 id | 数据来源 | 显示 |
|---|---|---|
| `opencode-go` | OpenCode Go 套餐接口 | 5 小时 / 本周 / 本月 三个窗口 |
| `deepseek-official`、`deepseek` | DeepSeek 官方 API 余额 | 账户余额（金额） |
| `deepseek-account` | DeepSeek 账号平台 | 充值余额 + 赠送余额 |

其余 id 一律不显示。要加新供应商，照着 `lib/providers/` 里的适配器写一个即可。

## 安装

```powershell
dsh plugin --profile desktop add "git+ssh://git@github.com/Alei-001/dsh-provider-quota.git"
```

装完刷新页面，插件页里会出现「供应商额度」和卸载按钮。

## 升级

```powershell
.\scripts\upgrade.ps1 "改了点什么"
```

一条命令搞定：提交 → 推送 → 重装。手动的话是：

```powershell
git add -A; git commit -m "…"; git push
dsh plugin --profile desktop update dsh-provider-quota
```

客户端改动**刷新页面**生效；宿主改动要**重启 DSH**。

## 配置

在插件页的折叠卡片里直接改，六个字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `warnRemaining` | 30 | 剩余 ≤ 该百分比显示预警色 |
| `dangerRemaining` | 10 | 剩余 ≤ 该百分比显示危险色 |
| `minIntervalMs` | 15000 | 两次上游读取之间的最短间隔（毫秒） |
| `timeoutMs` | 10000 | 单次上游读取的截止时间（毫秒） |
| `warnValue` | 0 | 金额型窗口低于该金额就预警；`0` = 不启用 |
| `dangerValue` | 0 | 金额型窗口低于该金额就危险；`0` = 不启用 |

其余配置（路由路径等）写在 profile 的 `cordis.patch.yml`。

## 说明

- 宿主提供两个同源只读路由：`/dsh-provider-quota/providers`（本机能测哪些供应商）和 `/dsh-provider-quota/usage?provider=<id>`（某个供应商的余量）。
- **不存任何密钥**：需要认证的适配器只按名字去 DSH 凭据服务读。
- 已知限制：OpenCode Go 是内部接口，只给百分比；上游用量日志和仪表盘有已知不一致。

## 开发

```powershell
# 测试用的一份 React（插件本身从浏览器模块表取 React）
mkdir "$env:TEMP\dspq-harness"; cd "$env:TEMP\dspq-harness"
npm init -y; npm install react@18 react-dom@18
```

```powershell
node scripts/smoke.mjs       # 258 条断言：宿主路由、适配器、客户端渲染、写路径、字典
node scripts/neg-proof.mjs   # 故意改坏 4 处，确认测试真会变红
```

默认测 profile 里安装的那一份（宿主半要读 profile 的 peer 依赖）；测别的副本就设 `DSPQ_PLUGIN_DIR`。

## License

MIT
