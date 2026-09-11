# DeepSeek Harness Shell

一个**零后端、纯外壳**的 DeepSeek Harness 桌面托盘应用（Electron + TypeScript），提供与 DSH 一致美术风格的独立原生窗口，并能在启动时自动拉起本地 DSH 服务。v1.0 起支持**并行多窗口**：同时连接多个 DSH 服务器（或同一服务器的多个会话），每个连接独立窗口、独立会话分区、可选独立代理。

## 特性

- **并行多窗口（v1.0）**：**一 URL 一窗口**——同一地址重复连接只聚焦已有窗口，不同地址各自开窗（上限 8 个），重启自动恢复最近 5 个。每个连接跑在独立 `persist:dsh-<连接id>` 分区：cookie/storage 互不串扰、互不下线。窗口状态（位置/尺寸/最大化/缩放/置顶）按连接分别记忆；未读计数跨窗口求和，托盘列出全部会话（带未读前缀）点击聚焦；`Ctrl+Alt+N` 全局热键在会话窗口间轮转。菜单「⋯ → 新建连接窗口…」随时加开 login 窗口。**代价**：独立分区意味着每个连接首次打开都需要重新登录一次 DSH（v1.0 接受的取舍，换 A5 每连接代理的前提）。
- **每连接代理（A5）**：login「已保存连接」条目上的 **⇄** 内联编辑器：填入代理地址（`http:` / `https:` / `socks:` / `socks4:` / `socks5:`，必须显式端口、不接受内嵌凭据）与绕过列表（逗号/空白分隔），或一键「直连（清除代理）」。连接时仅对该连接自己的分区 `setProxy`，不影响其他窗口；已配置代理的连接在列表行上以「SOCKS host:port（绕过 n 条）」徽标展示。
- **连接健康（A3）**：「服务器 ▾ → 连接健康…」（命令面板同入口）：对当前服务做一次就绪探测，展示响应时延、页面暴露的 DSH 版本与本机监听进程 PID，排障时不用再开任务管理器。
- **隐藏时保持网络（D2）**：内容视图关闭后台节流（`backgroundThrottling: false`）——窗口最小化/藏进托盘时 DSH 的会话轮询与流式回复照常走网络；不可见时渲染开销随 Chromium 天然下降，不再为「省电」牺牲后台会话。
- **Login 连接界面**：左侧官方鲸鱼 logo 品牌区，右侧三种连接方式——**本地嗅探**（探测本机已运行的 DSH Web，列出实例一键连接）/ **GUI 启动本地服务器**（spawn `dsh web` 并显示实时进度，自动在 npx 缓存里找 `dsh`；支持**指定端口**，留空自动选随机端口，端口被占用会把 dsh 的报错提示给你）/ **云端服务器**（输入远程 URL，非回环地址弹确认）。另有**最近连接**列表与**已保存连接**配置库（名称 + 地址，支持点击连接、置顶、重命名、删除、代理编辑）。仅首次或配置失效时出现，有配置时直接连接零打扰。
- **标题栏功能菜单**：连接成功后标题栏中部显示当前地址与「断开连接 ▾」；右侧动作区提供**窗口置顶**开关（激活态高亮）、「服务器 ▾」（启动本地 DSH 服务、停止本地服务、连接健康…、切换服务器、重新加载页面 / 强制重新加载[忽略缓存]、在浏览器中打开当前服务器）与「⋯」更多菜单（**新建连接窗口…**、检查更新、关于、快捷键设置、**关闭时收进托盘**开关、缩放子菜单、退出）。断开菜单按连接形态显示：本应用启动的本地服务 → 「断开连接并关闭本地服务」；嗅探连接的外部本机实例 → 「断开连接并关闭服务器」（按端口定位监听进程，先做 DSH 指纹复核并在确认弹窗中列出 PID，用户确认后结束进程树；远程服务器无法从本机关闭）。全部为原生 `Menu.popup()`：绘制在所有 Web 内容之上（不被 DSH 内容视图遮挡），Esc / 点击外部自动收起（Windows/Linux 上跟随系统深浅色），菜单右侧组合键文案随当前绑定实时更新。
- **命令面板（Ctrl+K）**：键盘优先的快速操作入口——**新建连接窗口**、切换最近连接、启停本地服务、断开/切换服务器、连接健康、重载/强刷/页内查找、缩放三档、置顶、检查更新、快捷键设置、勿扰开关、退出。模糊过滤 + ↑↓/Enter/Esc 导航；动作清单由主进程按当前状态构建，渲染层只回传清单内的 id（无法注入任意命令）；面板打开期间 DSH 内容视图临时摘下（与快捷键设置面板同机制），关闭原样挂回。快捷键可在设置面板重绑，「⋯」菜单亦有入口。
- **代理状态通知 + 未读角标 + 勿扰**：零注入监听页面标题的 "(n)" 未读前缀——窗口藏在托盘且计数增加时弹系统通知（点击聚焦），Windows 任务栏覆盖数字角标 / macOS Dock 徽标 + 托盘数字 / Linux 桌面角标，窗口聚焦即已读清零。勿扰模式（托盘与「⋯」菜单 checkbox）开启后通知静默、角标保留，标题栏显示「勿扰」指示并持久化记忆。
- **勿扰时段 + 通知聚合**：设置面板可配置定时勿扰（支持跨天），未读通知短时间多次增长会自动合并为一条，避免连续轰炸。

- **快捷键绑定（应用内自定义）**：「⋯ → 快捷键设置…」面板查看 / 重绑全部快捷键——**全局唤起热键**与**内容视图快捷键**（命令面板、页面内查找、重载、强制重载、缩放三档）点击即录制重绑（Esc 取消、Backspace 清除、与其他动作冲突即时拒绝并提示；字母/数字/符号需配合 Ctrl 或 Alt，F 功能键可单独绑定），绑定持久化、全局热键换绑即时重注册；面板打开期间 DSH 内容视图临时摘下，关闭后原样挂回不重载。`DSH_HOTKEY` 环境变量仅在从未自定义时生效（'off' = 解绑），一旦在面板重绑 / 重置即固定为面板值。
- **内容视图工具**：连接后 `Ctrl+F` 页面内查找（标题栏下方查找栏：实时 `n/m` 计数、Enter / Shift+Enter 跳转、Esc 关闭并清除高亮，打开时内容视图自动下移让位）；`Ctrl+R` / `F5` 重新加载、`Ctrl+Shift+R` 忽略缓存强刷；`Ctrl+=` / `Ctrl+-` / `Ctrl+0` 按 Chromium 档位缩放（0.5–2.0，持久化记忆，「⋯」菜单缩放子菜单显示当前百分比）。快捷键统一由主进程在内容视图 `before-input-event` 捕获——DSH 页面保持**零注入**，且全部可重绑。
- **托盘常驻**：关闭窗口默认 = 隐藏到托盘（「⋯」菜单的「关闭时收进托盘」开关可改为直接关闭该会话窗口）；托盘菜单列出全部会话窗口（带未读前缀）点击聚焦，外加「打开窗口（新建） / 退出」兜底。单击托盘图标切换窗口显隐，提示文本显示当前连接地址。
- **命名连接配置库 + 导入/导出**：`shell-state.json` 以结构化连接档案替代纯地址列表（含每连接代理），旧版「最近连接」自动迁移；「⋯ → 更多」菜单提供「导出连接… / 导入连接…」，便于多机器迁移与备份（调研 Beekeeper Studio / WebCatalog 后补齐的连接管理能力）。
- **可配置 URL**：`--url` > `DSH_URL` > 共享配置，三级来源。
- **连接管理**：login 的「已保存连接」显示名称 + 地址，支持点击连接、置顶、重命名、删除；「⋯ → 更多」菜单提供「诊断日志…」，可查看运行状态与最近 500 行 dsh 日志并导出。
- **DSH 风格自绘标题栏**：无边框窗口 + 自绘标题栏，匹配 Harness 设计平台 token，并跟随 DSH「外观」设置即时切换深浅色。
- **全局快捷键（5 个，均可在设置面板重绑）**：`Ctrl+Shift+D` 任意位置唤起/收起窗口；`Ctrl+Alt+N` 轮转到下一个会话窗口；`Ctrl+Alt+W` 关闭当前会话窗口；`Ctrl+Alt+R` 重启本应用启动的本地服务；`Ctrl+Alt+S` 停止全部本地服务。`DSH_HOTKEY` 环境变量仅在未自定义时生效，设 `off` 禁用唤起热键。
- **深链协议 `dsh-shell://`**：`dsh-shell://show` 唤起窗口；`dsh-shell://open?url=<编码后的地址>` 直接连接指定服务器（远程地址仍走确认弹窗，仅 http/https）。
- **窗口状态记忆**：按连接记住窗口位置/尺寸/最大化/置顶/缩放（多显示器变化时自动校验，窗口不会落到屏幕外）；重启恢复最近 5 个会话窗口。
- **退出询问**：由本应用启动了本地 DSH 服务时，关闭窗口会弹窗询问「同时关闭服务并退出 / 最小化到托盘 / 取消」；托盘退出同样询问。选择保持后服务继续在后台运行，下次启动可直接嗅探连接。
- **断线自动重连**：DSH 重启/断连期间每 3 秒探测，服务恢复后自动重载页面。
- **外链 http(s) 白名单**：`window.open` 与跨源导航一律拦截，仅放行 `http:`/`https:` 交给系统浏览器。
- **零注入**：DSH 内容跑在独立的 `WebContentsView`（`sandbox:true` + `contextIsolation:true` + 无 preload）；标题栏/login 的 shell 用极窄 preload 只暴露窗口控制与连接动作。
- **开机自启 / 自动更新**：由 DSH 内 cordis 插件远程控制（见下）；开机自启时直接启动到托盘（`--hidden`），不打扰。更新对话框带 release notes 并支持「退出时自动安装」；Windows portable 版改为引导打开 Releases 页手动下载。
- **单实例锁**：二次启动只聚焦已有窗口（深链拉起同样复用已有实例）。

## 与 DSH 的联动（cordis 插件）

配套插件已拆分为**独立仓库**（测试期均标记 `private: true`，未发布到公共 npm）：

| 仓库 | 作用 |
|------|------|
| [`dsh-plugin-desktop-control`](../dsh-plugin-desktop-control) | `/desktop` 命令族：用当前 DSH web 地址打开桌面窗口、远程管理开机自启 / 触发更新 / 停止本地服务 |
| [`dsh-plugin-balance-panel`](../dsh-plugin-balance-panel) | `/balance`、`/plan` 命令 + 右下角可拖拽悬浮面板（余额明细 + Coding Plan 用量） |
| [`dsh-plugin-session-outline`](../dsh-plugin-session-outline) | 右侧栏会话大纲：只列用户消息，点击跳转到对应对话开头 |

插件与桌面应用通过**共享配置** `$DSH_HOME/desktop-shell.json`（或 `DSH_DESKTOP_CONFIG` 指定）通信：桌面应用监听该文件，响应 `autoLaunch` / `updateRequest` / `serviceStopRequest` 变化。测试期安装：在插件仓库目录用 `dsh plugin add file:<仓库路径>` 或 `npm install <git-url>`（私有仓库需 npm 凭证），详见各插件 README。

## 用法

```bash
npm install
npm run dev        # 编译 + 启动（无配置时停留 login 界面）
```

指定地址（跳过自动启动）：

```bash
npm run build
electron . -- --url http://127.0.0.1:3080
# 或
$env:DSH_URL="http://127.0.0.1:3080"; electron .
```

### 环境变量 / 深链

| 变量 | 作用 |
|------|------|
| `DSH_URL` | 默认服务器地址（优先级低于 `--url`） |
| `DSH_HOTKEY` | 全局快捷键初始值（默认 `CommandOrControl+Shift+D`；设 `off` 禁用；用户在快捷键设置里重绑/重置后以面板值为准） |
| `DSH_UPDATE_URL` | 覆盖自动更新源（generic provider；仅接受 `https`，非 https 一律忽略） |
| `DSH_DESKTOP_CONFIG` | 覆盖共享配置文件路径 |
| `--hidden` | 启动到托盘不弹窗口（开机自启自动附加） |

深链（需打包版已注册，macOS 在 `mac.protocols` 声明、Windows 运行时注册）：

```
dsh-shell://show
dsh-shell://open?url=http%3A%2F%2F127.0.0.1%3A3080%2F
```

## 测试

```bash
npm test                    # 全量：src 纯函数（vitest，18 个文件 226 例）+ 编译产物校验（node:test，46 例）
npm run test:unit           # 仅 src（vitest：url / sniffer / protocol / shell-state / dsh-launcher /
                            #  titlebar-menus / theme-prefs / server-stop / shortcuts / view-controls /
                            #  title-watcher / palette / release-notes / session-policy / health /
                            #  proxy / notify-queue / log-buffer）
npm run test:node           # Node 原生 runner（scripts/verify-url.mjs，不依赖 vite，
                            # 可在无子进程 spawn 的受限环境运行；会先编译 dist）
node scripts/verify-server-stop.mjs   # 「关闭服务器」端到端（需 spawn：子进程起 dummy
                            # 服务器 → 按端口定位结束 → 确认端口停止；见 server-stop.ts）
node_modules\.bin\electron.cmd scripts/smoke-ui.mjs   # UI 冒烟（需先 build：竞态自愈 /
                            #  菜单/快捷键面板/查找栏桥接/A5 代理编辑器；Electron 直跑，见脚本头注释）
```

（插件的测试在各自仓库内 `npm test`。）

## 发布清单

1. **版本号**：同步更新 `package.json` 与 [`CHANGELOG.md`](CHANGELOG.md)。
2. **更新源**：已配置为 GitHub Releases（`publish.github` → `alonelypigeon/dsh-desktop-shell`）。
   发布时打 `v0.2.0` 这类 tag 并上传产物到 Release 即可；如需自建服务器，
   改回 `publish.generic` 或运行时设 `DSH_UPDATE_URL`。
3. **图标/元数据**：`build/` 下的图标已就位；`linux.maintainer`、`copyright`
   发布前改成你自己的信息。
4. **签名/公证**：Windows SmartScreen 与 macOS Gatekeeper 会警告未签名安装包；
   有证书后配置 `win.certificateFile` / `mac.notarize`。
   macOS 的自动更新要求签名 + 公证后的构建。
5. **CI**：[`.github/workflows/release.yml`](.github/workflows/release.yml)
   打 `v*` tag 自动构建三平台并 `--publish always` 上传到 Release。
6. **产物**：`npm run dist:win`（NSIS + portable，建议分开执行）、
   `dist:mac`、`dist:linux`；`electron-builder --publish always` 自动上传
   `latest.yml` 与安装包到 Release（或手动 `gh release create`）。
7. **冒烟**：装完安装包后确认托盘图标、本地服务启动/停止、断线重连、
   `/desktop` 命令族与更新流程。

## 打包

```bash
npm run dist:win     # NSIS + portable（建议分开执行：先 --win nsis 再 --win portable）
npm run dist:mac     # dmg + zip
npm run dist:linux   # AppImage + deb
```

产物输出到 `release/`。安装包未签名/公证，Windows SmartScreen 与 macOS Gatekeeper 会警告。

> 打包需在可执行 `spawn` 的环境中进行（electron-builder 内部要 fork npm/makensis 等）。

### 自动更新

- 更新源在 [`electron-builder.yml`](electron-builder.yml) 的 `publish` 段（GitHub Releases provider，指向 `alonelypigeon/dsh-desktop-shell`）；需要自建服务器时可改回 generic，或运行时用 `DSH_UPDATE_URL` 覆盖。
- 上传产物：`electron-builder --publish always`（需要 `GH_TOKEN` 或 GitHub Actions 默认 token），或手动 `gh release create vX.Y.Z release/*`。
- 已知限制：Windows portable 单文件版不支持自动更新（请用 NSIS 安装版）。

## 目录结构

```
src/
  main.ts            主进程应用级：会话注册表 / 托盘 / 全局热键 / 连接配置库 / 勿扰 /
                     共享配置 / 更新 / 服务注册表 / 深链 / 启动引导（首帧关键路径之外）
  session.ts         会话（Session）：一个连接 = 一个窗口 + 一个内容视图；窗口事件、
                     查找栏、缩放、重连轮询、未读、窗口级 IPC（校验 event.sender）
  session-policy.ts  多窗口纯策略：会话键 / 上限(8) / 恢复计划(5) / 未读聚合 /
                     最近活跃轮转 / 分区名 / 托盘标签（纯函数，可测）
  health.ts          连接健康判定（A3）：就绪探测结果的解读纯函数（可测）
  health-runtime.ts  健康探测执行：时延 / DSH 版本 / 监听进程 PID
  proxy.ts           每连接代理（A5）：解析校验 / 展示文案 / 转 session.setProxy
                     入参（纯函数，可测；明文 JSON 不存凭据、必须显式端口）
  config.ts          URL 来源解析（--url > DSH_URL > 共享配置）
  shared-config.ts   与 cordis 插件共享的配置读写（fs.watch 即时响应）
  dsh-launcher.ts    启动本地 dsh（PATH / npx 缓存 / DSH_HOME 三级查找）并嗅探 URL
  titlebar-menus.ts  标题栏下拉菜单模板：断开 / 服务器 / 更多（纯函数，原生 Menu.popup 呈现）
  palette.ts         命令面板动作清单构建（纯函数，可测；执行分发在 main.ts）
  title-watcher.ts   页面标题未读计数解析（"(n)" 前缀，纯函数，可测）
  release-notes.ts   Release 描述剥纯文本 + 截断（纯函数，可测）
  shortcuts.ts       快捷键绑定体系：动作 / 默认值 / 加速器解析校验 / 录制判定 / 冲突（纯函数，可测）
  view-controls.ts   内容视图缩放档位 / 查找计数（纯函数，可测）
  server-stop.ts     停止外部本机 DSH 服务器（netstat/lsof 按端口定位进程；解析纯函数可测）
  shell-ui-state.ts  shell 页面 UI 状态统一推送（含加载竞态自愈）
  sniffer.ts         本地 DSH 实例嗅探（html + favicon 双特征判定）
  security.ts        外链 http(s) 白名单 + 敏感权限策略
  probe.ts           URL 就绪探测
  theme.ts           读取 DSH「外观」设置并跟随切换
  theme-prefs.ts     settings.yaml/json 的外观偏好解析（纯函数，可测）
  updater.ts         自动更新（electron-updater）
  url.ts             URL 校验 / CLI 解析 / 优先级 / 回环判定（纯函数，可测）
  protocol.ts        dsh-shell:// 深链解析（纯函数，可测）
  shell-state.ts     窗口状态（bounds/最大化/置顶/最近连接）读写与校验（纯函数，可测）
  shell-preload.ts   标题栏 / login 窗口控制桥接
  shell.html / shell.css / shell.js   标题栏 + login 界面（外置样式与脚本，CSP 无 unsafe-inline）
scripts/
  clean.mjs           空编译产物（防残留旧文件）
  copy-static.mjs / generate-icons.mjs / generate-badges.mjs（未读角标图，纯 Node 生成）
  / verify-url.mjs / smoke-ui.mjs（UI 冒烟，需先 build）
build/               图标资源（官方鲸鱼 favicon）+ badges/（未读角标图）
docs/                路线图、竞品调研存档与性能基线（perf-baseline.md）
```

> 配套 cordis 插件不在本仓库，见上文「与 DSH 的联动」。

## 安全设计

DSH 页面（包括云端服务器）按**不可信内容**处理：

- **零注入**：DSH 内容跑在独立 `WebContentsView`（`sandbox:true` + `contextIsolation:true`、无 preload、`nodeIntegration:false`），渲染层 XSS 无法升级为 Node/主进程 RCE；不使用已废弃的 `<webview>`。多窗口下每个连接使用独立 `persist:` 分区，页面状态互不共享、也无法借此越权。
- **导航/弹窗守卫**：`will-navigate` + `setWindowOpenHandler` 拦截一切偏离 DSH 源的导航与 `window.open`，仅放行 `http:`/`https:` 交给系统浏览器——这正是 CVE-2026-33336（Vikunja Desktop 同窗口导航 RCE）一类的漏洞面。
- **权限白名单**：仅放行剪贴板、通知、全屏、指针锁定等常规能力；其余（摄像头/麦克风/定位/串口/HID/USB/蓝牙/屏幕捕获，以及 Electron 未来新增的敏感权限）一律默认拒绝。
- **IPC 白名单**：shell 窗口的 preload 只暴露窗口控制与连接动作；所有 IPC handler（应用级与会话级）校验 `event.sender`，DSH 内容视图完全不持有 IPC 通道。
- **协议白名单**：连接 URL 只接受 `http:`/`https:`（`file:`/`javascript:`/`smb:` 等一律拒绝）；非回环地址连接需用户确认。
- **二进制加固**：打包时启用 Electron fuses——禁用 `RunAsNode`、node 选项注入与 `--inspect` 远程调试参数，启用 cookie 加密与 asar 完整性校验，仅允许从 asar 加载应用。

## 路线图

v1.0 已落地并行多窗口会话（多窗口管理、每连接分区/代理、连接健康、全局热键扩展、效率与包体优化，详见 [`CHANGELOG.md`](CHANGELOG.md) 1.0.0 与 [`docs/perf-baseline.md`](docs/perf-baseline.md)）。历史规划与依据见 [`docs/roadmap.md`](docs/roadmap.md) 与 [`docs/competitive-research-2026-08.md`](docs/competitive-research-2026-08.md)。

## 说明

- 社区实验项目，非 DeepSeek 官方产品。
- 上游 DSH 处于 Developer Preview；本外壳依赖的是 URL 与共享配置，而非 Web UI 内部结构。
