// shell.html 的页面逻辑（从内联 <script> 外置，配合 CSP 收紧 script-src 'self'）。
// 置于 </body> 前加载，DOM 已就绪。
(function () {
  // —— 主题：初始从 query 读取，运行时由主进程推送 ——
  function applyTheme(isDark) {
    document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }
  var params = new URLSearchParams(location.search);
  applyTheme(params.get('dark') === '1');
  if (window.shellWindow && window.shellWindow.onThemeChange) {
    window.shellWindow.onThemeChange(function (isDark) { applyTheme(isDark); });
  }

  // —— 窗口控制 ——
  var max = document.getElementById('max');
  var icoMax = max.querySelector('.ico-max');
  var icoRestore = max.querySelector('.ico-restore');
  document.getElementById('min').addEventListener('click', function () { window.shellWindow.minimize(); });
  max.addEventListener('click', function () { window.shellWindow.toggleMaximize(); });
  document.getElementById('close').addEventListener('click', function () { window.shellWindow.close(); });
  window.shellWindow.onMaximizeChange(function (isMax) {
    icoMax.style.display = isMax ? 'none' : 'block';
    icoRestore.style.display = isMax ? 'block' : 'none';
  });

  // —— 已连接状态 + 标题栏下拉菜单（原生 Menu.popup：绘制在所有内容之上，
  //    Esc / 点击外部自动收起，无需任何收起状态管理）——
  var connEl = document.getElementById('conn');
  var connUrlEl = document.getElementById('conn-url');
  var connToggle = document.getElementById('conn-toggle');
  window.shellWindow.onConnectionChange(function (s) {
    connEl.hidden = !s.connected;
    connUrlEl.textContent = s.url || '';
  });
  // 断线重连中：状态点变黄；恢复后回绿（class 由 CSS 定义）
  window.shellWindow.onPhaseChange(function (phase) {
    connUrlEl.classList.toggle('reconnecting', phase === 'reconnecting');
  });
  // 勿扰指示（通知静默但徽章保留）
  var dndEl = document.getElementById('conn-dnd');
  window.shellWindow.onDndChange(function (on) { dndEl.hidden = !on; });
  // 菜单按钮通用绑定：点击 → 把按钮锚点发给主进程弹原生菜单
  function bindMenuButton(btn, name) {
    btn.addEventListener('click', function () {
      var r = btn.getBoundingClientRect();
      window.shellWindow.menus.open(name, { x: r.x, y: r.y, width: r.width, height: r.height });
    });
  }
  bindMenuButton(connToggle, 'disconnect');
  bindMenuButton(document.getElementById('server-menu'), 'server');
  bindMenuButton(document.getElementById('more-menu'), 'more');

  // —— 窗口置顶（toggle，激活态高亮） ——
  var pinBtn = document.getElementById('pin');
  pinBtn.addEventListener('click', function () { window.shellWindow.toggleAlwaysOnTop(); });
  window.shellWindow.onAlwaysOnTopChange(function (on) {
    pinBtn.classList.toggle('active', on);
    pinBtn.title = on ? '取消窗口置顶' : '窗口置顶';
  });

  // —— 页面内查找（内容视图快捷键由主进程捕获后通知打开） ——
  var findbar = document.getElementById('findbar');
  var findInput = document.getElementById('find-input');
  var findCount = document.getElementById('find-count');
  window.shellWindow.find.onVisible(function (v) {
    findbar.hidden = !v;
    if (v) {
      findInput.focus();
      findInput.select();
    } else {
      findCount.textContent = '';
    }
  });
  window.shellWindow.find.onResult(function (text) {
    findCount.textContent = typeof text === 'string' ? text : '';
  });
  findInput.addEventListener('input', function () {
    window.shellWindow.find.query(findInput.value);
  });
  findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.shellWindow.find.next(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      window.shellWindow.find.close();
    }
  });
  document.getElementById('find-prev').addEventListener('click', function () { window.shellWindow.find.next(-1); });
  document.getElementById('find-next').addEventListener('click', function () { window.shellWindow.find.next(1); });
  document.getElementById('find-close').addEventListener('click', function () { window.shellWindow.find.close(); });

  // —— 快捷键设置面板（录制判定与冲突检查在主进程） ——
  var settingsEl = document.getElementById('settings');
  var settingsGroups = document.getElementById('settings-groups');
  var settingsEnvHint = document.getElementById('settings-env-hint');
  var shortcutsState = null;
  var recordingAction = null; // 正在录制的动作；null = 无
  var rowEls = {};            // action → { bindBtn, errEl }

  function fmtAcc(acc) {
    if (acc === null || acc === undefined || acc === '') return '未绑定';
    var isMac = shortcutsState && shortcutsState.isMac;
    return acc
      .split('+')
      .map(function (t) {
        if (t === 'CommandOrControl') return isMac ? '⌘' : 'Ctrl';
        if (t === 'Plus') return '+';
        return t;
      })
      .join('+');
  }

  function buildShortcutRow(action) {
    var meta = shortcutsState.meta[action];
    var row = document.createElement('div');
    row.className = 'sc-row';

    var info = document.createElement('div');
    info.className = 'sc-info';
    var name = document.createElement('div');
    name.className = 'sc-name';
    name.textContent = meta.label;
    var desc = document.createElement('div');
    desc.className = 'sc-desc';
    desc.textContent = meta.description;
    info.appendChild(name);
    info.appendChild(desc);
    row.appendChild(info);

    var op = document.createElement('div');
    op.className = 'sc-op';
    var bindBtn = document.createElement('button');
    bindBtn.type = 'button';
    bindBtn.className = 'sc-bind';
    var errEl = document.createElement('span');
    errEl.className = 'sc-error';
    var resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'icon-btn sc-reset';
    resetBtn.textContent = '↺';
    resetBtn.title = '恢复该动作默认快捷键';
    resetBtn.setAttribute('aria-label', '恢复 ' + meta.label + ' 默认快捷键');

    function refreshRow() {
      var recording = recordingAction === action;
      bindBtn.textContent = recording ? '按下新组合键…' : fmtAcc(shortcutsState.bindings[action]);
      bindBtn.classList.toggle('recording', recording);
      bindBtn.title = recording ? 'Esc 取消，Backspace 清除绑定' : '点击重新绑定';
      errEl.textContent = '';
    }

    bindBtn.addEventListener('click', function () {
      recordingAction = action;
      refreshRow();
      bindBtn.focus();
    });
    resetBtn.addEventListener('click', function () {
      window.shellWindow.shortcuts.reset(action);
    });

    op.appendChild(bindBtn);
    op.appendChild(errEl);
    op.appendChild(resetBtn);
    row.appendChild(op);
    rowEls[action] = { bindBtn: bindBtn, errEl: errEl };
    refreshRow();
    return row;
  }

  function renderShortcuts() {
    if (!shortcutsState) return;
    recordingAction = null;
    settingsGroups.textContent = '';
    rowEls = {};
    var groups = [
      { scope: 'global', title: '全局' },
      { scope: 'content', title: '页面（DSH 内容视图）' },
    ];
    var actions = shortcutsState.actions || [];
    groups.forEach(function (g) {
      var list = actions.filter(function (a) {
        return shortcutsState.meta[a] && shortcutsState.meta[a].scope === g.scope;
      });
      if (list.length === 0) return;
      var head = document.createElement('div');
      head.className = 'settings-group-title';
      head.textContent = g.title;
      settingsGroups.appendChild(head);
      list.forEach(function (action) {
        settingsGroups.appendChild(buildShortcutRow(action));
      });
    });
    settingsEnvHint.hidden = shortcutsState.envOverride !== true;
  }

  function stopRecording() {
    recordingAction = null;
  }

  window.shellWindow.shortcuts.onState(function (s) {
    shortcutsState = s;
    renderShortcuts();
  });
  // B3: dnd schedule controls
  var dndEnabledEl = document.getElementById('dnd-schedule-enabled');
  var dndStartEl = document.getElementById('dnd-schedule-start');
  var dndEndEl = document.getElementById('dnd-schedule-end');
  var dndStatusEl = document.getElementById('dnd-schedule-status');
  function loadDndSchedule() {
    window.shellWindow.settings.getDndSchedule().then(function (s) {
      dndEnabledEl.checked = !!(s && s.enabled);
      dndStartEl.value = (s && s.start) || '22:00';
      dndEndEl.value = (s && s.end) || '07:00';
      dndStatusEl.textContent = s && s.enabled ? '定时勿扰已启用（' + s.start + ' - ' + s.end + '）' : '未启用定时勿扰';
    });
  }
  function saveDndSchedule() {
    window.shellWindow.settings.setDndSchedule({
      enabled: dndEnabledEl.checked,
      start: dndStartEl.value || '22:00',
      end: dndEndEl.value || '07:00',
    });
    dndStatusEl.textContent = dndEnabledEl.checked ? '定时勿扰已启用（' + (dndStartEl.value || '22:00') + ' - ' + (dndEndEl.value || '07:00') + '）' : '未启用定时勿扰';
  }
  dndEnabledEl.addEventListener('change', saveDndSchedule);
  dndStartEl.addEventListener('change', saveDndSchedule);
  dndEndEl.addEventListener('change', saveDndSchedule);

    window.shellWindow.settings.onVisible(function (v) {
    settingsEl.hidden = !v;
    if (v) { window.shellWindow.shortcuts.get(); loadDndSchedule(); }
    else stopRecording();
  });
  document.getElementById('settings-close').addEventListener('click', function () {
    window.shellWindow.settings.close();
  });
  document.getElementById('settings-reset-all').addEventListener('click', function () {
    window.shellWindow.shortcuts.reset('all');
  });

  // 录制捕获：面板打开时拦截 keydown（成功/清除由 onState 重渲染收尾）
  document.addEventListener('keydown', function (e) {
    if (settingsEl.hidden) return;
    if (recordingAction === null) {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.shellWindow.settings.close();
      }
      return;
    }
    e.preventDefault();
    if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
    var target = recordingAction;
    var els = rowEls[target];
    window.shellWindow.shortcuts
      .record(target, {
        key: e.key,
        control: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
      })
      .then(function (r) {
        if (!els || recordingAction !== target) return;
        if (r && r.ok) {
          if (r.cancelled) {
            recordingAction = null;
            els.bindBtn.textContent = fmtAcc(shortcutsState.bindings[target]);
            els.bindBtn.classList.remove('recording');
            els.errEl.textContent = '';
          }
          return; // 成功/清除 → onState 重渲染
        }
        if (r && r.error) els.errEl.textContent = r.error; // 无效/冲突：留在录制态可重试
      });
  }, true);

  // —— 命令面板（Ctrl+K；清单由主进程推送，执行只回传清单里的 id） ——
  var paletteEl = document.getElementById('palette');
  var paletteInput = document.getElementById('palette-input');
  var paletteList = document.getElementById('palette-list');
  var paletteEntries = []; // 主进程下发的动作快照
  var paletteFiltered = []; // 过滤后的可见项
  var paletteItemEls = [];  // 与 paletteFiltered 对应的 DOM
  var paletteActive = 0;

  // 模糊匹配：子串优先，退化为按序子序列（"mlad" 可命中「命令面板」拼音首字母类输入不做，
  // 只做字符级匹配，保持无依赖、可预期）
  function paletteMatch(query, text) {
    var q = query.trim().toLowerCase();
    if (!q) return true;
    var t = text.toLowerCase();
    if (t.indexOf(q) !== -1) return true;
    var i = 0;
    for (var j = 0; j < t.length && i < q.length; j++) {
      if (t.charAt(j) === q.charAt(i)) i++;
    }
    return i === q.length;
  }

  function paletteMarkActive() {
    paletteItemEls.forEach(function (el, i) {
      el.classList.toggle('active', i === paletteActive);
    });
    var el = paletteItemEls[paletteActive];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function paletteRender() {
    var query = paletteInput.value;
    paletteFiltered = paletteEntries.filter(function (en) {
      return paletteMatch(query, en.label + ' ' + (en.hint || ''));
    });
    if (paletteActive >= paletteFiltered.length) paletteActive = 0;
    paletteList.textContent = '';
    paletteItemEls = [];
    var lastGroup = null;
    paletteFiltered.forEach(function (en, idx) {
      if (en.group !== lastGroup) {
        var head = document.createElement('div');
        head.className = 'palette-group';
        head.textContent = en.group;
        paletteList.appendChild(head);
        lastGroup = en.group;
      }
      var item = document.createElement('div');
      item.className = 'palette-item';
      item.setAttribute('role', 'option');
      var label = document.createElement('span');
      label.className = 'palette-label';
      label.textContent = en.label;
      item.appendChild(label);
      if (en.hint) {
        var hint = document.createElement('span');
        hint.className = 'palette-hint';
        hint.textContent = en.hint;
        item.appendChild(hint);
      }
      item.addEventListener('click', function () { window.shellWindow.palette.run(en.id); });
      item.addEventListener('mousemove', function () {
        if (paletteActive !== idx) {
          paletteActive = idx;
          paletteMarkActive();
        }
      });
      paletteList.appendChild(item);
      paletteItemEls.push(item);
    });
    if (paletteFiltered.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'palette-empty';
      empty.textContent = '没有匹配的命令';
      paletteList.appendChild(empty);
    }
    paletteMarkActive();
  }

  window.shellWindow.palette.onModel(function (model) {
    paletteEntries = Array.isArray(model) ? model : [];
    paletteRender();
  });
  window.shellWindow.palette.onVisible(function (v) {
    paletteEl.hidden = !v;
    if (v) {
      paletteInput.value = '';
      paletteActive = 0;
      paletteRender();
      paletteInput.focus();
    }
  });
  paletteInput.addEventListener('input', function () {
    paletteActive = 0;
    paletteRender();
  });
  paletteInput.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (paletteFiltered.length > 0) {
        paletteActive = (paletteActive + 1) % paletteFiltered.length;
        paletteMarkActive();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (paletteFiltered.length > 0) {
        paletteActive = (paletteActive - 1 + paletteFiltered.length) % paletteFiltered.length;
        paletteMarkActive();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var en = paletteFiltered[paletteActive];
      if (en) window.shellWindow.palette.run(en.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      window.shellWindow.palette.close();
    }
  });
  // 面板焦点在 shell 页面（内容视图已摘下），再按 Ctrl+K 直接关闭
  document.addEventListener('keydown', function (e) {
    if (paletteEl.hidden) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      window.shellWindow.palette.close();
    }
  }, true);

  // —— login 交互 ——
  var cards = document.getElementById('cards');
  var remoteRow = document.getElementById('remote-row');
  var remoteUrl = document.getElementById('remote-url');
  var portRow = document.getElementById('port-row');
  var localPort = document.getElementById('local-port');
  var connectBtn = document.getElementById('connect');
  var statusEl = document.getElementById('status');

  function currentMethod() {
    var r = cards.querySelector('input[name=method]:checked');
    return r ? r.value : 'sniff';
  }
  function setStatus(text, isError) {
    statusEl.className = 'status' + (isError ? ' error' : '');
    statusEl.textContent = '';
    if (text) statusEl.textContent = text;
  }
  function renderInstances(list) {
    statusEl.className = 'status';
    statusEl.textContent = '';
    if (!list || list.length === 0) {
      statusEl.textContent = '未发现正在运行的实例。可以试试「GUI 启动本地服务器」，或确认 dsh web 已启动。';
      return;
    }
    var hint = document.createElement('div');
    hint.textContent = '发现 ' + list.length + ' 个实例，点击连接：';
    statusEl.appendChild(hint);
    list.forEach(function (inst) {
      var b = document.createElement('button');
      b.className = 'inst';
      b.textContent = '已检测到 DeepSeek Harness — ' + inst.url;
      b.addEventListener('click', function () { window.shellWindow.login.joinRemote(inst.url); });
      statusEl.appendChild(b);
    });
  }

  // —— 连接按钮：文案随所选连接方式变化（同一句「连接」对嗅探/启动语义不清） ——
  var connectBusy = false;
  function connectLabel(method, busy) {
    if (method === 'sniff') return busy ? '嗅探中…' : '重新嗅探';
    if (method === 'local') return busy ? '启动中…' : '启动并连接';
    return busy ? '连接中…' : '连接';
  }
  function setBusy(busy) {
    connectBusy = busy;
    connectBtn.disabled = busy;
    connectBtn.classList.toggle('busy', busy);
    connectBtn.textContent = connectLabel(currentMethod(), busy);
  }

  // —— 最近连接（点击重连；× 删除单条；清除全部）——
  var recentEl = document.getElementById('recent');
  function renderRecent(list) {
    recentEl.textContent = '';
    recentEl.hidden = !list || list.length === 0;
    if (!list || list.length === 0) return;
    var head = document.createElement('div');
    head.className = 'recent-head';
    var title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = '最近连接（点击重连）';
    head.appendChild(title);
    var clearBtn = document.createElement('button');
    clearBtn.className = 'ghost-btn';
    clearBtn.textContent = '清除全部';
    clearBtn.title = '删除全部登录记录';
    clearBtn.addEventListener('click', function () { window.shellWindow.login.clearRecent(); });
    head.appendChild(clearBtn);
    recentEl.appendChild(head);
    list.forEach(function (url) {
      var row = document.createElement('div');
      row.className = 'recent-row';
      var b = document.createElement('button');
      b.className = 'inst';
      b.textContent = url;
      b.title = '点击连接 ' + url;
      b.addEventListener('click', function () { window.shellWindow.login.joinRemote(url); });
      row.appendChild(b);
      var del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.textContent = '×';
      del.title = '删除该记录';
      del.setAttribute('aria-label', '删除记录 ' + url);
      del.addEventListener('click', function () { window.shellWindow.login.removeRecent(url); });
      row.appendChild(del);
      recentEl.appendChild(row);
    });
  }
  window.shellWindow.login.onRecentResult(renderRecent);
  window.shellWindow.login.requestRecent();

  // —— 命名连接配置库（A1）：显示名称+地址，支持删除与重命名 ——
  var connectionsEl = document.getElementById('connections');
  var currentConnections = [];
  function renderConnections(list) {
    currentConnections = Array.isArray(list) ? list : [];
    connectionsEl.textContent = '';
    connectionsEl.hidden = currentConnections.length === 0;
    if (currentConnections.length === 0) return;
    var head = document.createElement('div');
    head.className = 'recent-head';
    var title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = '已保存连接（点击连接）';
    head.appendChild(title);
    connectionsEl.appendChild(head);
    currentConnections.forEach(function (conn) {
      var row = document.createElement('div');
      row.className = 'recent-row';
      var b = document.createElement('button');
      b.className = 'inst';
      b.title = '点击连接 ' + conn.url;
      var nameEl = document.createElement('span');
      nameEl.className = 'conn-name';
      nameEl.textContent = conn.name || conn.url;
      var urlEl = document.createElement('span');
      urlEl.className = 'conn-url';
      urlEl.textContent = conn.url;
      b.appendChild(nameEl);
      b.appendChild(urlEl);
      b.addEventListener('click', function () { window.shellWindow.login.joinRemote(conn.url); });
      row.appendChild(b);
      var pinBtn = document.createElement('button');
      pinBtn.className = 'icon-btn';
      pinBtn.textContent = '★';
      pinBtn.title = '置顶';
      pinBtn.setAttribute('aria-label', '置顶 ' + (conn.name || conn.url));
      pinBtn.addEventListener('click', function () { window.shellWindow.login.connections.pin(conn.id); });
      row.appendChild(pinBtn);
      var renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.textContent = '✎';
      renameBtn.title = '重命名';
      renameBtn.setAttribute('aria-label', '重命名 ' + (conn.name || conn.url));
      renameBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'conn-rename';
        input.value = conn.name || conn.url;
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        function commit() {
          var v = input.value.trim();
          if (v && v !== (conn.name || conn.url)) window.shellWindow.login.connections.rename(conn.id, v);
          else renderConnections(currentConnections);
        }
        input.addEventListener('keydown', function (e2) {
          if (e2.key === 'Enter') { e2.preventDefault(); commit(); }
          else if (e2.key === 'Escape') { e2.preventDefault(); renderConnections(currentConnections); }
        });
        input.addEventListener('blur', commit);
      });
      row.appendChild(renameBtn);
      var del = document.createElement('button');
      del.className = 'icon-btn danger';
      del.textContent = '×';
      del.title = '删除该连接';
      del.setAttribute('aria-label', '删除连接 ' + (conn.name || conn.url));
      del.addEventListener('click', function () { window.shellWindow.login.connections.remove(conn.id); });
      row.appendChild(del);
      connectionsEl.appendChild(row);
    });
  }
  window.shellWindow.login.connections.onResult(renderConnections);
  window.shellWindow.login.connections.request();

  cards.addEventListener('change', function () {
    var m = currentMethod();
    cards.querySelectorAll('.card').forEach(function (l) {
      l.classList.toggle('selected', l.querySelector('input').checked);
    });
    remoteRow.hidden = m !== 'remote';
    portRow.hidden = m !== 'local';
    setStatus('');
    // 按钮文案随方式切换（busy 中的文案等结果复位时再更新）
    if (!connectBusy) connectBtn.textContent = connectLabel(m, false);
    if (m === 'sniff') {
      setStatus('正在嗅探本地实例…');
      window.shellWindow.login.sniff();
    }
  });

  connectBtn.addEventListener('click', function () {
    var m = currentMethod();
    if (m === 'sniff') {
      setStatus('正在嗅探本地实例…');
      window.shellWindow.login.sniff();
    } else if (m === 'local') {
      setBusy(true);
      setStatus('正在启动本地 DeepSeek Harness…');
      window.shellWindow.login.startLocal(localPort.value.trim());
    } else if (m === 'remote') {
      var url = remoteUrl.value.trim();
      if (!url) {
        setStatus('请输入云端服务器地址', true);
        return;
      }
      setBusy(true);
      setStatus('正在连接 ' + url + ' …');
      window.shellWindow.login.joinRemote(url);
    }
  });

  remoteUrl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connectBtn.click();
  });
  localPort.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') connectBtn.click();
  });

  // 主进程推送
  window.shellWindow.login.onSniffResult(function (list) {
    if (currentMethod() !== 'sniff') return;
    renderInstances(list);
  });
  window.shellWindow.login.onProgress(function (msg) {
    if (currentMethod() !== 'local') return;
    setStatus(msg);
  });
  window.shellWindow.login.onResult(function (r) {
    setBusy(false);
    if (r && r.ok) {
      setStatus('连接成功');
    } else {
      setStatus((r && r.error) || '连接失败', true);
    }
  });
  window.shellWindow.login.onVisible(function (v) {
    document.getElementById('login').style.display = v ? 'flex' : 'none';
    if (v) {
      // 页面重新可见（切换服务器 / 断开连接）时复位表单：连接成功的复位
      // 消息可能在页面隐藏期间被丢弃，按钮会残留「连接中…」禁用态。
      setBusy(false);
      window.shellWindow.login.connections.request();
      // 嗅探方式马上会收到新结果；其余方式清掉上一次连接留下的旧状态文案
      if (currentMethod() !== 'sniff') setStatus('');
    }
  });

  // 默认选中嗅探：按钮文案对齐所选方式，启动即开始一次嗅探
  connectBtn.textContent = connectLabel(currentMethod(), false);
  window.shellWindow.login.sniff();
})();
