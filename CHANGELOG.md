# Changelog

本仓库仅包含桌面外壳（dsh-desktop-shell）。配套 cordis 插件
（dsh-plugin-desktop-control / dsh-plugin-balance-panel / dsh-plugin-session-outline）
已拆分为独立仓库，各自维护版本与变更记录。

## [0.8.1] - 2026-09-02

### 安全加固

- **`desktopExe` 写入门槛**（Mimosa 中危发现：环境变量 → 共享配置 → 插件
  spawn 的跨文件污点路径）：注册自身可执行路径到共享配置时，
  `PORTABLE_EXECUTABLE_FILE` 仅在**打包构建**（`app.isPackaged`）+ **绝对路径** +
  **目标文件真实存在**三重校验全过时才采用，否则一律回退自身 `execPath`——
  开发态/被注入的相对路径/不存在的路径都无法把任意 spawn 目标写进共享配置
  供 `/desktop open` 使用。

## [0.8.0] - 2026-09-01

### 新增

- **远程通知通道（`notifyRequest`）**：cordis 插件（如 `dsh-plugin-desktop-control`
  的 `/desktop notify`）把通知请求写进共享配置，外壳轮询/watch 到后弹系统通知
  并清空请求。与 autoLaunch / updateRequest / serviceStopRequest 同一通信模式
  （DSH 进程内无法直接调 Electron API）。细节：
  - 请求一次弹一条：按 `id` 去重（`notify-queue.ts` 纯函数状态机，带单测）；
    外壳启动时快速清掉插件在启动前写入的请求（瞬态事件不补弹）。
  - 复用勿扰约束（定时勿扰期间静默丢弃）与 `Notification.isSupported` 守卫；
    点击通知聚焦窗口；失败仅 console.warn（通知尽力而为）。
  - 共享配置 `loadSharedConfig` 对 `notifyRequest` 做字段校验（id/title/body
    字符串、silent 仅接受 true），损坏字段视为无请求。
- 安全加固（评审发现，行为不变）：`readDshThemePreference` 拒绝**相对路径**
  `DSH_HOME`（原来直接使用，相对路径会随进程 cwd 漂移，读取无稳定语义），
  DSH 配置文件名明确为受控枚举并在读取前校验解析结果落在 home 边界内；
  `killTree` 校验 pid 数值合法性并显式 `shell: false` 调用 taskkill。

## [0.7.0] - 2026-08-24

### 修复

- **GUI 启动本地 DSH 服务不再弹系统浏览器**：上游 `dsh web` 更新后默认会在
  本机默认浏览器中打开 Web UI。桌面外壳已经用独立内容视图承载页面，因此
  `dsh-launcher` 启动参数显式追加 `--no-open`，避免每次通过 GUI 启动服务时
  额外弹出浏览器标签。

### 新增

- **命名连接配置库（A1）+ 导入/导出（A4）**：`shell-state.json` 新增
  `connections` 结构化字段（`{ id, name, url, kind, lastUsed }`），加载时自动
  从旧版扁平 `recentServers` 迁移；`buildDshWebArgs` 与连接管理纯函数
  （`makeConnectionId` / `normalizeSavedConnection` / `migrateConnections` /
  `mergeSavedConnection` / `removeSavedConnection` / `renameSavedConnection` /
  `exportConnections` / `parseConnectionsImport`）均带单测。「⋯ → 更多」菜单
  新增「导出连接…」和「导入连接…」，导入后自动合并进配置库并刷新最近连接列表。
- **内容视图独立 session（S1）**：主内容视图统一使用
  `partition: 'persist:dsh'`，远程页面 cookie/storage 与外壳默认 session 隔离，
  为后续多账号/按连接代理打下安全基础。
- **命名连接配置库 UI（A1 补全）**：login 界面新增「已保存连接」区，显示
  连接名称与地址，支持点击连接、置顶、重命名、删除；主进程新增对应 IPC。
- **诊断与日志导出（D3）**：「⋯ → 更多」新增「诊断日志…」，汇总应用版本、
  连接状态、本地服务状态、已保存连接数以及最近 500 行 dsh 启动日志，并支持
  导出为 `.log` 文件；`dsh-launcher` 支持 `onLog` 回调接入环形缓冲。
- **勿扰时段（B3）**：设置面板新增「勿扰时段」，可启用定时静默并配置开始/结束
  时间（支持跨天，如 22:00–07:00）；定时勿扰期间系统通知静默，未读徽章保留。
- **通知聚合（B4）**：未读计数在短时间内多次增长时合并为一条通知，避免连续
  弹“1、2、3…”的轰炸；窗口重新聚焦后自动取消待发送通知。

- **调研落地**：对应 [`docs/competitive-research-2026-08.md`](docs/competitive-research-2026-08.md)
  中 Beekeeper Studio 连接管理 UX、WebCatalog Spaces 多账号并存、以及
  Beekeeper 缺失导出能力被用户长期抱怨（issue #1645）的需求证据。


## [0.6.0] - 2026-08-19

### 新增

- **命令面板（Ctrl+K）**：键盘优先的快速操作入口——切换到最近连接、启动/停止
  本地服务、断开/切换服务器、重载/强刷/页内查找、缩放三档（显示当前百分比）、
  置顶开关、检查更新、快捷键设置、勿扰开关、退出。动作清单由主进程按当前
  状态构建（纯函数 `palette.ts`，连接相关动作未连接时自动隐藏），渲染层本地
  模糊过滤（子串 + 子序列）+ ↑↓/Enter/Esc 键盘导航；执行只回传清单里的 id，
  主进程校验后才分发——渲染层无法注入任意命令。面板打开期间 DSH 内容视图
  临时摘下（与快捷键设置面板同机制、互斥），关闭原样挂回不重载。快捷键可
  在设置面板重绑（进动作白名单，默认 `Ctrl+K`）；「⋯」菜单新增入口。
- **代理状态通知 + 未读角标**：零注入前提下监听页面标题的 "(n)" 前缀
  （`page-title-updated`，解析纯化为 `title-watcher.ts`）——窗口隐藏/最小化
  且计数增加时弹系统通知「DSH 需要你的注意」，点击聚焦窗口；同时三平台
  显示未读角标：Windows 任务栏覆盖图标（`setOverlayIcon`，预渲染数字角标图
  `build/badges/`，`scripts/generate-badges.mjs` 纯 Node 生成）、macOS
  Dock 徽标 + 托盘数字（`setBadgeCount` / `tray.setTitle`）、Linux 桌面
  角标。窗口聚焦即视为已读自动清零；断开/切换连接时清空。
- **勿扰模式**：托盘菜单与「⋯」菜单 checkbox 一键切换（也可从命令面板），
  开启后系统通知静默（未读角标保留），标题栏地址旁显示「勿扰」指示；状态
  持久化在 `shell-state.json`，重启保持。
- **更新体验三件套**：① 更新对话框展示 release notes（GitHub Release 描述
  剥成纯文本，纯函数 `release-notes.ts`），并支持勾选「下载完成后退出时
  自动安装」（勾选后跳过「立即重启」打扰）；② `electron-builder.yml` 预留
  `stagingPercentage` 灰度注释（坏更新保险丝）；③ Windows portable 版检测
  到无法 in-place 更新时，「检查更新」改为引导打开 Releases 页面手动下载
  （整套 updater 对 portable 跳过）。

### 文档

- 新增 [`docs/competitive-research-2026-08.md`](docs/competitive-research-2026-08.md)：
  竞品调研存档——四类同类产品（工作台聚合器 / 托盘优先应用 / AI 编码代理
  GUI / Electron 壳工程实践）概览 + 20 项功能创意（A–E 五主题）+ Top 5 排名。
- 新增 [`docs/roadmap.md`](docs/roadmap.md)：版本路线图——v0.6 感知与效率
  （代理状态通知、托盘/任务栏徽章、勿扰模式、Ctrl+K 命令面板、更新体验
  三件套）→ v0.7 多连接与监控（命名连接配置库、健康/诊断
  面板、内容视图独立 session）→ v0.8 体验打磨 → v1.0 并行多窗口会话；
  每项含实现要点（对应模块）与验收标准。
- README 增加路线图入口与 docs/ 目录说明；「断开连接并关闭服务器」
  （PID 确认 + 指纹复核）与权限白名单两处描述与实现对齐。

### 安全加固

- **「断开连接并关闭服务器」增加进程确认**：该功能按端口定位并结束本机
  进程树，此前一键直达——手动连接到 `127.0.0.1:<任意端口>` 后点一下就会
  杀掉恰好监听该端口的无关本机服务（开发服务器 / 数据库等）。现在先定位
  进程、在确认弹窗中**列出将被结束的 PID**，并尽力做一次 DSH 指纹校验
  （index 特征 + 官方鲸鱼 favicon，与本地嗅探同标准，抽出
  `sniffer.isDshInstance`）；校验未通过（如页面需要登录）时改用强警告
  文案且默认按钮为「取消」。`server-stop.ts` 拆为「定位
  （`resolveExternalServerTarget`）/ 终止（`terminateExternalServer`）」
  两阶段，组合入口保留给 e2e 脚本。
- **启动自动连接补确认弹窗**：`--url` / `DSH_URL` / 共享配置里的非回环
  地址此前会绕过「连接远程服务器」确认直接加载（共享配置文件是本机任意
  进程可写的 cordis 通道，被篡改后可在启动时静默加载钓鱼页）。现在与手动
  连接 / 深链走同一条 `confirmRemoteConnect` 确认路径，回环地址保持免打扰。
- **更新源仅接受 https**：`DSH_UPDATE_URL` 环境变量此前可把更新源指向
  任意 generic URL——安装包未做代码签名，http 源可被中间人替换后诱导
  「一键安装」实现代码执行。现在非 https 的覆盖直接忽略并告警；同时
  删除已过时的 example.com 占位符检测（发布源已固定为 GitHub Releases）。
- **URL 内嵌凭据剥离**：`validateUrl` 现在剥掉 `user:pass@host` 形式的
  内嵌凭据——该 URL 会明文写入 `shell-state.json`（最近连接列表 / 托盘
  提示）与 `~/.dsh/desktop-shell.json` 共享配置。
- **重定向后地址如实显示**：服务端 3xx 重定向不经过 `will-navigate`
  守卫，标题栏与托盘此前一直显示连接时的地址（「标签写着 A、页面实为 B」
  的钓鱼误导）。现在跟踪 `did-navigate` / `did-navigate-in-page` 的实际
  地址用于展示，主源变化时记录告警日志。
- **纵深防御**：shell 窗口自身补上「弹窗一律拒绝 + 仅允许 file: 导航」
  守卫；权限策略由黑名单改为**白名单**（仅剪贴板 / 通知 / 全屏 /
  pointerLock，其余含未来新增权限默认拒绝），并移除失效的
  `openExternal` 权限名；「在浏览器中打开」改走 `openExternalSafe`；
  标题栏菜单锚点坐标补充 NaN / Infinity 校验。
- **状态文件权限收紧（POSIX）**：`shell-state.json`（最近连接地址等）与
  `~/.dsh/desktop-shell.json` 共享配置写入后 `chmod 0600`，仅属主可读写。
- **发布 CI 修复重复 Release**：三个平台的 matrix job 并行执行
  `--publish always` 会竞争创建 Release，v0.5.0 因此被创建了两次（其中
  一条只挂了部分 mac 产物）。改为 Windows 先行创建 Release（含
  latest.yml），macOS / Linux `needs` 依赖其后附加产物。

### 新增

- **连接状态可视化 + 断线/恢复系统通知**：断线自动重连原本是静默的——
  DSH 重启期间用户只看到页面转圈。现在服务断开时（`did-fail-load`）
  标题栏连接区状态点变黄并弹系统通知「连接已断开，正在自动重连…」，
  服务恢复自动重载页面后状态点回绿并通知「已恢复连接」（通知仅在
  已连接过的场景触发、断线期间去重；页面 reload 后状态点颜色经
  `shell-ui-state` 自愈推送保持）。状态点与「重新加载」等操作互不影响。

## [0.5.0] - 2026-08-18

### 新增

- **快捷键绑定（应用内自定义）**：「⋯ → 快捷键设置…」面板可查看 / 重绑
  全部快捷键——**全局唤起热键**与**内容视图快捷键**（页面内查找 / 重新
  加载 / 强制重载 / 缩放三档）。点击按键组合即录制重绑：Esc 取消、
  Backspace 清除绑定；字母/数字/符号需配合 Ctrl 或 Alt（Shift 单修饰会
  干扰页面输入，拒绝绑定），F 功能键可单独绑定；与其他动作撞车即时拒绝
  并提示冲突对象。绑定持久化在 `shell-state.json`（'' = 显式解绑，动作仍
  可从菜单触达），全局热键换绑即时重注册（先精确注销旧加速器）；
  `DSH_HOTKEY` 环境变量仅在用户从未自定义过全局热键时生效（'off'/空 =
  解绑），面板里重绑或重置后固定以面板值为准。面板打开期间 DSH 内容视图
  临时摘下（否则视图会盖住 shell 页面），关闭后原样挂回、连接与页面状态
  不变。加速器解析 / 录制判定 / 匹配 / 冲突检查纯化为 `shortcuts.ts`
  （Ctrl 与 ⌘ 同义归一为 `CommandOrControl`，绑定跨平台可用），面板状态
  经 `shell-ui-state` 的 did-finish-load 自愈路径重发。
- **内容视图工具：页面内查找 / 重新加载 / 缩放**：连接 DSH 后——
  `Ctrl+F` 弹出标题栏下方查找栏（实时 `n/m` 计数、Enter / Shift+Enter
  上一个下一个、Esc 关闭并清除高亮；打开时内容视图自动下移让位）；
  `Ctrl+R` / `F5` 重新加载、`Ctrl+Shift+R` / `Ctrl+F5` 忽略缓存强刷
  （「服务器 ▾」菜单同款入口，未连接禁用）；`Ctrl+=` / `Ctrl+-` /
  `Ctrl+0` 按 Chromium 档位缩放（0.5–2.0，持久化记忆，「⋯」菜单新增
  缩放子菜单并显示当前百分比）。快捷键统一由主进程在内容视图
  `before-input-event` 按当前绑定捕获（DSH 页面零注入不变），档位步进 /
  计数文案纯化为 `view-controls.ts`；菜单里的组合键文案随绑定实时更新。
- **断开连接并关闭服务器（外部本机实例）**：断开菜单新增第三项，针对
  嗅探连接的**非本应用启动**的本机 DSH 实例——DSH web 没有停机端点、
  插件的 serviceStopRequest 是单向握手（插件→应用），因此按端口定位
  监听进程（Windows `netstat -ano` / POSIX `lsof`）并结束其进程树
  （`server-stop.ts`，解析函数纯化可测；排除系统进程与自身 PID，
  结束后探测端口停止响应才判定成功，结果弹窗反馈）。本应用启动的
  服务仍走精确的「关闭本地服务」；远程服务器无法从本机关闭、不显示该项。
- **标题栏功能菜单**：此前藏在托盘二级菜单里的功能全部上移到标题栏——
  右侧动作区新增**窗口置顶**开关（激活态品牌色高亮，`toggleAlwaysOnTop`
  IPC）、「服务器 ▾」（启动本地 DSH 服务、停止本地服务[未启动时禁用]、
  切换服务器、在浏览器中打开当前服务器）与「⋯」更多菜单（检查更新、
  关于、退出）。均为原生 `Menu.popup()`。菜单模板抽为纯函数
  `titlebar-menus.ts`（三组构建器 + 名称校验，可单测）；UI 状态推送
  （`shell-ui-state.ts`）增加 `alwaysOnTop`，置顶按钮随状态同步且
  免疫加载竞态。托盘菜单简化为「打开/隐藏窗口 / 退出」兜底入口。
- **还原图标重绘**：原「方块 + 穿过方块的 L 线」造型观感异常，改为
  标准双矩形还原图标。

### 优化

- **连接按钮文案随所选方式变化**：三种连接方式共用一句「连接」语义不清
  （嗅探方式点它其实是重新扫描、本地方式点它是启动服务器）——现在本地
  嗅探显示「重新嗅探」（进入页面已自动嗅探一次）、GUI 启动本地服务器
  显示「启动并连接」（busy 态「启动中…」）、云端服务器显示「连接」
  （busy 态「连接中…」），切换卡片即时更新，复位路径（连接成功 /
  页面重新可见）同步刷新。
- **login 界面重设计（统一设计语言）**：连接方式卡片加入品牌色图标
  （嗅探 / 终端 / 云端），原生 radio 视觉隐藏、键盘焦点改为卡片聚焦环
  呈现；输入框统一品牌色聚焦环（描边 + 柔和光环）与占位符样式；连接
  按钮改全宽 40px 主按钮并带 busy 转圈动画；表单限宽 460px 居中
  （宽窗口下不再拉满）；最近连接与嗅探实例条目加运行状态绿点（与标题栏
  连接指示同款）、超长地址省略号截断；左侧品牌区新增特性清单（本地
  运行 / 沙箱零注入 / 自动重连）与页脚文案，两种主题下左侧保持深色品牌
  锚点、右侧表单全量走设计 token 跟随深浅色。

### 重构

- **断开连接菜单改用原生 `Menu.popup()`**：原「独立子窗口 + 独立页面 +
  IPC 桥接 + 主题同步 + 焦点管理」的实现（conn-menu.ts/.html 及配套
  CSS/JS、4 个 IPC 通道）整体移除，改为原生菜单——绘制在所有 Web 内容
  之上（不被 DSH 内容视图遮挡）、Esc / 点击外部自动收起、无页面加载
  竞态。菜单模板抽为纯函数 `buildDisconnectMenuItems`（可单测）。
  代价：Windows/Linux 上菜单跟随系统深浅色而非 DSH 应用内主题。

### 修复

- **切换服务器回来后连接按钮残留「连接中…」禁用态**：连接成功只隐藏
  login 页面、从不发成功结果，按钮 busy 态无人复位——「切换服务器 /
  断开连接」回到 login 时按钮停在「连接中…」且不可点。`connectTo` 成功
  路径现在补发 `login:result {ok:true}`；login 重新可见时渲染层再兜底
  复位一次（覆盖成功消息在页面隐藏期间被丢弃的情况），同时清掉非嗅探
  方式残留的旧状态文案。UI 冒烟新增该回归（复现 busy → 重新可见复位 →
  成功消息复位）。
- **连接后标题栏连接状态不显示（本机连接必现竞态）**：`connectTo` 对本机
  服务几毫秒即完成，`attachContentView` 推送的 `login:visible` /
  `connection-changed` 在渲染器加载 shell.js（注册监听器）之前发出，
  Electron 对无监听者的消息静默丢弃 → 「断开连接」按钮永不出现、页面
  停留在 login 态。新增 `shell-ui-state.ts#pushShellUiState`：页面每次
  `did-finish-load` 后重发全部 UI 状态，使其自愈（也覆盖 reload）。
  UI 冒烟测试新增确定性竞态回归（在 loadFile 完成前抢发消息）。
- **最大化状态不记忆 / 启动图标脱节**：`shell-state.json` 新增
  `maximized` 标志（bounds 始终只存普通态尺寸）；启动时按标志恢复
  最大化；Windows「关闭时最大化 → 重开自动最大化」启发式导致的初始
  图标脱节由上述 did-finish-load 状态重发一并修复。
- **切换服务器时 `will-navigate` 守卫叠加**：复用内容视图二次连接时
  旧 origin 的守卫监听器未摘除，会把新服务器的站内导航误判为跨源并
  甩给系统浏览器；`attachSecurity` 现为幂等（先移除上一次的守卫）。
- **IPv6 回环误判为远程**：WHATWG URL 的 `hostname` 对 IPv6 保留方括号
  （`[::1]`），旧判断 `host === '::1'` 永远不成立导致本机 `::1` 也弹
  确认框；新增 `isLoopbackHost` 纯函数（127.0.0.0/8 / localhost /
  `[::1]` / `[::ffff:127.0.0.1]`）。
- **外观偏好 YAML 解析**：旧正则含 JS 不支持的 `\z` 转义（行为靠侥幸），
  且整段逻辑零测试；抽为纯函数 `theme-prefs.ts` 逐行解析并补 12 个用例。
- **退出询问期间的窗口销毁边角**：托盘「退出」弹框等待期间再点窗口 ✕
  会真的销毁窗口，随后「取消退出」则应用留在托盘却无窗口可唤。
- **嗅探探测共享一个超时**：index 与 favicon 两次请求共用一个 3s
  AbortController，第一次吃满时间后第二次只剩零头会误判；改为每次
  fetch 独立超时。另清理 dsh 启动兜底超时 timer（unref + settle 清理）。

### 安全

- **shell 页面 CSP 收紧**：`shell.html` 的内联 `<style>`/`<script>` 外置为
  `shell.css`/`shell.js`，CSP 从 `script-src 'self' 'unsafe-inline'` 收紧为
  `script-src 'self'`（样式同理）。

### 其他

- 两份几乎相同的退出询问对话框合并为 `promptQuitDecision`；
  `ownedDsh.url === connectedUrl` 判断抽为 `isOwnedUrl` / `isOwnedConnection`；
  移除死代码 `config.ts#saveUrl`。

## [0.4.0] - 2026-08-15

### 修复

- **断开连接下拉菜单被 DSH 内容视图遮挡（渲染为空）**：连接后 DSH 页面跑在
  `WebContentsView` 里，始终合成在 shell 页面之上，标题栏内的绝对定位弹层
  一旦延伸到标题栏下方就会被整块盖住。菜单改为**独立子窗口**
  （`conn-menu.html`，frameless + transparent + 父窗口置顶），并修正为
  `showInactive()` 打开 —— **不再抢键盘焦点**，避免「菜单打开后所有按键失灵」；
  点击主窗口任意处 / Esc / 菜单失焦 / 父窗口移动缩放隐藏都会自动收起。

### 新增

- **login 界面登录记录管理**：最近连接列表每条记录带「×」删除按钮、
  头部「清除全部」按钮（IPC `login:remove-recent` / `login:clear-recent`，
  纯函数 `removeRecentServer` / `clearRecentServers` 可测）。
- **按钮样式与 DSH 风格统一**：新增 `ghost-btn` / `icon-btn` 组件样式
  （透明底 + 描边 + 悬停底色，主操作色沿用品牌蓝，危险操作用红色系），
  与 DSH 设计平台的按钮交互一致。

## [0.3.0] - 2026-08-15

### 新增

- **GUI 启动本地服务器支持指定端口**：login 界面「GUI 启动本地服务器」卡片
  增加端口输入框（留空自动选择随机端口）；启动失败时携带 dsh stderr
  尾部提示（如端口被占用），端口输入在两端校验（1-65535）。
- **断开连接 / 断开连接并关闭**：连接成功后标题栏显示当前地址与
  「断开连接 ▾」菜单——「断开连接」返回登录界面且本应用启动的本地服务
  保持运行，「断开连接并关闭本地服务」一并停止服务（仅对本应用启动的
  服务显示）。托盘菜单同步增加这两项；显式断开会清除共享配置中的
  `url`，避免下次启动自动重连。

## [0.2.0] - 2026-08-14

### 新增（参考竞品桌面应用常见能力）

- **全局快捷键**：默认 `Ctrl+Shift+D` 任意位置唤起/收起窗口（`DSH_HOTKEY` 可改）。
- **深链协议 `dsh-shell://`**：`show` 唤起窗口；`open?url=` 直接连接服务器
  （远程地址仍弹确认，仅 http/https；macOS 经 Info.plist 声明、Windows 运行时注册）。
- **窗口状态记忆**：位置/尺寸与置顶状态持久化（多显示器变化时自动校验可见性）。
- **最近连接列表**：login 界面展示最近 5 个服务器，点击重连。
- **托盘增强**：打开/隐藏切换、窗口置顶开关、在浏览器中打开当前服务器、
  检查更新、关于；提示文本显示当前连接地址。
- **开机自启启动到托盘**：自启时附加 `--hidden`（macOS 用 openAsHidden），不打扰。

## [0.1.0] - 2026-08-14

首个可发布版本。

- Login 连接界面：本地嗅探 / GUI 启动本地服务器 / 云端服务器三种连接方式。
- 三级 URL 配置来源：`--url` > `DSH_URL` > 共享配置（`~/.dsh/desktop-shell.json`）。
- 无边框窗口 + DSH 风格自绘标题栏，跟随 DSH「外观」设置与系统深浅色即时切换。
- 托盘常驻：关闭窗口收进托盘；退出时询问是否同时关闭本应用启动的本地服务。
- 本地 DSH 服务管理：自动定位 `dsh`（PATH / npx 缓存 / DSH_HOME），
  启动后嗅探就绪 URL 并接管进程生命周期（整棵进程树清理）。
- 断线自动重连：DSH 重启/断连期间每 3 秒探测，服务恢复后自动重载。
- 安全模型：DSH 内容跑在隔离 WebContentsView（sandbox + contextIsolation、
  无 preload），http(s) 外链白名单，非回环地址连接需确认，
  敏感设备权限（摄像头/麦克风/定位等）一律拒绝。
- 单实例锁、开机自启、自动更新（electron-updater，generic provider）。
- 工程：vitest + node:test 双层测试；electron-builder 三平台目标
  （NSIS/portable、dmg/zip、AppImage/deb）；Electron fuses 二进制加固。
