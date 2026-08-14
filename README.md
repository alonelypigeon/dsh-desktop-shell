# DeepSeek Harness Shell

一个**零后端、纯外壳**的 DeepSeek Harness 桌面托盘应用（Electron + TypeScript），提供与 DSH 一致美术风格的独立原生窗口，并能在启动时自动拉起本地 DSH 服务。

## 特性

- **Login 连接界面**：左侧官方鲸鱼 logo 品牌区，右侧三种连接方式——**本地嗅探**（探测本机已运行的 DSH Web，列出实例一键连接）/ **GUI 启动本地服务器**（spawn `dsh web` 并显示实时进度，自动在 npx 缓存里找 `dsh`；支持**指定端口**，留空自动选随机端口，端口被占用会把 dsh 的报错提示给你）/ **云端服务器**（输入远程 URL，非回环地址弹确认）。另有**最近连接**列表（记忆最近 5 个地址，点击重连；每条可单独删除 ×，也可「清除全部」）。仅首次或配置失效时出现，有配置时直接连接零打扰。
- **断开连接 / 断开连接并关闭**：连接成功后标题栏显示当前地址与「断开连接 ▾」菜单——「断开连接」返回登录界面（本应用启动的本地服务保持后台运行）；「断开连接并关闭本地服务」一并停止服务（仅本应用启动的服务显示该选项）。托盘菜单同样提供这两项。菜单是**独立子窗口**（frameless + transparent）：不被 DSH 内容视图遮挡，且以 `showInactive` 打开、不抢键盘焦点；点击主窗口任意处 / Esc / 失焦自动收起。
- **可配置 URL**：`--url` > `DSH_URL` > 共享配置，三级来源。
- **DSH 风格自绘标题栏**：无边框窗口 + 自绘标题栏，匹配 Harness 设计平台 token，并跟随 DSH「外观」设置即时切换深浅色。
- **托盘常驻**：关闭窗口 = 隐藏到托盘；托盘菜单「打开/隐藏窗口 / 管理服务器（启动本地 DSH 服务、停止本地服务、切换服务器）/ 窗口置顶 / 在浏览器中打开当前服务器 / 检查更新 / 关于 / 退出」，单击托盘图标切换窗口显隐，提示文本显示当前连接地址。
- **全局快捷键**：默认 `Ctrl+Shift+D` 任意位置唤起/收起窗口（`DSH_HOTKEY` 环境变量可改，设 `off` 禁用）。
- **深链协议 `dsh-shell://`**：`dsh-shell://show` 唤起窗口；`dsh-shell://open?url=<编码后的地址>` 直接连接指定服务器（远程地址仍走确认弹窗，仅 http/https）。
- **窗口状态记忆**：记住上次窗口位置/尺寸与「置顶」状态（多显示器变化时自动校验，窗口不会落到屏幕外）。
- **退出询问**：由本应用启动了本地 DSH 服务时，关闭窗口会弹窗询问「同时关闭服务并退出 / 最小化到托盘 / 取消」；托盘退出同样询问。选择保持后服务继续在后台运行，下次启动可直接嗅探连接。
- **断线自动重连**：DSH 重启/断连期间每 3 秒探测，服务恢复后自动重载页面。
- **外链 http(s) 白名单**：`window.open` 与跨源导航一律拦截，仅放行 `http:`/`https:` 交给系统浏览器。
- **零注入**：DSH 内容跑在独立的 `WebContentsView`（`sandbox:true` + `contextIsolation:true` + 无 preload）；标题栏/login 的 shell 用极窄 preload 只暴露窗口控制与连接动作。
- **开机自启 / 自动更新**：由 DSH 内 cordis 插件远程控制（见下）；开机自启时直接启动到托盘（`--hidden`），不打扰。
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
| `DSH_HOTKEY` | 全局快捷键（默认 `CommandOrControl+Shift+D`；设 `off` 禁用） |
| `DSH_UPDATE_URL` | 覆盖自动更新源（generic provider） |
| `DSH_DESKTOP_CONFIG` | 覆盖共享配置文件路径 |
| `--hidden` | 启动到托盘不弹窗口（开机自启自动附加） |

深链（需打包版已注册，macOS 在 `mac.protocols` 声明、Windows 运行时注册）：

```
dsh-shell://show
dsh-shell://open?url=http%3A%2F%2F127.0.0.1%3A3080%2F
```

## 测试

```bash
npm test                    # 全量：src 纯函数（vitest）+ 编译产物校验
npm run test:unit           # 仅 src（vitest：url / sniffer / protocol / shell-state / dsh-launcher）
npm run test:node           # Node 原生 runner（scripts/verify-url.mjs，不依赖 vite，
                            # 可在无子进程 spawn 的受限环境运行；会先编译 dist）
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
  main.ts            主进程：窗口 / 标题栏 / 托盘 / 退出询问 / 断线重连 / 轮询
  config.ts          URL 来源解析（--url > DSH_URL > 共享配置）
  shared-config.ts   与 cordis 插件共享的配置读写（fs.watch 即时响应）
  dsh-launcher.ts    启动本地 dsh（PATH / npx 缓存 / DSH_HOME 三级查找）并嗅探 URL
  conn-menu.ts       断开连接下拉菜单（独立子窗口：不被 DSH 视图遮挡、不抢焦点）
  conn-menu.html     菜单窗口页面（断开连接 / 断开连接并关闭本地服务）
  sniffer.ts         本地 DSH 实例嗅探（html + favicon 双特征判定）
  security.ts        外链 http(s) 白名单 + 敏感权限策略
  probe.ts           URL 就绪探测
  theme.ts           读取 DSH「外观」设置并跟随切换
  updater.ts         自动更新（electron-updater）
  url.ts             URL 校验 / CLI 解析 / 优先级（纯函数，可测）
  protocol.ts        dsh-shell:// 深链解析（纯函数，可测）
  shell-state.ts     窗口状态（bounds/置顶/最近连接）读写与校验（纯函数，可测）
  shell-preload.ts   标题栏 / login 窗口控制桥接
  shell.html         标题栏 + login 界面（鲸鱼品牌区 + 三种连接方式 + 最近连接管理）
scripts/
  clean.mjs           清空编译产物（防残留旧文件）
  copy-static.mjs / generate-icons.mjs / verify-url.mjs / smoke-ui.mjs（UI 冒烟，需先 build）
build/               图标资源（官方鲸鱼 favicon）
```

> 配套 cordis 插件不在本仓库，见上文「与 DSH 的联动」。

## 安全设计

DSH 页面（包括云端服务器）按**不可信内容**处理：

- **零注入**：DSH 内容跑在独立 `WebContentsView`（`sandbox:true` + `contextIsolation:true`、无 preload、`nodeIntegration:false`），渲染层 XSS 无法升级为 Node/主进程 RCE；不使用已废弃的 `<webview>`。
- **导航/弹窗守卫**：`will-navigate` + `setWindowOpenHandler` 拦截一切偏离 DSH 源的导航与 `window.open`，仅放行 `http:`/`https:` 交给系统浏览器——这正是 CVE-2026-33336（Vikunja Desktop 同窗口导航 RCE）一类的漏洞面。
- **权限最小化**：内容视图拒绝摄像头/麦克风/定位/串口/HID/USB/蓝牙/屏幕捕获等敏感权限；剪贴板、通知等常规能力放行。
- **IPC 白名单**：shell 窗口的 preload 只暴露窗口控制与连接动作；所有 IPC handler 校验 `event.sender`，DSH 内容视图完全不持有 IPC 通道。
- **协议白名单**：连接 URL 只接受 `http:`/`https:`（`file:`/`javascript:`/`smb:` 等一律拒绝）；非回环地址连接需用户确认。
- **二进制加固**：打包时启用 Electron fuses——禁用 `RunAsNode`、node 选项注入与 `--inspect` 远程调试参数，启用 cookie 加密与 asar 完整性校验，仅允许从 asar 加载应用。

## 说明

- 社区实验项目，非 DeepSeek 官方产品。
- 上游 DSH 处于 Developer Preview；本外壳依赖的是 URL 与共享配置，而非 Web UI 内部结构。
