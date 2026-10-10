# dsh-provider-quota

DeepSeek Harness 的供应商额度指示器：在输入框的「联网搜索」左边显示当前模型供应商的剩余额度，点开是完整明细。

```
[ 94% ]  [ 联网搜索 ]
```

切换模型，数字跟着切换；这个供应商没有适配器，那里就什么都不显示 —— 空位好过拿别家的数字糊弄。

## 功能

- **跟随会话模型**：切换模型即时切换，不适配的供应商显示为空
- **套餐和余额都能画**：百分比窗口（圆环 + 进度条 + 重置时间）与金额窗口（API 余额）共用一套渲染
- **阈值可配**：百分比预警/危险阈值，外加金额预警/危险阈值
- **能自我更新**：远端有新版本时，插件页会多出一行，点一下就装好
- **界面本地化、样式随宿主**：文案走 DSH 的 locale 服务（中/英），颜色只用宿主主题 token
- **只依赖 React**：不加载任何 DSH 客户端包，控件全部自带
- **不存任何密钥**：需要认证的适配器只按名字去 DSH 凭据服务读

## 支持哪些供应商

| 供应商 id | 数据来源 | 显示 |
|---|---|---|
| `opencode-go` | OpenCode Go 套餐接口 | 5 小时 / 本周 / 本月 |
| `deepseek-official`、`deepseek` | DeepSeek 官方 API 余额 | 账户余额（金额） |
| `deepseek-account` | DeepSeek 账号平台 | 充值余额 + 赠送余额 |

其余 id 一律不显示。要加新供应商，照着 `lib/providers/` 里的适配器写一个即可。

## 安装

```powershell
dsh plugin --profile desktop add "git+ssh://git@github.com/Alei-001/dsh-provider-quota.git"
```

装完刷新页面，插件页里会出现「供应商额度」，可以随时从那里卸载。

## 使用

**输入框里的指示器**：主窗口的剩余百分比（圆环）或金额（钱包图标），颜色随阈值变化。点开是完整面板 —— 主窗口大环、其余窗口进度条、刷新与关闭、更新时间。

**插件页的卡片**：默认折叠，展开后是「本机可测量的供应商」和六个可配置字段（见下）。

## 更新

有新版本时，展开卡片会**自动多出一行**（平时没有这一行，卡片头部也不会有任何变化）：

```
有新版本 v0.2.4 → e059f56
当前 v0.2.0                               [ 更新 ]
```

点「更新」：插件管理器从仓库拉取那一个 commit，装好后**客户端半自动重载**，不用刷新页面。这次改动如果动到了宿主半（`lib/index.js`），提示会说要重启 DSH。

**发一个新版本**：改 `package.json` 里的 `version`，提交推送，然后页面里点「更新」。

> 版本号就是「有没有新版本」的开关 —— 页面读不到自己装的是哪个 commit，只能比对 profile 里的已装版本和仓库里的 `package.json`，所以每次发布都得 bump。检查由浏览器直接读 GitHub API 完成，仓库需要保持公开。

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

## 已知限制

- OpenCode Go 是内部接口，只给百分比；上游用量日志和仪表盘有已知不一致。
- 打开本插件页面时，浏览器会向 `api.github.com` 发一到两次未认证请求做版本检查，除此之外没有外部请求。

## 开发

```powershell
# 测试用的一份 React（插件本身从浏览器模块表取 React）
mkdir "$env:TEMP\dspq-harness"; cd "$env:TEMP\dspq-harness"
npm init -y; npm install react@18 react-dom@18
```

```powershell
node scripts/smoke.mjs       # 292 条断言：宿主路由、适配器、客户端渲染、写路径、字典、更新检查
node scripts/neg-proof.mjs   # 故意改坏 4 处，确认测试真会变红
```

默认测 profile 里安装的那一份（宿主半要读 profile 的 peer 依赖）；测别的副本就设 `DSPQ_PLUGIN_DIR`。

## License

MIT
