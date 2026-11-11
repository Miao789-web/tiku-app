/* =========================================================
 * cloudsync.js — 云端文字快照同步（只同步文字/考点，配图不同步）
 * ---------------------------------------------------------
 * 为什么只同步文字：
 *   配图是 base64，几百张就几十 MB，放云端既慢又费资源；
 *   老师需要图时回原设备「导出数据」把文件带过来即可。
 *
 * 工作方式：
 *   每台设备保存题库后，把自己的「文字快照」写到云端一行
 *   （按设备 id 覆盖写），另一台设备打开时自动拉取合并。
 *
 * 两种通道（云端服务端只认它自己的域名，精确 Origin 匹配）：
 *   1) 同域：页面就跑在云应用域名下 → 直接调 SDK（direct）
 *   2) 跨域：页面在 GitHub Pages 等别的域名 → 通过隐藏 iframe
 *      加载云域名下的 bridge.html 代为请求（bridge），
 *      消息由桥页用「自己域名」发出，才能过服务端校验。
 * ======================================================= */
(function () {
  'use strict';

  var CFG = {
    endpoint: 'https://tidian-tiku.app.workbuddy.host',
    publishableKey: 'wbpk_ffY2Rxnge4LNcRPmllEWDB_ecqR1cE73utSvHmDdCnTpZuHIs49g7Jt',
    table: 'tiku_sync',
    bridge: '/bridge.html'
  };
  var SDK_URL = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
  var CH = 'tiku-sync';

  var client = null;
  var loading = null;
  var status = { lastPush: 0, lastPull: 0, msg: '' };

  /** file:// 打开（单文件版 / 本地文件）没有 Origin，云端无法校验 */
  function originOk() {
    try {
      var h = location.hostname;
      if (!h) return false;
      return location.protocol === 'https:' || h === 'localhost' || h === '127.0.0.1' || h === '::1';
    } catch (e) { return false; }
  }

  /** 页面本身是否就在云应用域名下 */
  function sameOrigin() {
    try { return location.origin === CFG.endpoint; } catch (e) { return false; }
  }

  function mode() { return sameOrigin() ? 'direct' : 'bridge'; }

  /* ---------------- 直连模式（同域） ---------------- */

  function loadSdk() {
    if (window.WorkBuddyCloud) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = function () {
        if (window.WorkBuddyCloud) resolve();
        else reject(new Error('云端组件初始化失败'));
      };
      s.onerror = function () { reject(new Error('云端组件加载失败（需要联网）')); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function getClient() {
    if (client) return Promise.resolve(client);
    return loadSdk().then(function () {
      client = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CFG.endpoint,
        publishableKey: CFG.publishableKey
      });
      return client;
    });
  }

  /* ---------------- 桥接模式（跨域） ---------------- */

  var bridgeFrame = null, bridgeReady = null, seq = 0, waiting = {};

  /** 等主页面 load 完成再插 iframe —— iframe 会拖住父页 load 事件 */
  function whenPageReady() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(function (resolve) {
      window.addEventListener('load', function () { resolve(); }, { once: true });
      setTimeout(resolve, 4000);
    });
  }

  function ensureBridge() {
    if (bridgeReady) return bridgeReady;
    bridgeReady = whenPageReady().then(function () {
      return new Promise(function (resolve, reject) {
        var f = document.createElement('iframe');
        f.src = CFG.endpoint + CFG.bridge;
        f.setAttribute('aria-hidden', 'true');
        f.setAttribute('tabindex', '-1');
        f.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;border:0;opacity:0';
        var done = false;
        var finish = function (ok, err) {
          if (done) return;
          done = true;
          ok ? resolve(f) : reject(err || new Error('云端桥接加载失败'));
        };
        f.addEventListener('load', function () { finish(true); });
        f.addEventListener('error', function () { finish(false, new Error('云端桥接加载失败（需要联网）')); });
        setTimeout(function () { finish(false, new Error('云端桥接超时（网络慢或被拦截）')); }, 15000);
        bridgeFrame = f;
        (document.body || document.documentElement).appendChild(f);
      });
    });
    return bridgeReady;
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== CFG.endpoint) return;
    var m = e.data || {};
    if (m.ch !== CH || !m.id || !waiting[m.id]) return;
    var w = waiting[m.id];
    delete waiting[m.id];
    if (m.ok) w.resolve(m.data);
    else w.reject(new Error(m.error || '云端操作失败'));
  });

  function callBridge(op, row) {
    return ensureBridge().then(function (f) {
      return new Promise(function (resolve, reject) {
        var id = 'r' + (++seq);
        waiting[id] = { resolve: resolve, reject: reject };
        try {
          f.contentWindow.postMessage({ ch: CH, id: id, op: op, row: row }, CFG.endpoint);
        } catch (err) {
          delete waiting[id];
          reject(new Error('云端桥接不可用（' + (err.message || err) + '）'));
          return;
        }
        setTimeout(function () {
          if (!waiting[id]) return;
          delete waiting[id];
          reject(new Error('云端响应超时，请检查网络后重试'));
        }, 20000);
      });
    });
  }

  /* ---------------- 设备信息 ---------------- */

  function deviceId() {
    var id = '';
    try { id = localStorage.getItem('tiku.did') || ''; } catch (e) { id = ''; }
    if (!id) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      try { localStorage.setItem('tiku.did', id); } catch (e) {}
    }
    return id;
  }

  function deviceName() {
    var n = '';
    try { n = localStorage.getItem('tiku.dname') || ''; } catch (e) { n = ''; }
    if (!n) {
      n = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent) ? '手机' : '电脑';
      try { localStorage.setItem('tiku.dname', n); } catch (e) {}
    }
    return n;
  }

  function setDeviceName(n) {
    n = String(n || '').trim().slice(0, 12);
    if (!n) return;
    try { localStorage.setItem('tiku.dname', n); } catch (e) {}
  }

  /** 轻量内容指纹（判断有没有变，避免重复上传） */
  function hashOf(str) {
    str = String(str || '');
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return 'h' + h.toString(36) + '-' + str.length.toString(36);
  }

  /* ---------------- 对外接口 ---------------- */

  function push(payload, hash) {
    var row = {
      device: deviceId(),
      device_name: deviceName(),
      updated_at: Date.now(),
      hash: hash,
      payload: payload
    };
    var job = sameOrigin()
      ? getClient().then(function (c) { return c.database.from(CFG.table).upsert(row).select(); })
          .then(function (r) { if (r && r.error) throw new Error(r.error.message || '上传失败'); })
      : callBridge('upsert', row);
    return job.then(function () {
      status.lastPush = Date.now();
      return true;
    });
  }

  function pull() {
    var job = sameOrigin()
      ? getClient().then(function (c) {
          return c.database.from(CFG.table).select('device, device_name, updated_at, hash, payload');
        }).then(function (r) {
          if (r && r.error) throw new Error(r.error.message || '读取失败');
          return r.data || [];
        })
      : callBridge('select', null).then(function (data) { return data || []; });
    return job.then(function (rows) {
      status.lastPull = Date.now();
      return rows;
    });
  }

  window.CloudSync = {
    cfg: CFG,
    originOk: originOk,
    sameOrigin: sameOrigin,
    mode: mode,
    deviceId: deviceId,
    deviceName: deviceName,
    setDeviceName: setDeviceName,
    hashOf: hashOf,
    push: push,
    pull: pull,
    status: status
  };
})();
