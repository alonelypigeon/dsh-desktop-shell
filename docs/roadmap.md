# 版本路线图

> 依据 [`docs/competitive-research-2026-08.md`](competitive-research-2026-08.md) 的
> 调研结论排期。定位不变：**面向自带 dsh 实例的托盘常驻桌面壳**（MIT、单人维护）。

## 排期原则

- **零注入红线**：任何功能不得向 DSH 页面注入脚本/preload。页面状态只能来自
  Electron 事件（`page-title-updated`、`did-navigate` 等）或 dsh 官方插件通道
  （共享配置）。这条约束是与 Crystal/Conductor 类竞品的差异，也是卖点。
- **小步快跑**：每版 1–2 个主题，单人一个迭代能完成并发布。
- **先痛点后旗舰**：感知（通知/徽章）→ 效率（面板/更新）→ 连接管理 → 并行会话。
- 每项落地同步更新：README「特性」、CHANGELOG、纯函数单测（`src/*.test.ts`）。

---

## v0.6.0 —— 感知与效率

主题：让窗口藏在托盘时，用户不用反复拉开看代理状态；键盘党获得命令面板；
更新链路加上保险丝。全部 5 项都是 S–M 工作量。

### N1. 代理状态通知（调研 B1）

agent 跑长任务时标题栏会出现 "(n)" 前缀——这是壳层零注入能拿到的最可靠信号。

- 新模块 `src/title-watcher.ts`：纯函数 `parseTitleCount(title): number | null`
  （识别 `(1)`、`(12)` 等前缀，兼容全角括号），单测覆盖。
- `main.ts` 在 `attachContentView` 挂 `page-title-updated`（连接切换时随视图
  重建自然重挂，无需像 will-navigate 那样摘旧监听）。
- 仅在窗口隐藏/最小化且计数**增加**时弹系统通知（复用 `notifyConnection`
  的通道与去抖思路，避免轰炸）；点击 → `showWindow()`。
- 勿扰开启时只更新徽章不弹通知（见 N3）。

验收：连上 dsh → 隐藏窗口 → 页面标题出现 `(2)` → 收到一条通知，点击窗口前置；
计数不变或窗口可见时不重复通知。

### N2. 托盘/任务栏未读徽章（调研 B2）

- Windows：`shellWindow.setOverlayIcon(nativeImage, description)`——用离屏
  canvas/预渲染圆点数字生成角标图（`nativeImage.createFromDataURL`），
  计数归零 `setOverlayIcon(null)`。
- macOS：`app.setBadgeCount(n)`（Dock）+ `tray.setTitle(String(n))`（菜单栏）。
- Linux：`app.setBadgeCount(n)`（Unity/KDE）；无 Unity 时退化为托盘 tooltip 前缀。
- 计数来源与 N1 共用 `title-watcher`；断线重连/切换连接时清零。

验收：Windows 任务栏图标出现数字角标；标题恢复无前缀后角标消失；三平台
分别冒烟（CI 无法验 UI，靠 `scripts/smoke-ui.mjs` 扩展）。

### N3. 勿扰模式（调研 B3）

- `shell-state.json` 增加 `dnd: boolean`（可选 `dndSchedule`，首版只做手动开关）。
- 托盘菜单与「⋯」菜单各加一个 checkbox 项（`titlebar-menus.ts` 模板纯函数
  扩展 + 单测）；开启时 N1 通知与断线通知静默，徽章照常。
- 状态经 `shell-ui-state.ts` 的自愈推送同步标题栏指示（如状态点旁一个月亮图标）。

验收：勿扰开启 → 标题变化不弹通知但徽章更新；重启后记住开关状态。

### C1. 命令面板（Ctrl+K）

- shell 页面渲染面板；打开期间摘下内容视图——**复用现有 `settingsOpen`
  的挂/摘机制**（抽成通用的 `pushOverlay(type)` / `popOverlay()`）。
- 动作清单（首版）：
  - 连接：切换到最近连接 n 条、断开、启动/停止本地服务；
  - 视图：重载、强刷、缩放三档、置顶开关、页内查找；
  - 应用：检查更新、快捷键设置、勿扰开关、退出。
- 渲染层做模糊过滤 + ↑↓/Enter/Esc 键盘导航（`shell.js`，textContent 渲染）；
  动态部分（最近连接、owned 状态）复用 `login:recent-result` /
  `shell:connection-changed` 既有通道。
- `shortcuts.ts` 动作白名单增加 `'palette'`（默认 `Ctrl+K`，可重绑、可录制，
  与现有冲突检查打通）；内容视图 `before-input-event` 捕获后开关面板。

验收：Ctrl+K 打开面板、输入「重载」回车触发重载、Esc 关闭且内容视图原样挂回；
面板可通过快捷键设置重绑且冲突检测生效。

### E1–E3. 更新体验三件套（调研 E1/E2/E3）

- **E1 release notes**：`updater.ts` 的 `update-available` 对话框把
  `info.releaseNotes`（GitHub provider 自带，注意可能是 HTML 需剥标签）拼进
  `detail`；「退出时安装」= 勾选后置 `autoInstallOnAppQuit = true`。
- **E2 灰度**：`electron-builder.yml` 的 `publish` 段按需加
  `stagingPercentage`（发布后在 GitHub Release 编辑 latest.yml 的
  `stagingPercentage` 字段亦可），坏更新的回滚保险丝。
- **E3 portable 回退**：`setupAutoUpdater` 检测 `process.env.PORTABLE_EXECUTABLE_FILE`
  存在时跳过 electron-updater，「检查更新」改为提示 + `openExternalSafe`
  打开 Releases 页面（portable 无法 in-place 更新是 electron-builder 已知限制）。

验收：打包版点「检查更新」能看到 release notes；portable 版点检查更新打开
Releases 页而不是下载安装包。

### 顺手项（不单列）

- `shell-state.ts` / `shared-config.ts` 写文件后 `fs.chmod(0o600)`（仅 POSIX）。

---

## v0.7.0 —— 多连接与监控

主题：从「单连接 + 最近 5 条」进化为命名配置库；给长任务用户一个不抢焦点的
监控窗；排障有据可查。

### A1 + A4. 命名连接配置库 + 导入/导出

- `shell-state.json` 的 `recentServers: string[]` 演进为
  `connections: { id, name, url, kind: 'local-start' | 'sniffed' | 'remote', lastUsed }[]`；
  读取时从旧字段迁移（`shell-state.ts` 纯函数 + 迁移单测，旧文件不改坏）。
- login 界面列表显示名称 + 地址，支持重命名/置顶/删除（沿用 × 按钮交互）。
- 导出：`dialog.showSaveDialog` 写 JSON；导入：`showOpenDialog` 读入并逐条
  `validateUrl`（凭据已剥离、协议白名单复用现有校验），冲突按 URL 去重。

验收：升级安装后旧「最近连接」自动变成命名配置；导出的 JSON 在另一台机器
导入后可直接点击连接。


### A3. 连接健康面板

- `probe.ts` 扩展返回时延；面板显示：ping、dsh 版本（index 特征或插件通道）、
  本地服务进程状态（`ownedDsh` 是否存活）、端口监听 PID。
- 入口放「服务器 ▾」菜单与命令面板；数据只在本机探测，不新增信任面。

### D3. 诊断与日志面板

- `dsh-launcher.ts` 的 stdout/stderr 进环形缓冲（最近 ~500 行）；
  「⋯ → 诊断」面板查看 + `showSaveDialog` 一键导出日志文件（含启动错误
  时间线、连接/断线事件、版本号）——git issue 排障利器。

### S1（技术债）. 内容视图独立 session

- `WebContentsView` 加 `partition: 'persist:dsh'`：远程页面的 cookie/storage
  与默认 session 隔离，权限策略也可只挂在内容 session 上（当前
  `security.ts` 的 permission handler 挂在共享 default session）。
- **迁移提示**：首次切换用户需重新登录 dsh，发布说明要写明。

---

## v0.8.0 —— 体验打磨

- **B3 勿扰时段（DND/quiet hours）**：定时静默 + 免打扰，静默期间只保留徽章不弹通知。
- **B4 通知聚合**：多条通知合并为摘要（「3 个连接有更新」），减少轰炸。
- **A5 每连接代理设置**：连接配置库字段加 `proxy`，连接时
  `session.setProxy`（HTTP/SOCKS）；SSH 隧道视需求评估。
- **D2 托盘资源策略**：可选「隐藏到托盘时降低渲染节流但保持网络」
  （backgroundThrottling 精细控制，注意保留 agent 长任务的轮询）。
- **C4 更多全局热键动作**：重启本地服务、切换到上次连接等单动作键。

## v1.0 —— 并行会话（旗舰，调研 A2）

- 一个连接一个窗口：`shellWindow` 单例架构重构为会话管理器
  `sessions: Map<id, { window, contentView, state }>`；托盘菜单列出会话、
  全局热键轮换、每会话独立的窗口状态与缩放。
- 依赖 v0.7 的连接配置库数据结构；title-watcher/徽章按会话聚合（与 B4 打通）。
- 工作量 L，单独规划设计文档再动工。

## 暂不排期（记录在案）

- C2 quick-ask 浮窗（暂不排期，待用户反馈后决定）；
- D1 safeStorage 凭据存储（URL userinfo 已剥离，紧迫性下降，随 A1 配置库
  如需凭据字段再做）；E4 portable 目录备份回滚；
- D4 会话历史入口（依赖 dsh-plugin-session-outline 演进）。

---

## 完成状态跟踪

| 版本 | 主题 | 状态 |
|---|---|---|
| v0.6.0 | 感知与效率（N1–N3 通知/徽章/勿扰、C1 命令面板、E1–E3 更新三件套） | 已完成（待发布） |
| v0.7.0 | 多连接与监控（A1+A4 配置库、A3 健康、D3 诊断、S1 partition） | A1+A4、D3、S1 已完成，A3 未开始 |
| v0.8.0 | 体验打磨（B3 勿扰时段、B4 聚合、A5 代理、D2 节流、C4 热键动作） | B3/B4 已完成，A5/D2/C4 未开始 |
| v1.0 | 并行会话（A2 多窗口） | 未开始 |
