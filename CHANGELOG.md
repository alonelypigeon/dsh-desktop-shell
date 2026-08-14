# Changelog

本仓库仅包含桌面外壳（dsh-desktop-shell）。配套 cordis 插件
（dsh-plugin-desktop-control / dsh-plugin-balance-panel / dsh-plugin-session-outline）
已拆分为独立仓库，各自维护版本与变更记录。

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
