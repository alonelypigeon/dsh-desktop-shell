# 竞品调研与功能规划输入（2026-08）

> 调研时间：2026-08-19。为 dsh-desktop-shell 下版本规划提供输入的竞品扫描，
> 覆盖四类相邻产品并归纳出 20 项功能创意（A–E 五个主题）。
> 版本排期见 [`docs/roadmap.md`](roadmap.md)；本文是它的依据存档。

## 0. 我们的位置（v0.5.0 基线）

dsh-desktop-shell 的定位：**面向自带 dsh 实例的托盘常驻桌面壳**（MIT、单人维护）——
本地嗅探 / GUI 启停本地 `dsh web` / 远程 URL / 最近 5 条连接；自定义标题栏
（启停、切换、重载、浏览器打开、缩放、置顶）；可配置应用内快捷键 + 全局热键；
托盘常驻、窗口状态记忆、3 秒断线自动重连；外链白名单、零注入沙箱
WebContentsView、fuses、单实例锁、`dsh-shell://` 深链、三平台打包、
electron-updater 自动更新（Windows portable 除外）；cordis 插件扩展
（desktop-control / balance-panel / session-outline）。

对照竞品后的**缺口**集中在：多连接/多窗口、通知与徽章、命令面板、portable 更新、
代理支持。而**零注入架构**（页面状态只能从 Electron 事件或官方插件通道获取）
是与竞品形成差异的约束，也是卖点——所有创意都不得破坏它。

## 1. 四类相邻产品概览

### 1.1 Web 应用打包 / 工作台聚合器（Rambox、Ferdium、WebCatalog/Singlebox、Beekeeper Studio、Station）

成熟红海。核心卖点早已从「打包网页」转向运维型体验：连接/服务配置库
（命名、文件夹、置顶）、同服务多账号并存、每服务代理与独立设置、睡眠标签页
省内存、集中式通知中心与一键勿扰。Beekeeper Studio 的「保存连接 + 文件夹 +
连接测试」是数据库工具里最好的连接管理 UX 范本；Station 的 Focus Mode
（一键静默全部通知）是勿扰设计的早期标杆。对 dsh-desktop-shell 的启示主要在
**连接配置管理、通知治理、资源控制**三块。

### 1.2 菜单栏/托盘优先应用（MenubarX、FloatBrowser 等）

macOS 上「任意网页固定到菜单栏 + 浮动小窗 + 每窗口独立快捷键」是被验证过的
模式（MenubarX、FloatBrowser）；Windows/Linux 则以任务栏覆盖徽章
（`setOverlayIcon`）和托盘图标切换为主。这一类证明：**托盘常驻 + 徽章计数 +
全局热键唤出**是桌面壳的「体感基本盘」，用户对徽章失灵极其敏感
（Ferdium 相关 issue 长期不断）。

### 1.3 AI 编码代理 GUI / 客户端（最直接同类）

Claude Desktop、Crystal（stravu/crystal）、Conductor（conductor.build）、Opcode、
Cline/Roo Code、Agent.exe、Teragon、claude-code-webui、claudecodeui、
Happy Coder（happy.engineering）、Omnara、Warp/Wave 终端。

2025–2026 增长最快的品类，三个共识功能已经浮现：

- **并行多会话**——Crystal/Conductor 用 git worktree 隔离、每个任务独立工作区
  + diff + 合并路径；
- **「代理需要你」的通知与远程审批**——Omnara（YC S25）整个产品建立在
  「agent 卡住时推送通知 + 手机上一键批准」上，Happy 做端到端加密的手机接力，
  Claude Code 官方也内置了 Remote Control；
- **会话历史与用量可视化**——Opcode 提供会话时间线/检查点/恢复、费用与 token
  分析仪表盘。Teragon 代表「后台云代理 + web/手机/CLI 多端查看」方向。
  Warp 2.0 已整体转向「并行可编程代理终端」并开源，Wave 主打块状工作区与
  持久 SSH 会话。

### 1.4 Electron 桌面壳工程实践（与本产品直接相关）

- electron-updater 支持 `stagingPercentage` 分阶段灰度与 GitHub Releases 发布；
- 单人项目普遍采用单实例锁 + 二次启动聚焦既有窗口（本产品已有）；
- portable 版无法自动更新是 electron-builder 的已知限制，通行做法是
  「检测到 portable 则引导手动下载」；
- Spotlight 式快捷浮窗（frameless + alwaysOnTop + skipTaskbar + globalShortcut）
  和任务栏/托盘徽章（Windows `setOverlayIcon`、macOS `app.setBadgeCount` /
  `tray.setTitle`、Linux StatusNotifierItem attention）均有成熟实现路径；
- 更新管道需做签名校验与 https 分发（Doyensec 2026 指南）。

## 2. 功能创意清单（按主题，含验证方与工作量）

工作量：S = 数小时～1 天，M = 数天，L = 一两周以上。

### 主题 A：多会话 / 连接管理

| 创意 | 说明与验证方 | 工作量 |
|---|---|---|
| A1. 命名连接配置库 | 本地/远程多实例各存一份命名档案（地址、启动参数、独立窗口状态），替代现在扁平的「最近 5 条」。Beekeeper 的保存连接+文件夹+置顶是成熟范本；WebCatalog Spaces 支持多账号并存。 | M |
| A2. 多窗口并行会话 | 一个连接一个窗口，托盘菜单列出各会话窗口，支持并排对照两条 agent 输出。Crystal/Conductor 用 git worktree 并行多 Claude Code 会话验证了强需求；Ferdium 支持同服务多开。 | L |
| A3. 连接健康面板 | 对当前连接显示 ping 延迟、dsh 版本、本地服务进程状态，一键重启。Beekeeper/Opcode 都有连接测试入口。 | S–M |
| A4. 连接配置导入/导出（JSON） | 机器间迁移配置。Beekeeper 缺此功能导致用户在 issue #1645 里长期抱怨，反向证明需求。 | S |
| A5. 每连接代理设置（可选 SSH 隧道） | `session.setProxy` 一行级支持 HTTP/SOCKS 代理访问远程 dsh；SSH 隧道为进阶。Ferdium/Rambox 均有 per-service proxy；Wave 的持久 SSH 会话展示远端场景价值。 | 代理 S–M / 隧道 L |

### 主题 B：托盘与通知

| 创意 | 说明与验证方 | 工作量 |
|---|---|---|
| B1. 「代理需要输入/已完成」原生通知 | 零注入前提下监听 `page-title-updated`（网页标题的 "(1)" 等前缀）触发系统通知，点击经既有 `dsh-shell://show` 深链聚焦窗口。Omnara（推送+远程批准）、Happy（手机接力）、Claude Code 官方 Remote Control 三方验证这是 agent GUI 第一痛点。 | S–M |
| B2. 托盘/任务栏未读徽章 | Windows 用 `setOverlayIcon` 画计数角标，macOS 用 `app.setBadgeCount` / `tray.setTitle`，Linux 用 StatusNotifierItem attention 图标。Ferdium/Rambox/MenubarX 均为标配，且 Ferdium 的徽章可靠性 issue 证明这是用户最在意的细节。 | M |
| B3. 勿扰时段（DND/quiet hours） | 定时静默 + 托盘右键一键全局静音，静默期间只保留徽章不弹通知。Station Focus Mode 与 Rambox Focus Mode 验证；Ferdium 支持托盘右键一键静音。 | S |
| B4. 通知聚合与点击去重 | 代理长任务完成时合并多条为一条摘要通知（「3 个会话有更新」），避免轰炸。Rambox 集中式通知中心思路。 | S |

### 主题 C：快捷操作

| 创意 | 说明与验证方 | 工作量 |
|---|---|---|
| C1. 全局命令面板/快速切换器 | Ctrl+K 呼出：切换最近连接、启停本地服务、重载、置顶、打开诊断等，键盘优先。WebCatalog 的 Switchbar 专门做「应用/账号间秒切」；Claude Desktop 的全局快捷窗证明「随时唤出」的价值。 | S–M |
| C2. Raycast 式 quick-ask 浮窗 | 全局热键唤出迷你 frameless 窗口，直接加载同一 dsh 服务器 URL 快速发一条指令，Esc 即走。Claude Desktop ⌥+Space Quick Prompt 是直接原型；与零注入原则兼容（小窗即普通沙箱视图）。 | M |
| C3. 画中画迷你监控窗 | 置顶小窗实时显示当前 agent 输出，边在编辑器写代码边盯代理。MenubarX 浮动浏览器与 Omnara「随处监控代理」仪表盘验证需求。 | M |
| C4. 更多可执行的全局热键动作 | 在现有快捷键面板上增加「重启本地服务」「切换到上次连接」等单动作全局键。FloatBrowser/MenubarX 支持逐窗口自定义快捷键。 | S |

### 主题 D：安全与运维

| 创意 | 说明与验证方 | 工作量 |
|---|---|---|
| D1. 远程 URL 凭据安全存储 | 用 Electron safeStorage 存 token，界面回显打码。Ferdium 加密存储服务凭据是同类做法。（注：v0.5.x 后 URL 内嵌凭据已被剥离，此项转为「配置库的凭据字段加密」。） | M |
| D2. 隐藏到托盘时的资源策略选项 | 可选「托盘时降低渲染/节流但保持网络与推送」（对 agent 长任务不能照抄 Ferdium 睡眠标签，需保留轮询）。Ferdium sleep/Rambox hibernation 验证用户对内存敏感。 | S–M |
| D3. 诊断与日志面板 | 本地服务 stdout 滚动历史、错误时间线、一键导出日志文件（git issue 排障利器）。现有启动错误浮层的自然延伸；Beekeeper/Opcode 均有连接诊断。 | S |
| D4. 会话历史快速入口 | 壳层搜索/恢复历史会话（与 dsh-plugin-session-outline 协同，壳层只做索引与唤起）。Opcode 的会话时间线+恢复、siteboon claudecodeui 的项目管理、Cline checkpoints 验证价值。 | M（依赖插件） |

### 主题 E：更新与分发体验

| 创意 | 说明与验证方 | 工作量 |
|---|---|---|
| E1. 更新对话框带 release notes | 「检查更新」展示新版变更日志，支持「退出时安装」。electron-updater 标准能力。 | S |
| E2. 分阶段灰度 + 签名校验 | electron-builder `stagingPercentage` 灰度发布，更新源 HTTPS + 签名校验（2026 年 Doyensec 指南），单人维护项目的坏更新保险丝。 | S |
| E3. Windows portable 更新回退 | 检测 portable 安装时，更新检查改为提示并一键打开 Releases 下载页（portable 无法 in-place 更新是 electron-builder 已知限制）。 | S |
| E4. 更新前自动备份 portable 目录 | 下载新版后先备份旧目录再替换，失败可回滚。 | M |

## 3. Top 5 排名（价值/工作量，针对本产品定位）

1. **B1 + B2：代理状态通知 + 托盘/任务栏徽章（一组）** —— 本品类第一痛点：
   agent 跑长任务时窗口藏在托盘，用户只能反复拉开看。Omnara 整个创业公司、
   Happy、Claude Code 官方 Remote Control 都在验证它；而实现只需监听标题事件 +
   `setOverlayIcon`/`setBadgeCount`，完全不动零注入架构。工作量 S–M，价值最高。
2. **C1：命令面板/快速切换器** —— 现有「最近 5 条连接 + 全局热键」的自然进化，
   键盘党日常高频；Switchbar/Rambox 证明切换速度是工作台类产品的核心体验。
   工作量 S–M。
3. **E1–E3：更新体验三件套**（release notes 对话框、灰度+签名校验、portable
   回退）—— 单人维护、用户以 GitHub Releases 自动更新的项目，一次坏更新就是
   口碑事故；三项全是 electron-updater 原生能力，合计工作量 S，花小钱买保险。
4. **C3：画中画迷你监控窗** —— 与竞品（Crystal/Conductor/Opcode 都是「常驻大
   窗口」）形成差异化：小成本切入「边写码边盯代理」场景，MenubarX 浮窗与
   Omnara 监控面板验证需求；复用现有沙箱 WebContentsView 技术。工作量 M。
5. **A1 + A4：命名连接配置库 + 导入导出** —— 同时维护本地 dsh 与云端 dsh 的
   用户立即受益，也为将来 A2 多窗口并行打地基；Beekeeper 的连接管理 UX
   （以及它缺导出被用户抱怨）是最直接的需求证据。工作量 M。

（A2 多窗口并行会话是战略级功能但工作量 L，建议作为 vNext+1 的旗舰项，
先以 A1 的数据结构铺垫。）

## 4. 参考来源

- Ferdium 官网：<https://ferdium.org/>；徽章/通知 issue：<https://github.com/ferdium/ferdium-app/issues/2377>、<https://github.com/ferdium/ferdium-app/issues/1161>；托盘静音评测：<https://cubiclenate.com/2024/03/17/ferdium-centralized-web-based-services-application/>
- Rambox 功能页：<https://rambox.app/features/>；休眠配置：<https://support.rambox.app/support/solutions/articles/42000027661-how-to-create-and-configure-apps->；Focus Mode：<https://support.rambox.app/support/solutions/articles/42000027999-focus-mode>
- WebCatalog/Singlebox：<https://webcatalog.io/en/desktop> 及 changelog：<https://webcatalog.io/en/desktop/changelog>
- Beekeeper Studio：<https://www.beekeeperstudio.io/features>、<https://docs.beekeeperstudio.io/user_guide/connecting/connecting/>；导出缺失 issue：<https://github.com/beekeeper-studio/beekeeper-studio/issues/1645>
- Station（Launch HN）：<https://news.ycombinator.com/item?id=18123596>
- Crystal：<https://github.com/stravu/crystal>（HN：<https://news.ycombinator.com/item?id=45531558>）
- Conductor：<https://www.conductor.build/>（HN：<https://news.ycombinator.com/item?id=44594584>）
- Opcode：<https://github.com/winfunc/opcode>
- Happy：<https://happy.engineering/>（GitHub：<https://github.com/slopus/happy>）
- Omnara：<https://omnara.com/>（GitHub README：<https://github.com/omnara-ai/omnara/blob/main/README.md>）
- Teragon 讨论：<https://nl.linkedin.com/pulse/weekend-ai-experiments-polymet-codex-terragon-claude-code-eftimie-tj7lf>
- sugyan/claude-code-webui：<https://github.com/sugyan/claude-code-webui>；siteboon/claudecodeui：<https://github.com/siteboon/claudecodeui>；AgentOS（HN）：<https://news.ycombinator.com/item?id=46533405>
- Cline 自动批准/检查点：<https://docs.cline.bot/features/auto-approve>、<https://github.com/cline/cline>；Roo Code 自动批准：<https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions/>
- Claude Desktop MCP 指南：<https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop>；Quick Prompt 讨论：<https://www.reddit.com/r/ClaudeAI/comments/1p86fy9/>
- Warp：<https://docs.warp.dev/>；Wave Terminal：<https://www.waveterm.dev/>（GitHub：<https://github.com/wavetermdev/waveterm>）
- MenubarX：<https://apps.apple.com/us/app/menubarx-floating-browser/id1575588022>（FAQ：<https://menubarx.app/faq/>）；FloatBrowser：<https://apps.apple.com/us/app/menubar-browser-floatbrowser/id6497651451>
- Electron 更新文档：<https://electronjs.org/docs/latest/tutorial/updates>；electron-updater（含 stagingPercentage）：<https://www.electron.build/docs/features/auto-update/>；安全更新指南：<https://blog.doyensec.com/2026/02/16/electron-safe-updater.html>
- Electron 全局快捷键：<https://electronjs.org/docs/latest/tutorial/keyboard-shortcuts>；Spotlight 式窗口：<https://github.com/electron/electron/issues/4939>、<https://stackoverflow.com/questions/36893426/>
- 托盘徽章实现：<https://electronjs.org/docs/latest/api/tray>、<https://dev.to/randomengy/dynamic-generation-of-task-bar-overlay-icons-in-electron-27in>、<https://github.com/electron/electron/issues/7440>、<https://stackoverflow.com/questions/31813947/>
