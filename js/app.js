/* =========================================================
 * app.js — 页面渲染与交互
 * ---------------------------------------------------------
 * 页面：home 首页 / capture 拍照 / crop 裁剪 / confirm 确认
 *      bank 题库 / point 考点详情 / review 复习 / settings 设置
 * ========================================================= */
(function () {
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const sheetRoot = document.getElementById('sheet-root');
  const esc = Util.esc;

  /* =========================================================
   * 全局状态
   * ======================================================= */
  const S = {
    page: 'home',
    params: {},
    stack: [],
    session: null,        // { images:[], subject, grade, stage }
    drafts: [],
    aiFallback: '',
    defaults: { subject: '数学', grade: '五年级', term: '上册', version: '苏教版' },
    imgUrls: {},          // assetId -> objectURL
    open: {},             // questionId -> 是否展开
    cache: {},
    bank: { subject: '全部', grade: '全部', keyword: '', status: '全部', type: '全部', difficulty: '', unit: '' },
    reviewCfg: { subject: '全部', scope: 'due', limit: 10 },
    review: null
  };

  (function loadDefaults() {
    try {
      const d = JSON.parse(localStorage.getItem('tiku.defaults') || 'null');
      if (d && d.subject) S.defaults = Object.assign(S.defaults, d);
      const r = JSON.parse(localStorage.getItem('tiku.reviewCfg') || 'null');
      if (r) S.reviewCfg = Object.assign(S.reviewCfg, r);
    } catch (e) {}
  })();

  function saveDefaults() {
    localStorage.setItem('tiku.defaults', JSON.stringify(S.defaults));
    localStorage.setItem('tiku.reviewCfg', JSON.stringify(S.reviewCfg));
  }

  /* =========================================================
   * UI 基础组件：toast / sheet / 对话框
   * ======================================================= */
  const UI = {
    toast(msg, ms) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(UI._tt);
      UI._tt = setTimeout(function () { t.classList.remove('show'); }, ms || 1800);
    },

    sheet(opts) {
      sheetRoot.innerHTML =
        '<div class="sheet-mask" data-act="sheet:close"></div>' +
        '<div class="sheet">' +
          '<div class="sheet-grab"></div>' +
          '<div class="sheet-h"><h3>' + esc(opts.title || '') + '</h3>' +
            '<button class="x" data-act="sheet:close">关闭</button></div>' +
          '<div class="sheet-b">' + (opts.body || '') + '</div>' +
        '</div>';
      sheetRoot.classList.add('show');
      if (opts.onMount) opts.onMount(sheetRoot);
    },

    close() {
      sheetRoot.classList.remove('show');
      setTimeout(function () { if (!sheetRoot.classList.contains('show')) sheetRoot.innerHTML = ''; }, 260);
    },

    confirm(text) {
      return new Promise(function (resolve) {
        UI._resolve = resolve;
        UI.sheet({
          title: '确认操作',
          body: '<p style="font-size:14px;line-height:1.7;color:var(--ink-2);margin-bottom:16px">' + esc(text) + '</p>' +
            '<div class="row" style="gap:10px"><button class="btn ghost grow" data-act="dlg:no">取消</button>' +
            '<button class="btn primary grow" data-act="dlg:yes">确定</button></div>'
        });
      });
    },

    prompt(opts) {
      return new Promise(function (resolve) {
        UI._resolve = resolve;
        UI.sheet({
          title: opts.title || '编辑',
          body: '<textarea class="textarea" id="dlgInput" placeholder="' + esc(opts.placeholder || '') + '" ' +
              'style="min-height:' + (opts.rows ? opts.rows * 24 : 120) + 'px">' + esc(opts.value || '') + '</textarea>' +
            (opts.hint ? '<p class="muted" style="margin:8px 2px 0">' + esc(opts.hint) + '</p>' : '') +
            '<div class="row" style="gap:10px;margin-top:14px"><button class="btn ghost grow" data-act="dlg:no">取消</button>' +
            '<button class="btn primary grow" data-act="dlg:ok">保存</button></div>',
          onMount: function () {
            const ta = document.getElementById('dlgInput');
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
          }
        });
      });
    }
  };

  /* =========================================================
   * 路由
   * ======================================================= */
  const MAIN_PAGES = ['home', 'bank', 'review', 'settings'];

  async function navigate(page, params, replace) {
    if (!replace) {
      if (MAIN_PAGES.indexOf(page) >= 0) S.stack = [];
      else if (S.page !== page) S.stack.push({ page: S.page, params: S.params });
    }
    S.page = page;
    S.params = params || {};
    await render();
    window.scrollTo(0, 0);
  }

  async function back() {
    const prev = S.stack.pop();
    if (prev) {
      S.page = prev.page;
      S.params = prev.params;
      await render();
    } else {
      await navigate('home', {}, true);
    }
  }

  async function render() {
    const page = PAGES[S.page];
    if (!page) return;
    document.body.dataset.tab = page.tab === false ? 'off' : 'on';
    if (page.load) await page.load(S.params);
    topbar.innerHTML = page.topbar ? page.topbar(S.params) : '';
    topbar.classList.toggle('hidden', !page.topbar);
    view.innerHTML = page.html(S.params);
    if (page.after) page.after(S.params);
    document.querySelectorAll('.tab').forEach(function (b) {
      const to = b.dataset.to || (b.dataset.act === 'cap:start' ? 'capture' : '');
      const activeMap = { home: 'home', bank: 'bank', point: 'bank', review: 'review', settings: 'settings' };
      b.classList.toggle('active', activeMap[S.page] === to);
    });
  }

  /* =========================================================
   * 共用片段
   * ======================================================= */
  const ARROW = '<svg class="arrow" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';

  function backBtn(label) {
    return '<button class="tb-btn" data-act="back" aria-label="返回">' +
      '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>';
  }

  function heroStats(s) {
    return '<div class="hero-stats">' +
      '<div><b>' + s.questions + '</b><span>题目</span></div>' +
      '<div><b>' + s.points + '</b><span>考点</span></div>' +
      '<div><b>' + s.needsConfirm + '</b><span>待确认</span></div>' +
      '</div>';
  }

  function optionsHtml(q) {
    if (!q.options || !q.options.length) return '';
    return '<p class="qtext opt" style="padding-top:4px">' + q.options.map(esc).join('<br>') + '</p>';
  }

  function questionCard(q, opts) {
    opts = opts || {};
    const open = !!S.open[q.id];
    const url = S.imgUrls[q.id];
    return '<article class="card" data-id="' + q.id + '">' +
      '<div class="row between wrap" style="gap:6px;margin-bottom:8px">' +
        '<div class="row wrap" style="gap:6px">' +
          (opts.hidePoint ? '' : '<span class="chip brand">' + esc(q.pointName || '未分类') + '</span>') +
          '<span class="chip gray">' + esc(q.type) + '</span>' +
          '<span class="chip gray">难度 ' + q.difficulty + '</span>' +
        '</div>' +
      '</div>' +
      '<p class="qtext" style="padding:0">' + esc(q.text) + '</p>' +
      optionsHtml(q) +
      (open
        ? '<div class="solution-box" style="margin:10px 0 0">' +
            '<b>解题思路</b>' + esc(q.solution || '（暂无，可手动补充）') +
            (q.answer ? '<div class="answer-line"><b>答案：</b>' + esc(q.answer) + '</div>' : '') +
          '</div>' +
          (q.assetId
            ? '<div class="mt8" style="border-radius:10px;overflow:hidden;border:1px solid var(--line)">' +
                (url ? '<img src="' + url + '" style="width:100%;display:block">'
                     : '<div class="empty small" style="padding:18px">原图加载中…</div>') + '</div>'
            : '<p class="muted mt8">（没有保存原图）</p>') +
          ((q.images && q.images.length)
            ? '<div class="mt8">' + q.images.map(function (src) {
                return '<img src="' + src + '" style="width:100%;display:block;border:1px solid var(--line);border-radius:10px;background:#fff;margin-top:6px">';
              }).join('') + '</div>'
            : '')
        : '') +
      (open ? sameBox(q) : '') +
      '<div class="qops" style="padding:10px 0 0">' +
        '<button data-act="q:toggle" data-id="' + q.id + '">' + (open ? '收起' : '展开思路/原图') + '</button>' +
        '<button data-act="q:gen" data-id="' + q.id + '">举一反三</button>' +
        '<button data-act="q:basket" data-id="' + q.id + '">' + (Paper.has(q.id) ? '✓ 已入卷' : '加入组卷') + '</button>' +
        '<button data-act="q:point" data-id="' + q.id + '">改考点</button>' +
        '<button class="del" data-act="q:del" data-id="' + q.id + '">删除</button>' +
      '</div>' +
    '</article>';
  }

  /** 同类题（同考点历史题目，标明日期与来源练习） */
  function sameBox(q) {
    const list = (S.cache.same && S.cache.same[q.id]) || [];
    if (!list.length) return '<p class="muted mt8">暂无同考点历史题目</p>';
    return '<div class="same-box mt8">' +
      '<b>同类题 · ' + list.length + ' 道</b>' +
      list.map(function (x) {
        return '<div class="same-item" data-act="q:same" data-id="' + x.id + '">' +
          '<span class="same-date">' + batchDateStr(x) + (x.batch ? ' · ' + esc(x.batch) : '') + '</span>' +
          '<p>' + esc(Util.cut(x.text, 40)) + '</p></div>';
      }).join('') +
      '</div>';
  }

  /* =========================================================
   * 首页
   * ======================================================= */
  const PAGES = {};

  PAGES.home = {
    tab: true,
    topbar() {
      return '<div class="tb-title">' + CONFIG.app.name + '<div class="tb-sub">拍照 → 识别 → 按考点归类</div></div>' +
        '<button class="tb-btn" data-act="goto" data-to="settings" aria-label="设置">' +
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg></button>';
    },
    async load() {
      const [stats, recent, unitQs] = await Promise.all([
        Store.stats(),
        Store.Questions.list({}),
        Store.Questions.list({ subject: S.defaults.subject, grade: S.defaults.grade })
      ]);
      const units = {};
      unitQs.forEach(function (q) { const u = q.unit || '未归类'; units[u] = (units[u] || 0) + 1; });
      S.cache.home = { stats: stats, recent: recent.slice(0, 4), total: recent.length, units: units };
    },
    html() {
      const d = S.cache.home || { stats: {}, recent: [], total: 0, units: {} };
      const s = d.stats;
      const empty = !d.total;

      // 教材目录（按当前默认教材统计各章节题量）
      const def = S.defaults;
      const cat = Catalog.get(def.subject, def.grade, def.term, def.version);
      const uc = d.units || {};
      const unitOrder = cat.filter(u => uc[u]).concat(Object.keys(uc).filter(u => cat.indexOf(u) < 0));
      const unitRows = unitOrder.map(function (u) {
        return '<div class="list-item" data-act="bank:unit" data-unit="' + esc(u) + '">' +
          '<div class="li-main"><div class="li-t">' + esc(u) + '</div></div>' +
          '<span class="li-n">' + uc[u] + ' 题</span>' + ARROW + '</div>';
      }).join('');

      let recentHtml = '';
      if (d.recent.length) {
        recentHtml = d.recent.map(function (q) {
          return '<div class="list-item" data-act="q:openPoint" data-id="' + q.pointId + '">' +
            '<div class="li-main"><div class="li-t">' + esc(Util.cut(q.text, 24)) + '</div>' +
            '<div class="li-s">' + esc(q.pointName || '未分类') + ' · ' + Util.relTime(q.createdAt) + '</div></div>' +
            ARROW + '</div>';
        }).join('');
      } else {
        recentHtml = '<div class="empty small" style="padding:20px 0">还没有题目</div>';
      }

      return '' +
        '<section class="hero">' +
          '<div class="h1">把错题，变成分数</div>' +
          '<div class="h2">拍一张练习册，自动按解题思路归类</div>' +
          heroStats(s) +
        '</section>' +

        '<div class="quick">' +
          '<button data-act="cap:start">' +
            '<span class="q-ico"><svg viewBox="0 0 24 24"><path d="M4 8.5h3l1.6-2.2h6.8L17 8.5h3v10H4z"/><circle cx="12" cy="13.2" r="3.2"/></svg></span>' +
            '<span class="q-t">拍照录题</span><span class="q-d">支持连拍多张</span></button>' +
          '<button data-act="cap:manual">' +
            '<span class="q-ico"><svg viewBox="0 0 24 24"><path d="M5 4.5h9l4 4v11H5z"/><path d="M14 4.5v4h4"/><path d="M8.5 13h6M8.5 16h4"/></svg></span>' +
            '<span class="q-t">手动录题</span><span class="q-d">粘贴文字也能归类</span></button>' +
          '<button data-act="doc:pick">' +
            '<span class="q-ico"><svg viewBox="0 0 24 24"><path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4"/><path d="M9 12h6M9 15.5h6M9 8.5h2"/></svg></span>' +
            '<span class="q-t">导入文件</span><span class="q-d">PDF / Word 一字不差</span></button>' +
          '<button data-act="ot:start">' +
            '<span class="q-ico"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M13 9h5M13 12h5M5 16l4-4 3 3 3-3 4 4"/></svg></span>' +
            '<span class="q-t">图转文字</span><span class="q-d">先解析后入库·保留图形</span></button>' +
        '</div>' +

        '<section class="card">' +
          '<div class="card-h"><h3>教材目录</h3>' +
            '<button class="small" style="color:var(--brand);font-weight:600" data-act="book:switch">' +
              esc(def.subject + ' · ' + def.grade + def.term + ' · ' + def.version) + ' ✎</button></div>' +
          (unitRows ||
            '<div class="empty small" style="padding:14px 0">' +
              esc(cat.slice(0, 4).join(' · ')) + '…<br>拍照录题时选择章节，这里就会按目录汇总</div>') +
        '</section>' +

        (s.needsConfirm
          ? '<section class="card" style="border-left:3px solid var(--warn)" data-act="bank:confirmList">' +
              '<div class="row between"><div>' +
                '<div style="font-weight:700;font-size:14.5px">' + s.needsConfirm + ' 道题待确认考点</div>' +
                '<p class="muted" style="margin-top:2px">AI 拿不准的题，确认后归类更准</p>' +
              '</div>' + ARROW + '</div></section>'
          : '') +

        (empty
          ? '<section class="card"><h3 style="font-size:15px;margin-bottom:6px">先看看效果？</h3>' +
              '<p class="muted">载入 13 道苏教版五上新教材示例练习（含考点与解析），或直接拍照录题。</p>' +
              '<button class="btn soft block mt12" data-act="data:seed">载入示例（苏教版五上新教材练习）</button></section>'
          : '') +

        '<section class="card">' +
          '<div class="card-h"><h3>最近添加</h3>' +
            '<button class="small" style="color:var(--brand);font-weight:600" data-act="goto" data-to="bank">全部 ›</button></div>' +
          recentHtml +
        '</section>' +

        '<section class="card flat" style="background:#fff">' +
          '<p class="muted" style="line-height:1.7">小提示：拍照时让题面填满画面、避免阴影；同一页有多道题也能自动按题号切开。识别不准时可在确认页逐题修改。</p>' +
        '</section>';
    }
  };

  /* =========================================================
   * 拍照页
   * ======================================================= */
  PAGES.capture = {
    tab: false,
    topbar() {
      const n = S.session ? S.session.images.length : 0;
      return backBtn() + '<div class="tb-title">拍照录题' +
        (n ? '<div class="tb-sub">已选 ' + n + ' 张</div>' : '') + '</div>' +
        '<button class="tb-btn text" data-act="cap:pick">相册</button>';
    },
    html() {
      const imgs = S.session ? S.session.images : [];
      const maxSide = (CONFIG.image && CONFIG.image.maxSide) || 2000;

      let grid = imgs.map(function (im, i) {
        return '<div class="shot">' +
          '<div class="img-wrap"><span class="idx">' + (i + 1) + '</span>' +
            '<img src="' + im.url + '" alt="第' + (i + 1) + '张">' +
          '</div>' +
          '<div class="shot-ops">' +
            '<button data-act="cap:rotate" data-i="' + i + '">旋转</button>' +
            '<button data-act="cap:crop" data-i="' + i + '">裁剪</button>' +
            '<button data-act="cap:retake" data-i="' + i + '">重拍</button>' +
            '<button data-act="cap:del" data-i="' + i + '">删除</button>' +
          '</div>' +
        '</div>';
      }).join('');

      if (imgs.length < 9) {
        grid += '<button class="add-tile" data-act="cap:add">' +
          '<span class="plus">＋</span><span>继续添加</span></button>';
      }

      return '' +
        '<div class="card flat" style="background:#fff;margin-top:8px">' +
          '<div class="row wrap" style="gap:6px;align-items:flex-start">' +
            '<span class="chip brand">拍照建议</span>' +
            '<p class="muted" style="flex:1;min-width:180px;line-height:1.6">一次拍一道大题或一页，正对题面、光线均匀、字面尽量大。整页小字也能识别（自动放大处理），但单题拍摄最准。上传前会压缩到长边 ' + maxSide + 'px。</p>' +
          '</div>' +
        '</div>' +
        (imgs.length
          ? '<div class="shots">' + grid + '</div>'
          : '<div class="add-tile" style="aspect-ratio:auto;padding:44px 16px;margin-top:8px" data-act="cap:add">' +
              '<span class="plus">＋</span><span style="font-weight:700;color:var(--ink-2);font-size:14px">拍照 / 从相册选择</span>' +
              '<span style="font-size:12px">支持一次选多张</span></div>') +
        (imgs.length
          ? '<button class="btn ghost block mt12" data-act="cap:manual">没有拍照？粘贴文字录入</button>'
          : '<p class="muted" style="text-align:center;margin-top:14px">识别后可逐题核对、拆分、改考点</p>') +
        '<div class="bottombar">' +
          '<button class="btn ghost" data-act="cap:add">＋ 添加</button>' +
          '<button class="btn primary grow" data-act="cap:run"' + (imgs.length ? '' : ' disabled') + '>' +
            (imgs.length ? '开始识别 · ' + imgs.length + ' 张' : '请先选择图片') + '</button>' +
        '</div>';
    }
  };

  /* =========================================================
   * 裁剪页
   * ======================================================= */
  PAGES.crop = {
    tab: false,
    topbar() {
      return '<button class="tb-btn text" data-act="back">取消</button>' +
        '<div class="tb-title" style="text-align:center">裁剪</div>' +
        '<button class="tb-btn text" data-act="crop:apply">完成</button>';
    },
    html() {
      const im = S.session && S.session.images[S.params.index];
      if (!im) return '<div class="empty">图片不存在</div>';
      return '<p class="muted" style="text-align:center;margin:10px 0 2px">拖动白框选择题目区域</p>' +
        '<div class="crop-stage" id="cropStage">' +
          '<img id="cropImg" src="' + im.url + '" alt="裁剪预览">' +
          '<div class="crop-box" id="cropBox">' +
            '<span class="h nw" data-h="nw"></span><span class="h ne" data-h="ne"></span>' +
            '<span class="h sw" data-h="sw"></span><span class="h se" data-h="se"></span>' +
          '</div>' +
        '</div>' +
        '<div class="row mt16" style="gap:10px">' +
          '<button class="btn ghost grow" data-act="crop:rotate">旋转 90°</button>' +
          '<button class="btn ghost grow" data-act="crop:reset">重置选框</button>' +
        '</div>';
    },
    after() {
      const stage = document.getElementById('cropStage');
      const img = document.getElementById('cropImg');
      const box = document.getElementById('cropBox');
      if (!stage || !img || !box) return;

      function init() {
        const w = img.clientWidth, h = img.clientHeight;
        stage.style.width = w + 'px';
        stage.style.height = h + 'px';
        box.style.left = Math.round(w * 0.04) + 'px';
        box.style.top = Math.round(h * 0.04) + 'px';
        box.style.width = Math.round(w * 0.92) + 'px';
        box.style.height = Math.round(h * 0.92) + 'px';
      }
      if (img.complete) init(); else img.onload = init;

      let mode = null, startX = 0, startY = 0, startRect = null;

      function rect() {
        return {
          left: parseFloat(box.style.left || 0),
          top: parseFloat(box.style.top || 0),
          width: parseFloat(box.style.width || 0),
          height: parseFloat(box.style.height || 0)
        };
      }

      box.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        box.setPointerCapture(e.pointerId);
        const handle = e.target.dataset ? e.target.dataset.h : null;
        mode = handle || 'move';
        startX = e.clientX; startY = e.clientY;
        startRect = rect();
      });

      box.addEventListener('pointermove', function (e) {
        if (!mode) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        const W = img.clientWidth, H = img.clientHeight;
        const r = Object.assign({}, startRect);
        const MIN = 48;
        if (mode === 'move') {
          r.left = Util.clamp(startRect.left + dx, 0, W - startRect.width);
          r.top = Util.clamp(startRect.top + dy, 0, H - startRect.height);
        } else {
          if (mode.indexOf('w') >= 0) {
            const nl = Util.clamp(startRect.left + dx, 0, startRect.left + startRect.width - MIN);
            r.width = startRect.width + (startRect.left - nl); r.left = nl;
          }
          if (mode.indexOf('e') >= 0) {
            r.width = Util.clamp(startRect.width + dx, MIN, W - startRect.left);
          }
          if (mode.indexOf('n') >= 0) {
            const nt = Util.clamp(startRect.top + dy, 0, startRect.top + startRect.height - MIN);
            r.height = startRect.height + (startRect.top - nt); r.top = nt;
          }
          if (mode.indexOf('s') >= 0) {
            r.height = Util.clamp(startRect.height + dy, MIN, H - startRect.top);
          }
        }
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
      });

      function end(e) {
        if (mode) { try { box.releasePointerCapture(e.pointerId); } catch (err) {} }
        mode = null;
      }
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);

      // 供 apply 使用
      S._crop = { rect: rect, img: img };
    }
  };

  /* =========================================================
   * 确认页（OCR 进度 + 题目卡片）
   * ======================================================= */
  PAGES.confirm = {
    tab: false,
    topbar() {
      const stage = S.session && S.session.stage;
      return backBtn() + '<div class="tb-title">' + (stage === 'ocr' ? '正在识别' : '确认题目') +
        '<div class="tb-sub">' + (S.drafts.length ? S.drafts.length + ' 道题' : '请稍候') + '</div></div>' +
        (stage === 'ocr' ? '' : '<button class="tb-btn text" data-act="confirm:add">加一题</button>');
    },
    html() {
      const s = S.session;
      if (!s) return '<div class="empty">没有待确认的内容</div>';

      const scan = '<div class="scan-list" id="scanList">' +
        s.images.map(scanItemHtml).join('') + '</div>';

      if (s.stage === 'ocr') {
        return scan +
          '<section class="card" style="text-align:center;padding:28px 16px">' +
            '<p style="font-weight:700;font-size:15px" id="ocrTip">正在识别文字…</p>' +
            '<p class="muted mt8" id="ocrSub">首次使用会下载中文识别模型（约 15MB），请保持网络</p>' +
            '<div class="bar mt16"><i id="ocrBar" style="width:8%"></i></div>' +
          '</section>' +
          '<button class="btn ghost block mt12" data-act="confirm:cancel">取消识别</button>';
      }

      const subjOpts = CONFIG.subjects.map(function (x) {
        return '<option value="' + x + '"' + (s.subject === x ? ' selected' : '') + '>' + x + '</option>';
      }).join('');
      const gradeOpts = CONFIG.grades.map(function (x) {
        return '<option value="' + x + '"' + (s.grade === x ? ' selected' : '') + '>' + x + '</option>';
      }).join('');

      // 教材章节（按当前教材目录 + 教师自定义），题目入库时会带上 unit 字段
      const cat = Catalog.get(s.subject, s.grade, S.defaults.term, S.defaults.version);
      const unitChips = '<div class="chips">' + cat.map(function (u) {
        return '<button class="tag' + (s.unit === u ? ' active' : '') + '" data-act="confirm:unit" data-v="' + esc(u) + '">' + esc(u) + '</button>';
      }).join('') +
        '<button class="tag" data-act="confirm:addUnit">＋ 新增章节</button>' +
        '</div>';

      let cards = S.drafts.map(function (d, i) {
        const chipPoint = d.aiPending
          ? '<span class="chip gray">AI 归类中…</span>'
          : '<span class="chip brand tap" data-act="draft:point" data-i="' + i + '">' + esc(d.point || '选择考点') + ' ›</span>';
        const chipWarn = (!d.aiPending && d.needsConfirm)
          ? '<span class="chip warn">待确认</span>' : '';
        const body = [d.text].concat(d.subs || [], d.options || []).join('\n');
        return '<article class="qcard' + (d.needsConfirm && !d.aiPending ? ' needs' : '') + '">' +
          '<div class="qcard-h">' +
            '<span class="qno">' + (d.no || (i + 1)) + '</span>' + chipPoint + chipWarn +
            '<span class="chip gray">' + esc(d.type) + '</span>' +
            '<span class="chip gray">难度 ' + d.difficulty + '</span>' +
          '</div>' +
          '<p class="qtext">' + esc(body) + '</p>' +
          (d.images && d.images.length
            ? '<div class="mt8">' + d.images.map(function (src) {
                return '<img src="' + src + '" style="width:100%;display:block;border:1px solid var(--line);border-radius:10px;margin-top:6px;background:#fff">';
              }).join('') + '<p class="muted" style="font-size:12px;margin-top:4px">↑ 题目图形（来自文档，随题保存）</p></div>'
            : '') +
          (d.solution
            ? '<div class="solution-box"><b>解题思路</b>' + esc(d.solution) + '</div>'
            : '') +
          '<div class="qops">' +
            '<button data-act="draft:edit" data-i="' + i + '">编辑</button>' +
            '<button data-act="draft:split" data-i="' + i + '">拆分</button>' +
            (i > 0 ? '<button data-act="draft:merge" data-i="' + i + '">合并到上一题</button>' : '') +
            '<button class="del" data-act="draft:del" data-i="' + i + '">删除</button>' +
          '</div>' +
        '</article>';
      }).join('');

      if (!S.drafts.length) {
        cards = '<div class="empty"><b>没有切出题目</b>识别结果可能是空白，点“加一题”手动录入，或返回重拍。</div>';
      }

      return '' +
        '<div class="row" style="gap:8px;margin-bottom:10px">' +
          '<select class="select" data-change="confirm:subject" style="flex:1">' + subjOpts + '</select>' +
          '<select class="select" data-change="confirm:grade" style="flex:1">' + gradeOpts + '</select>' +
        '</div>' +
        '<section class="card">' +
          '<div class="card-h"><h3>归入章节</h3>' +
            '<span class="row" style="gap:10px">' +
              '<span class="muted" id="unitPicked">' + esc(s.unit || '未选择') + '</span>' +
              '<button class="small" style="color:var(--brand);font-weight:600" data-act="confirm:unitMgr">删除章节</button>' +
            '</span></div>' +
          unitChips +
          '<div class="field mt8"><label>作业时间</label>' +
            '<input class="input" id="batchDate" type="date" value="' + esc(s.batchDate || todayStr()) + '">' +
          '</div>' +
          '<div class="field"><label>练习名称</label>' +
            '<input class="input" id="batchName" placeholder="如：数学练习册P23" value="' + esc(s.batchName || '') + '" ' +
              'onfocus="if(!this.value)this.value=\'' + defaultBatchName() + '\'">' +
          '</div>' +
        '</section>' +
        (S.aiFallback
          ? '<div class="card flat" style="background:var(--warn-soft);border-color:#ffe3b8;margin-bottom:10px">' +
              '<p class="small" style="color:#8a5300">未启用大模型，已用本地规则归类（' + esc(S.aiFallback) + '）。可在“我的 → 设置”里填入 API Key 提升准确率。</p></div>'
          : '') +
        scan +
        '<div id="draftList">' + cards + '</div>' +
        '<div class="bottombar">' +
          '<div class="bb-info">' + S.drafts.length + ' 题<br>待确认 ' + S.drafts.filter(function (d) { return d.needsConfirm && !d.aiPending; }).length + '</div>' +
          '<button class="btn primary grow" data-act="confirm:save"' + (S.drafts.length ? '' : ' disabled') + '>确认入库</button>' +
        '</div>';
    }
  };

  /* =========================================================
   * 图转文字（先解析预览，再导入题库）
   * ======================================================= */
  function copyText(text) {
    return new Promise(function (resolve) {
      function fallback() {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.focus(); ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return ok;
        } catch (e) { return false; }
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(fallback()); });
      } else resolve(fallback());
    });
  }

  PAGES.otext = {
    tab: false,
    topbar() {
      return backBtn() + '<div class="tb-title">图片转文字' +
        '<div class="tb-sub">检查修改后再导入题库</div></div>' +
        '<button class="tb-btn text" data-act="ot:copyAll">全部复制</button>';
    },
    html() {
      const s = S.session;
      if (!s) return '<div class="empty">没有解析结果，请先拍照</div>';
      if (s.stage === 'ocr') {
        return '<div class="scan-list" id="scanList">' + s.images.map(scanItemHtml).join('') + '</div>' +
          '<section class="card" style="text-align:center;padding:28px 16px">' +
            '<p style="font-weight:700;font-size:15px" id="ocrTip">正在识别文字…</p>' +
            '<p class="muted mt8" id="ocrSub">首次使用会下载中文识别模型（约 15MB），请保持网络</p>' +
            '<div class="bar mt16"><i id="ocrBar" style="width:8%"></i></div>' +
          '</section>' +
          '<button class="btn ghost block mt12" data-act="confirm:cancel">取消识别</button>';
      }
      if (s.stage !== 'otext') return '<div class="empty">没有解析结果，请先拍照</div>';
      const blocks = s.images.map(function (im, i) {
        const docImgs = im.docImages || [];
        return '<section class="card">' +
          '<div class="card-h"><h3>图 ' + (i + 1) + ' · 原图与图形</h3>' +
            '<button class="small" style="color:var(--brand);font-weight:600" data-act="ot:copy" data-i="' + i + '">复制文字</button></div>' +
          (im.url
            ? '<img src="' + im.url + '" style="width:100%;display:block;border:1px solid var(--line);border-radius:10px;background:#fff">'
            : '') +
          '<textarea class="input mt8" data-otext="' + i + '" rows="8" ' +
            'style="width:100%;line-height:1.7;font-size:14px">' + esc(im.text || '') + '</textarea>' +
          (docImgs.length
            ? '<div class="mt8">' + docImgs.map(function (src) {
                return '<img src="' + src + '" style="width:100%;display:block;border:1px solid var(--line);border-radius:10px;background:#fff;margin-top:6px">';
              }).join('') + '</div>'
            : '') +
        '</section>';
      }).join('');
      const okCount = s.images.filter(im => im.text && im.text.trim()).length;
      return '<p class="muted" style="margin:8px 4px;line-height:1.6">拍照的原图和题目图形都保留在下方；识别文字可直接修改。确认后点底部按钮，按题号切题入库。</p>' +
        blocks +
        '<div class="bottombar">' +
          '<button class="btn ghost" data-act="ot:more" style="white-space:nowrap">再拍几张</button>' +
          '<button class="btn primary grow" data-act="ot:tobank"' + (okCount ? '' : ' disabled') + '>切题并导入题库' +
            (okCount ? '（' + okCount + ' 图）' : '') + '</button>' +
        '</div>';
    },
    after() {
      document.querySelectorAll('[data-otext]').forEach(function (ta) {
        ta.addEventListener('input', function () {
          const im = S.session && S.session.images[+ta.dataset.otext];
          if (im) im.text = ta.value;
        });
      });
    }
  };

  /* =========================================================
   * 题库页
   * ======================================================= */
  PAGES.bank = {
    tab: true,
    topbar() {
      const n = Paper.count();
      return '<div class="tb-title">题库' +
        '<div class="tb-sub">章节 → 考点</div></div>' +
        '<button class="tb-btn text" data-act="goto" data-to="paper">组卷' + (n ? '·' + n : '') + '</button>' +
        '<button class="tb-btn" data-act="cap:start" aria-label="录题">' +
        '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>';
    },
    async load() {
      const b = S.bank;
      S.cache.bankQ = await Store.Questions.list({
        subject: b.subject, grade: b.grade,
        status: b.status === 'confirm' ? '全部' : b.status,
        needsConfirm: b.status === 'confirm',
        type: b.type, difficulty: b.difficulty
      });
    },
    html() {
      const b = S.bank;
      const subjects = ['全部'].concat(CONFIG.subjects);
      const subjChips = subjects.map(function (s) {
        return '<button class="tag' + (b.subject === s ? ' active' : '') + '" data-act="bank:subject" data-v="' + s + '">' + s + '</button>';
      }).join('');
      const grades = ['全部'].concat(CONFIG.grades);
      const gradeChips = grades.map(function (g) {
        return '<button class="tag' + (b.grade === g ? ' active' : '') + '" data-act="bank:grade" data-v="' + g + '">' + g + '</button>';
      }).join('');
      const stChips = '<button class="tag' + (b.status === 'confirm' ? ' active' : '') + '" data-act="bank:confirmList">待确认</button>';

      return '' +
        '<div class="search" style="margin:8px 0 10px">' +
          '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
          '<input id="bankSearch" data-input="bank:search" placeholder="搜考点、题干关键词" value="' + esc(b.keyword) + '">' +
          (b.keyword || b.unit ? '<button class="small" data-act="bank:clear" style="color:var(--ink-3)">清除</button>' : '') +
        '</div>' +
        '<div class="chips">' + subjChips + '</div>' +
        '<div class="chips">' + gradeChips + '</div>' +
        '<div class="chips">' + stChips +
          '<button class="tag" data-act="bank:filter">更多筛选</button>' +
        '</div>' +
        (b.unit
          ? '<div class="row between" style="margin:2px 4px 8px">' +
              '<span class="chip brand">章节：' + esc(b.unit) + '</span>' +
              '<button class="small" style="color:var(--brand);font-weight:600" data-act="bank:unit" data-v="">查看全部章节</button>' +
            '</div>'
          : '') +
        '<div id="bankList">' + bankContentHtml() + '</div>';
    },
    after() {
      const input = document.getElementById('bankSearch');
      if (input) {
        input.addEventListener('input', function () {
          S.bank.keyword = input.value.trim();
          const list = document.getElementById('bankList');
          if (list) list.innerHTML = bankContentHtml();
        });
      }
    }
  };

  function bankContentHtml() {
    const b = S.bank;
    let qs = S.cache.bankQ || [];
    const kw = b.keyword.trim().toLowerCase();
    if (kw) {
      qs = qs.filter(function (q) {
        return [q.text, q.pointName, q.solution, q.answer, q.type, q.unit].join(' ').toLowerCase().indexOf(kw) >= 0;
      });
    }
    const browsing = !kw && b.status === '全部' && b.type === '全部' && !b.difficulty && !b.unit;

    // 1) 搜索 / 筛选 → 题目列表
    if (!browsing) {
      const list = b.unit ? qs.filter(q => (q.unit || '未归类') === b.unit) : qs;
      if (!list.length) return '<div class="empty"><b>没有匹配的题目</b>换个条件试试</div>';
      return '<div class="row between" style="margin:0 4px 8px"><span class="muted">共 ' + list.length + ' 道</span></div>' +
        list.slice(0, 100).map(function (q) { return questionCard(q); }).join('');
    }

    // 2) 浏览模式：章节 → 考点（章节顺序按教材目录）
    const byUnit = {};
    qs.forEach(function (q) { const u = q.unit || '未归类'; (byUnit[u] = byUnit[u] || []).push(q); });
    let units = Object.keys(byUnit);
    if (b.subject !== '全部') {
      const def = S.defaults;
      const cat = Catalog.get(b.subject, b.grade === '全部' ? def.grade : b.grade, def.term, def.version);
      units = cat.filter(u => byUnit[u]).concat(units.filter(u => cat.indexOf(u) < 0 && u !== '未归类'));
      if (byUnit['未归类']) units.push('未归类');
    }
    if (!units.length) {
      return '<div class="empty"><b>题库还是空的</b>去拍一张练习册吧</div>' +
        '<button class="btn primary block" data-act="cap:start">拍照录题</button>';
    }

    return units.map(function (u) {
      const list = byUnit[u];
      const byPoint = {};
      list.forEach(function (q) {
        const key = q.pointId || 'n:' + (q.pointName || '未分类');
        const e = byPoint[key] || (byPoint[key] = { id: q.pointId, name: q.pointName || '未分类', count: 0 });
        e.count++;
      });
      const rows = Object.keys(byPoint).map(function (k) {
        const p = byPoint[k];
        return '<div class="list-item" data-act="goto" data-to="point" data-id="' + (p.id || '') + '">' +
          '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div></div>' +
          '<span class="li-n">' + p.count + '</span>' + ARROW + '</div>';
      }).join('');
      return '<section class="card">' +
        '<div class="card-h"><h3>' + esc(u) + '</h3>' +
          '<div class="row" style="gap:6px"><span class="muted">' + list.length + ' 题 · ' +
            Object.keys(byPoint).length + ' 考点</span>' +
          '<button class="btn ghost sm" data-act="unit:paper" data-unit="' + esc(u) + '">组单元卷</button></div></div>' +
        rows +
      '</section>';
    }).join('');
  }

  /* =========================================================
   * 考点详情
   * ======================================================= */
  PAGES.point = {
    tab: true,
    topbar(p) {
      return backBtn() + '<div class="tb-title">考点' +
        '<div class="tb-sub">' + esc((S.cache.point && S.cache.point.name) || '') + '</div></div>' +
        '<button class="tb-btn text" data-act="point:more">管理</button>';
    },
    async load(p) {
      const point = await DB.get('points', p.id);
      const list = point ? await Store.Questions.list({ pointId: point.id }) : [];
      S.cache.point = point ? Object.assign({}, point, { count: list.length }) : null;
      S.cache.pointList = list;
    },
    html() {
      const p = S.cache.point;
      if (!p) return '<div class="empty">考点不存在</div>';
      const list = S.cache.pointList || [];
      return '' +
        '<section class="card" style="background:linear-gradient(135deg,#eef2ff,#f7f5ff);box-shadow:none">' +
          '<div class="row between"><div>' +
            '<div style="font-size:17px;font-weight:800">' + esc(p.name) + '</div>' +
            '<div class="muted mt8">' + esc(p.subject) + ' · ' + esc(p.grade) + '</div>' +
          '</div>' +
          '<div style="text-align:center"><div style="font-size:24px;font-weight:800;color:var(--brand)">' + list.length + '</div>' +
            '<div class="muted">道题</div></div>' +
          '</div>' +
          '<div class="row mt12" style="gap:8px">' +
            '<button class="btn soft grow sm" data-act="point:review" data-id="' + p.id + '">复习这个考点</button>' +
            '<button class="btn ghost grow sm" data-act="point:rename" data-id="' + p.id + '">重命名</button>' +
          '</div>' +
          ((p.aliases || []).length
            ? '<p class="muted" style="margin-top:10px">已合并别名：' + esc((p.aliases || []).join('、')) + '</p>'
            : '') +
        '</section>' +

        '<section class="card">' +
          '<div class="card-h"><h3>学生掌握情况</h3>' +
            '<span class="muted">' + (p.mastery && p.mastery.note ? esc(Util.cut(p.mastery.note, 16)) : '标记后复习时优先练薄弱考点') + '</span></div>' +
          '<div class="chips" style="padding-bottom:0">' +
            Store.Mastery.LEVELS.map(function (m) {
              return '<button class="tag' + (Store.Mastery.levelOf(p) === m[0] ? ' active' : '') + '" data-act="point:mastery" data-v="' + m[0] + '">' + m[1] + '</button>';
            }).join('') +
            '<button class="tag" data-act="point:masternote">✎ 备注</button>' +
          '</div>' +
        '</section>' +

        (list.length
          ? list.map(function (q) { return questionCard(q, { hidePoint: true }); }).join('')
          : '<div class="empty"><b>这个考点下还没有题目</b></div>');
    }
  };

  /* =========================================================
   * 复习页
   * ======================================================= */
  PAGES.review = {
    tab: true,
    topbar() {
      if (S.review && S.review.started && !S.review.done) {
        return backBtn() + '<div class="tb-title">复习中</div>' +
          '<button class="tb-btn text" data-act="review:quit">结束</button>';
      }
      return '<div class="tb-title">复习' +
        '<div class="tb-sub">随机抽题 · 隐藏答案自测</div></div>';
    },
    async load() {
      S.cache.reviewStats = await Store.stats();
      // 从考点详情点“复习这个考点”进来时，自动开一组
      if (S.params.pointId && S.params.auto) {
        S.params.auto = false;
        await prepareReview(S.params.pointId);
      }
    },
    html() {
      if (S.review) return reviewRunningHtml();
      return reviewSetupHtml();
    }
  };

  function reviewSetupHtml() {
    const s = S.cache.reviewStats || { due: 0, questions: 0, wrong: 0, mastered: 0 };
    const cfg = S.reviewCfg;
    const subj = ['全部'].concat(CONFIG.subjects).map(function (x) {
      return '<button class="tag' + (cfg.subject === x ? ' active' : '') + '" data-act="review:subject" data-v="' + x + '">' + x + '</button>';
    }).join('');
    const scopes = [['due', '待复习 ' + s.due], ['wrong', '错题本 ' + s.wrong], ['weak', '薄弱考点'], ['all', '全部 ' + s.questions]];
    const scopeChips = scopes.map(function (p) {
      return '<button class="tag' + (cfg.scope === p[0] ? ' active' : '') + '" data-act="review:scope" data-v="' + p[0] + '">' + p[1] + '</button>';
    }).join('');
    const limits = [5, 10, 20].map(function (n) {
      return '<button class="tag' + (cfg.limit === n ? ' active' : '') + '" data-act="review:limit" data-v="' + n + '">' + n + ' 题</button>';
    }).join('');

    return '' +
      '<section class="hero" style="margin-top:8px;background:linear-gradient(135deg,#0f9d76,#39c08d)">' +
        '<div class="h1">今天复习 ' + Math.min(cfg.limit, Math.max(s.due, 0)) + ' 题？</div>' +
        '<div class="h2">先自己想，再翻答案，最后标记掌握情况</div>' +
        '<div class="hero-stats"><div><b>' + s.due + '</b><span>待复习</span></div>' +
          '<div><b>' + s.mastered + '</b><span>已掌握</span></div>' +
          '<div><b>' + s.wrong + '</b><span>错题</span></div>' +
          '<div><b>' + s.questions + '</b><span>总题量</span></div></div>' +
      '</section>' +
      '<section class="card">' +
        '<div class="card-h"><h3>范围</h3></div>' +
        '<div class="chips">' + subj + '</div>' +
        '<div class="chips">' + scopeChips + '</div>' +
        '<div class="chips">' + limits + '</div>' +
        '<button class="btn primary lg block mt12" data-act="review:start">开始复习</button>' +
      '</section>' +
      '<section class="card flat" style="background:#fff">' +
        '<p class="muted" style="line-height:1.7">标记“已掌握”后，按 1 / 2 / 4 / 7 / 15 / 30 天的间隔安排下次复习；标记“待复习”会回到错题本。</p>' +
      '</section>';
  }

  function reviewRunningHtml() {
    const r = S.review;
    if (r.done) {
      const total = r.ok + r.again;
      return '<div class="review-stage">' +
        '<div class="review-card" style="justify-content:center;text-align:center">' +
          '<div style="font-size:40px;margin-bottom:8px">🎉</div>' +
          '<h2 style="font-size:18px">这一组完成了</h2>' +
          '<p class="muted mt8">共 ' + total + ' 题 · 已掌握 ' + r.ok + ' · 待复习 ' + r.again + '</p>' +
          '<button class="btn primary block mt16" data-act="review:again">再来一组</button>' +
          '<button class="btn ghost block mt8" data-act="goto" data-to="home">回到首页</button>' +
        '</div></div>';
    }
    const q = r.queue[r.idx];
    const pct = Math.round((r.idx / r.queue.length) * 100);
    return '<div class="review-progress"><span class="muted">' + (r.idx + 1) + '/' + r.queue.length + '</span>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<span class="chip brand">' + esc(q.pointName || '未分类') + '</span></div>' +
      '<div class="review-stage"><div class="review-card">' +
        '<div class="row" style="gap:6px;margin-bottom:12px">' +
          '<span class="chip gray">' + esc(q.type) + '</span>' +
          '<span class="chip gray">难度 ' + q.difficulty + '</span>' +
          (q.wrongCount ? '<span class="chip warn">错 ' + q.wrongCount + ' 次</span>' : '') +
        '</div>' +
        '<div class="review-q">' + esc(q.text) + optionsHtml(q) + '</div>' +
        '<div class="grow"></div>' +
        (r.revealed
          ? '<div class="review-ans">' +
              '<div class="solution-box" style="margin:0"><b>解题思路</b>' + esc(q.solution || '（暂无思路，可稍后补充）') + '</div>' +
              (q.answer ? '<p class="mt8" style="font-size:14px"><b style="color:var(--ok)">答案：</b>' + esc(q.answer) + '</p>' : '') +
            '</div>'
          : '<p class="muted" style="text-align:center">先在心里做一遍，再点下面看思路</p>') +
        '<div class="mt16">' +
          (r.revealed
            ? '<div class="row" style="gap:10px">' +
                '<button class="btn danger-soft grow lg" data-act="review:mark" data-v="again">还要复习</button>' +
                '<button class="btn ok-soft grow lg" data-act="review:mark" data-v="ok">已掌握</button>' +
              '</div>' +
              '<button class="btn soft block mt8" data-act="review:gen">举一反三 · 再出几道同类题</button>'
            : '<button class="btn primary block lg" data-act="review:reveal">显示思路 / 答案</button>') +
          '<button class="btn ghost block mt8" data-act="review:next">跳过这题</button>' +
        '</div>' +
      '</div></div>';
  }

  /* =========================================================
   * 设置页
   * ======================================================= */
  PAGES.settings = {
    tab: true,
    topbar() {
      return '<div class="tb-title">我的' +
        '<div class="tb-sub">识别与 AI 配置、数据管理</div></div>';
    },
    async load() {
      S.cache.settingsStats = await Store.stats();
    },
    html() {
      const st = S.cache.settingsStats || {};
      const ocr = CONFIG.ocr, llm = CONFIG.llm;
      const cv = S._catVersion || S.defaults.version;
      const catList = Catalog.get(S.defaults.subject, S.defaults.grade, S.defaults.term, cv);
      const custom = Catalog.hasCustom(S.defaults.subject, S.defaults.grade, S.defaults.term, cv);
      const providerOpts = [['tesseract', 'Tesseract.js（免费·纯前端）'], ['baidu', '百度 OCR（需 Key）'],
        ['tencent', '腾讯云 OCR（需 Key）'], ['manual', '关闭识别（手动输入）']].map(function (p) {
        return '<option value="' + p[0] + '"' + (ocr.provider === p[0] ? ' selected' : '') + '>' + p[1] + '</option>';
      }).join('');

      return '' +
        '<section class="card" style="margin-top:8px">' +
          '<div class="row between"><div><div style="font-weight:700">' + (st.questions || 0) + ' 道题 · ' + (st.points || 0) + ' 个考点</div></div>' +
            '<span class="chip brand">v' + CONFIG.app.version + '</span></div>' +
        '</section>' +

        '<div class="sec-title">默认学科 / 年级</div>' +
        '<section class="card">' +
          '<div class="row" style="gap:8px">' +
            '<select class="select" id="defSubject" style="flex:1">' +
              CONFIG.subjects.map(function (x) { return '<option' + (S.defaults.subject === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') +
            '</select>' +
            '<select class="select" id="defGrade" style="flex:1">' +
              CONFIG.grades.map(function (x) { return '<option' + (S.defaults.grade === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') +
            '</select>' +
          '</div>' +
          '<p class="muted mt8">新建题目时会用这两项作为默认值</p>' +
        '</section>' +

        '<div class="sec-title">文字识别（OCR）</div>' +
        '<section class="card">' +
          '<div class="field"><label>识别方式</label>' +
            '<select class="select" data-change="settings:provider">' + providerOpts + '</select></div>' +
          (ocr.provider === 'baidu' || ocr.provider === 'tencent'
            ? '<div class="field"><label>代理地址（server/ocr-proxy.mjs）</label>' +
                '<input class="input code" id="cfgProxy" value="' + esc(ocr.proxyUrl) + '" placeholder="http://localhost:8787/api/ocr"></div>' +
              '<p class="muted">云 OCR 的 Key 请写在代理服务的环境变量里（见 README），前端不保存密钥。</p>'
            : '<p class="muted">Tesseract.js 在手机浏览器本地跑，首次识别需下载中文模型（约 15MB）。识别速度约 5–15 秒/张。</p>') +
        '</section>' +

        '<div class="sec-title">AI 归类（大模型）</div>' +
        '<section class="card">' +
          '<div class="row between" style="margin-bottom:10px">' +
            '<span style="font-weight:600;font-size:14px">启用大模型归类</span>' +
            '<label class="switch"><input type="checkbox" id="cfgLlmEnabled"' + (llm.enabled ? ' checked' : '') + ' data-change="settings:llm"></label>' +
          '</div>' +
          '<div class="field"><label>接口地址（OpenAI 兼容）</label>' +
            '<input class="input code" id="cfgBaseUrl" value="' + esc(llm.baseUrl) + '" placeholder="https://api.deepseek.com/v1"></div>' +
          '<div class="field"><label>模型名</label>' +
            '<input class="input code" id="cfgModel" value="' + esc(llm.model) + '" placeholder="deepseek-chat"></div>' +
          '<div class="field"><label>API Key（只存本机）</label>' +
            '<input class="input code" id="cfgApiKey" type="password" value="' + esc(llm.apiKey) + '" placeholder="sk-..."></div>' +
          '<div class="row" style="gap:8px">' +
            '<button class="btn ghost grow" data-act="settings:test">测试连接</button>' +
            '<button class="btn primary grow" data-act="settings:save">保存配置</button>' +
          '</div>' +
          '<p class="muted mt8">不填也能用：会降级为内置的关键词规则归类，准确率一般，适合先跑通流程。</p>' +
        '</section>' +

        '<div class="sec-title">教材目录</div>' +
        '<section class="card">' +
          '<div class="row between" style="margin-bottom:8px">' +
            '<span class="small" style="font-weight:600">' + esc(S.defaults.subject + ' · ' + S.defaults.grade + S.defaults.term) + '</span>' +
            '<select class="select" style="width:auto;min-height:36px;padding:4px 8px;font-size:13px" data-change="settings:catVersion">' +
              Catalog.versions.map(function (v) {
                return '<option' + (cv === v ? ' selected' : '') + '>' + v + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<textarea class="textarea" id="catText" style="min-height:160px">' + esc(Catalog.toText(catList)) + '</textarea>' +
          '<p class="muted mt8">每行一个单元，保存后拍照页 / 题库页即用此目录（仅对 ' +
            esc(S.defaults.subject + ' · ' + S.defaults.grade + S.defaults.term + ' · ' + cv) + ' 生效' + (custom ? '，当前已自定义' : '') + '）。</p>' +
          '<div class="row mt8" style="gap:8px">' +
            '<button class="btn ghost grow" data-act="settings:catreset">恢复默认</button>' +
            '<button class="btn primary grow" data-act="settings:catsave">保存目录</button>' +
          '</div>' +
        '</section>' +

        '<div class="sec-title">数据</div>' +
        '<section class="card">' +
          '<div class="card-h"><h3>手机 ↔ 电脑同步</h3></div>' +
          '<button class="btn ghost block" data-act="data:syncUp">备份本机数据到电脑</button>' +
          '<button class="btn ghost block mt8" data-act="data:syncDown">从电脑恢复 / 合并到本机</button>' +
          '<p class="muted mt8">需与电脑连同一 Wi-Fi 且电脑上的服务在运行。恢复采用合并方式：相同题目覆盖为电脑版本，本机新增的题目保留。</p>' +
        '</section>' +
        '<section class="card">' +
          '<button class="btn ghost block" data-act="data:export">导出全部数据（JSON）</button>' +
          '<button class="btn ghost block mt8" data-act="data:import">导入 JSON</button>' +
          '<button class="btn ghost block mt8" data-act="data:seed">载入示例（苏教版五上练习）</button>' +
          '<button class="btn danger-soft block mt8" data-act="data:clear">清空所有数据</button>' +
          '<p class="muted mt8">数据保存在本机浏览器 IndexedDB 中，换设备/清缓存会丢失，建议定期导出备份。</p>' +
        '</section>' +

        '<section class="card flat" style="background:#fff">' +
          '<div class="kv"><span class="k">图片压缩</span><span class="v">长边 ≤ ' + CONFIG.image.maxSide + 'px</span></div>' +
          '<div class="kv"><span class="k">当前识别方式</span><span class="v">' + esc(ocr.provider) + '</span></div>' +
          '<div class="kv"><span class="k">AI 归类</span><span class="v">' + (AI.enabled() ? esc(llm.model) : '本地规则') + '</span></div>' +
        '</section>';
    }
  };

  /* =========================================================
   * 组卷页 / 试卷预览页
   * ======================================================= */
  PAGES.paper = {
    tab: true,
    topbar() {
      return backBtn() + '<div class="tb-title">组卷' +
        '<div class="tb-sub">试卷篮 ' + Paper.count() + ' 题</div></div>' +
        (Paper.count() ? '<button class="tb-btn text" data-act="paper:clear">清空</button>' : '');
    },
    async load() {
      S.cache.paperQs = await Paper.questions();
      S.cache.papers = await Store.Papers.list();
    },
    html() {
      const qs = S.cache.paperQs || [];
      let list = qs.map(function (q, i) {
        return '<div class="card flat" style="margin-bottom:8px;background:#fff">' +
          '<div class="row" style="align-items:flex-start;gap:6px">' +
            '<span class="qno">' + (i + 1) + '</span>' +
            '<p class="grow small" style="line-height:1.6">' + esc(Util.cut(q.text, 60)) + '</p>' +
          '</div>' +
          '<div class="row" style="gap:6px;margin-top:8px">' +
            '<span class="chip gray">' + esc(q.type) + '</span>' +
            '<span class="chip brand">' + esc(q.pointName || '') + '</span>' +
            '<span class="grow"></span>' +
            '<button class="btn ghost sm" data-act="paper:up" data-id="' + q.id + '">↑</button>' +
            '<button class="btn ghost sm" data-act="paper:down" data-id="' + q.id + '">↓</button>' +
            '<button class="btn danger-soft sm" data-act="paper:del" data-id="' + q.id + '">移出</button>' +
          '</div>' +
        '</div>';
      }).join('');

      if (!qs.length) {
        list = '<div class="empty"><b>试卷篮是空的</b>在题目卡片上点「加入组卷」，或在题库章节里点「组单元卷」</div>';
      }

      const saved = (S.cache.papers || []).map(function (p) {
        return '<div class="list-item" data-act="paper:view" data-id="' + p.id + '">' +
          '<div class="li-main"><div class="li-t">' + esc(p.title) + '</div>' +
          '<div class="li-s">' + p.questionIds.length + ' 题 · ' + Util.fmtDate(p.createdAt) + '</div></div>' +
          '<button class="btn danger-soft sm" data-act="paper:delSaved" data-id="' + p.id + '">删除</button>' + ARROW + '</div>';
      }).join('');

      return '' +
        '<section class="card">' +
          '<div class="field" style="margin-bottom:0"><label>试卷标题</label>' +
            '<input class="input" id="paperTitle" value="' + esc(S.paperTitle || '单元练习') + '" placeholder="如：多边形的面积 单元练习"></div>' +
        '</section>' +
        list +
        '<div class="row mt12" style="gap:10px">' +
          '<button class="btn ghost grow" data-act="paper:save"' + (qs.length ? '' : ' disabled') + '>保存试卷</button>' +
          '<button class="btn primary grow" data-act="paper:preview"' + (qs.length ? '' : ' disabled') + '>预览 / 打印</button>' +
        '</div>' +
        (saved
          ? '<div class="sec-title">已保存试卷</div><section class="card">' + saved + '</section>'
          : '');
    }
  };

  PAGES.paperView = {
    tab: false,
    topbar() {
      return backBtn() + '<div class="tb-title">试卷预览</div>' +
        '<button class="tb-btn text noprint" data-act="paper:answer">' + (S._pv && S._pv.ans ? '隐藏答案' : '附答案') + '</button>' +
        '<button class="tb-btn text noprint" data-act="paper:print">打印</button>';
    },
    async load(p) {
      const key = p.id || 'basket';
      if (S._pv && S._pv.key === key) return;   // 保留“附答案”状态
      if (p.id) {
        const paper = await Store.Papers.get(p.id);
        if (paper) {
          const qs = [];
          for (const id of paper.questionIds) {
            const q = await DB.get('questions', id);
            if (q) qs.push(q);
          }
          S._pv = { key: key, qs: qs, title: paper.title, ans: false };
        } else {
          S._pv = { key: key, qs: [], title: '试卷不存在', ans: false };
        }
      } else {
        S._pv = { key: key, qs: S.cache.paperQs || [], title: S.paperTitle || '单元练习', ans: false };
      }
    },
    html() {
      const pv = S._pv || { qs: [], title: '' };
      return '<div class="paper-wrap">' +
        Paper.render(pv.qs, { title: pv.title, withAnswer: pv.ans }) +
        '</div>' +
        '<p class="muted noprint" style="text-align:center;margin-top:6px">用浏览器「打印」可存成 PDF 或直接打印</p>';
    }
  };

  /* =========================================================
   * 拍照 / OCR 流程
   * ======================================================= */
  function ensureSession() {
    if (!S.session) {
      S.session = {
        images: [], subject: S.defaults.subject, grade: S.defaults.grade,
        unit: '', batchName: '', batchDate: '', stage: 'pick'
      };
    }
    return S.session;
  }

  function startCapture() {
    ensureSession();
    navigate('capture');
  }

  async function addFiles(files) {
    const s = ensureSession();
    UI.toast('正在压缩图片…');
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      try {
        const r = await ImageTool.compress(f);
        s.images.push({
          id: Util.uid('im'), blob: r.blob, url: URL.createObjectURL(r.blob),
          w: r.width, h: r.height, status: 'idle', text: '', pct: 0
        });
      } catch (e) {
        console.warn(e);
        UI.toast('有图片处理失败：' + e.message);
      }
    }
    if (S.page === 'capture') await render();
    else await navigate('capture', {}, true);
  }

  function clearSession() {
    if (!S.session) return;
    S.session.images.forEach(function (im) { URL.revokeObjectURL(im.url); });
    S.session = null;
    S.drafts = [];
    S.aiFallback = '';
  }

  function defaultBatchName() {
    const d = new Date();
    return '练习 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** "2026-11-05" → "11月5日"；空值回退到时间戳格式 */
  function batchDateStr(q) {
    if (q && q.batchDate) {
      const m = String(q.batchDate).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (m) return parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日';
      return q.batchDate;
    }
    return q ? Paper.dateStr(q.date || q.createdAt) : '';
  }

  function scanLabel(im) {
    return im.status === 'done' ? '✓'
      : im.status === 'error' ? '失败'
      : im.status === 'running' ? Math.round((im.pct || 0) * 100) + '%'
      : '待识别';
  }

  function scanItemHtml(im) {
    const inner = im.url
      ? '<img src="' + im.url + '" alt="">'
      : '<div style="width:100%;height:100%;display:grid;place-items:center;font-size:10px;color:var(--ink-3);background:#f2f4f9">文字</div>';
    return '<div class="scan-item ' + (im.status === 'done' ? 'done' : '') + '">' +
      inner + '<span class="st">' + scanLabel(im) + '</span></div>';
  }

  function updateScanUI() {
    const s = S.session;
    if (!s) return;
    // 只更新状态文字，避免每次进度回调都重建 <img> 造成闪烁
    const nodes = document.querySelectorAll('#scanList .scan-item');
    s.images.forEach(function (im, i) {
      const el = nodes[i];
      if (!el) return;
      el.classList.toggle('done', im.status === 'done');
      const st = el.querySelector('.st');
      if (st) st.textContent = scanLabel(im);
    });
    const done = s.images.filter(im => im.status === 'done').length;
    const running = s.images.filter(im => im.status === 'running')[0];
    const tip = document.getElementById('ocrTip');
    if (tip) tip.textContent = '正在识别 ' + Math.min(done + 1, s.images.length) + '/' + s.images.length + ' 张…';
    const bar = document.getElementById('ocrBar');
    if (bar) bar.style.width = Math.round(((done + (running ? (running.pct || 0) : 0)) / s.images.length) * 100) + '%';
  }

  /** 把文字里的【图N】占位替换掉，并把对应的图收集起来归属到该题 */
  function stripImageMarkers(it, imgs) {
    const found = [];
    function clean(s) {
      return String(s || '').replace(/【图(\d+)】/g, function (m, n) {
        const idx = parseInt(n, 10) - 1;
        if (imgs[idx]) { if (found.indexOf(imgs[idx]) < 0) found.push(imgs[idx]); return ''; }
        return m;
      });
    }
    it.text = clean(it.text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    it.subs = (it.subs || []).map(clean);
    it.options = (it.options || []).map(clean);
    return found;
  }

  function buildDrafts() {
    const s = S.session;
    const drafts = [];
    s.images.forEach(function (im, idx) {
      if (!im.text) return;
      // 手动粘贴路径没有经过 OCR.tidy，这里统一清洗（幂等，重复调用无副作用）
      const items = Splitter.split(OCR.tidy ? OCR.tidy(im.text) : im.text);
      const docImgs = im.docImages || [];
      items.forEach(function (it) {
        const found = docImgs.length ? stripImageMarkers(it, docImgs) : [];
        drafts.push({
          key: Util.uid('d'), imgIndex: idx, no: it.no,
          text: it.text, subs: it.subs, options: it.options,
          answer: it.answer, solution: it.solution,
          type: it.type, difficulty: it.difficulty,
          images: found,
          point: '', pointId: '', confidence: 0, needsConfirm: true, aiPending: true
        });
      });
    });
    S.drafts = drafts;
  }

  async function runOCR() {
    const s = ensureSession();
    if (!s.images.length) return;
    s.stage = 'ocr';
    await navigate(s.mode === 'text' ? 'otext' : 'confirm');
    await doOCR();
  }

  async function doOCR() {
    const s = S.session;
    if (!s) return;
    for (const im of s.images) {
      if (im.text) { im.status = 'done'; continue; }
      im.status = 'running';
      im.pct = 0;
      updateScanUI();
      try {
        im.text = await OCR.recognize(im.blob, function (p) {
          im.pct = p;
          updateScanUI();
        });
        im.status = 'done';
      } catch (e) {
        im.status = 'error';
        im.error = e.message;
        im.text = '';
      }
      updateScanUI();
    }

    const failed = s.images.filter(im => im.status === 'error');
    if (failed.length) UI.toast(failed.length + ' 张识别失败：' + (failed[0].error || '未知错误'), 2600);

    // 图转文字模式：停在预览页让老师检查/修改文字，不自动入库
    if (s.mode === 'text') {
      s.stage = 'otext';
      await navigate('otext');
      return;
    }

    buildDrafts();
    s.stage = 'confirm';
    await render();
    await classifyDrafts();
  }

  async function classifyDrafts() {
    const pending = S.drafts.filter(d => d.aiPending);
    if (!pending.length) return;
    S.aiFallback = AI.enabled() ? '' : '未配置大模型';
    const s = S.session;
    const known = (await Store.Points.listBy(s.subject, s.grade)).map(p => p.name);

    // 逐批（每批 6 题）调用，避免超长上下文
    for (let i = 0; i < pending.length; i += 6) {
      const batch = pending.slice(i, i + 6);
      const res = await AI.classify(batch.map(function (d) {
        return { text: d.text, subs: d.subs, options: d.options, type: d.type, difficulty: d.difficulty, answer: d.answer };
      }), { subject: s.subject, grade: s.grade, knownPoints: known });

      batch.forEach(function (d, k) {
        const r = res[k] || {};
        d.point = r.point || '未分类';
        d.solution = r.solution || d.solution;
        d.type = r.type || d.type;
        d.difficulty = r.difficulty || d.difficulty;
        d.answer = r.answer || d.answer;
        d.confidence = r.confidence || 0;
        d.needsConfirm = d.confidence < 0.7 || !d.point || d.point === '未分类';
        d.aiPending = false;
        if (known.indexOf(d.point) < 0 && d.point !== '未分类') known.push(d.point);
      });
      if (res._fallback) S.aiFallback = res._error || '未启用大模型';
    }
    await render();
  }

  async function saveDrafts() {
    const s = S.session;
    if (!s || !S.drafts.length) return;
    UI.toast('正在入库…');
    const assetIds = [];
    for (let i = 0; i < s.images.length; i++) {
      const im = s.images[i];
      if (!im.blob) continue;              // 手动粘贴的纯文字没有原图
      assetIds[i] = await Store.Assets.save(im.blob);
    }
    let n = 0;
    const batchInput = document.getElementById('batchName');
    if (batchInput && batchInput.value.trim()) s.batchName = batchInput.value.trim();
    const dateInput = document.getElementById('batchDate');
    if (dateInput && dateInput.value) s.batchDate = dateInput.value;
    for (const d of S.drafts) {
      const name = (d.point || '未分类').trim() || '未分类';
      let res;
      try {
        res = await Normalize.resolve(name, { subject: s.subject, grade: s.grade });
      } catch (e) {
        res = null;
      }
      const point = res ? res.point : null;
      await Store.Questions.create({
        subject: s.subject,
        grade: s.grade,
        unit: s.unit || '',
        batchName: s.batchName || '',
        batchDate: s.batchDate || todayStr(),
        pointId: point ? point.id : '',
        pointName: point ? point.name : name,
        type: d.type,
        difficulty: d.difficulty,
        text: d.text,
        options: d.options || [],
        subs: d.subs || [],
        answer: d.answer || '',
        solution: d.solution || '',
        images: (d.images && d.images.length) ? d.images : [],
        assetId: assetIds[d.imgIndex] || '',
        confidence: d.confidence,
        needsConfirm: !!d.needsConfirm,
        source: 'ocr'
      });
      n++;
    }
    await Store.Points.recount();
    S.defaults.subject = s.subject; S.defaults.grade = s.grade; saveDefaults();
    clearSession();
    UI.toast('已入库 ' + n + ' 道题');
    await navigate('bank');
  }

  /* =========================================================
   * 考点选择器
   * ======================================================= */
  function pickPoint(current, subject, grade) {
    return new Promise(async function (resolve) {
      const points = await Store.Points.listBy(subject, grade);
      const body = '' +
        '<div class="search" style="margin-bottom:10px">' +
          '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
          '<input id="ppSearch" placeholder="搜索或新建考点">' +
        '</div>' +
        '<div id="ppList">' + ppListHtml(points) + '</div>' +
        '<div class="field mt12"><label>新建考点</label>' +
          '<div class="row" style="gap:8px;align-items:center">' +
            '<input class="input" id="ppNew" placeholder="如：三角形面积求高" style="flex:1">' +
            '<button class="btn soft" data-act="pp:polish" style="white-space:nowrap;padding:10px 12px">AI 简短</button>' +
          '</div>' +
          '<p class="muted" style="font-size:12px;margin-top:4px">输入随手记的说法，点「AI 简短」自动提炼成简短通顺的考点名</p>' +
        '</div>' +
        '<div class="row" style="gap:8px">' +
          '<button class="btn ghost grow" data-act="pp:cancel">取消</button>' +
          '<button class="btn soft grow" data-act="pp:new">新建并选用</button>' +
        '</div>';

      UI._resolve = function (val) { resolve(val); };
      UI.sheet({
        title: '选择考点',
        body: body,
        onMount: function (root) {
          const input = root.querySelector('#ppSearch');
          input.addEventListener('input', function () {
            const kw = input.value.trim().toLowerCase();
            const filtered = !kw ? points : points.filter(function (p) {
              return (p.name + ' ' + (p.aliases || []).join(' ')).toLowerCase().indexOf(kw) >= 0;
            });
            root.querySelector('#ppList').innerHTML = ppListHtml(filtered, kw);
          });
        }
      });
    });
  }

  function ppListHtml(points, kw) {
    let html = points.slice(0, 60).map(function (p) {
      return '<div class="list-item" data-act="pp:pick" data-name="' + esc(p.name) + '" data-id="' + p.id + '">' +
        '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div>' +
        '<div class="li-s">' + (p.count || 0) + ' 题' + ((p.aliases || []).length ? ' · 别名 ' + esc((p.aliases || []).slice(0, 2).join('/')) : '') + '</div></div>' +
        ARROW + '</div>';
    }).join('');
    if (!html) html = '<div class="empty small" style="padding:16px">没有匹配的考点，可在下面新建</div>';
    if (kw) {
      html = '<div class="list-item" data-act="pp:pick" data-name="' + esc(kw) + '" data-id="">' +
        '<div class="li-main"><div class="li-t">＋ 使用“' + esc(kw) + '”</div>' +
        '<div class="li-s">会按同义规则自动归并到已有考点</div></div>' + ARROW + '</div>' + html;
    }
    return html;
  }

  /* =========================================================
   * 举一反三
   * ======================================================= */
  async function openGenSheet(question) {
    UI.sheet({ title: '举一反三', body: '<div class="empty small" style="padding:24px 0">正在出题，请稍候…</div>' });
    const res = await Generator.generate({
      question: question, point: question.pointName, count: 3,
      subject: question.subject, grade: question.grade
    });
    S._gen = { question: question, items: res.items, mode: res.mode };
    renderGenSheet();
  }

  function renderGenSheet() {
    const g = S._gen;
    if (!g || !g.items.length) { UI.close(); return; }
    const modeText = { ai: 'AI 仿写', template: '模板出题', mutate: '数字变体' }[g.mode] || '';
    const body = '<p class="muted" style="margin-bottom:10px">' + modeText +
      ' · 文字、答案、思路都可以直接改，改完一起入库</p>' +
      g.items.map(function (it, i) {
        return '<div class="gen-item">' +
          '<textarea class="textarea" data-gen="text" data-i="' + i + '" style="min-height:92px">' + esc(it.text) + '</textarea>' +
          '<input class="input mt8" data-gen="answer" data-i="' + i + '" placeholder="答案" value="' + esc(it.answer || '') + '">' +
          '<input class="input mt8" data-gen="solution" data-i="' + i + '" placeholder="解题思路" value="' + esc(it.solution || '') + '">' +
          '<button class="btn ghost sm mt8" data-act="gen:del" data-i="' + i + '">删掉这道</button>' +
          '</div>';
      }).join('') +
      '<button class="btn primary block mt12" data-act="gen:saveall">全部入库（' + g.items.length + ' 题）</button>';
    UI.sheet({ title: '举一反三 · ' + (g.question.pointName || ''), body: body });
  }

  /* =========================================================
   * 示例数据：苏教版五年级上册（2026 新教材）配套练习
   * ======================================================= */
  const SEED = [
    /* —— 图形的运动 —— */
    { text: '把一个图形绕某一点旋转 90° 后，什么变了，什么没变？',
      point: '图形的旋转与平移', unit: '图形的运动', batch: '苏教版五上 · P6 练一练',
      solution: '旋转后位置和方向变了，图形的形状、大小都不变。',
      answer: '位置和方向变了，形状、大小不变', type: '解答题', difficulty: 1 },
    { text: '在方格纸上，把三角形向右平移 5 格，再向下平移 3 格。平移后图形的形状和大小改变了吗？',
      point: '图形的旋转与平移', unit: '图形的运动', batch: '苏教版五上 · P8 练习',
      solution: '平移只改变位置，形状、大小不变。',
      answer: '没有改变', type: '解答题', difficulty: 1 },

    /* —— 多边形的面积 —— */
    { text: '一个平行四边形花坛的底是 6 米，高是 4.5 米，它的面积是多少平方米？',
      point: '平行四边形面积', unit: '多边形的面积', batch: '苏教版五上 · P36 练一练',
      solution: 'S=ah，用底×对应的高。',
      answer: '27 平方米', type: '解答题', difficulty: 1 },
    { text: '一块三角形玻璃的面积是 24 平方分米，底是 8 分米，它的高是多少分米？',
      point: '三角形面积求高', unit: '多边形的面积', batch: '苏教版五上 · P40 练一练',
      solution: '由 S=ah÷2 反解 h=2S÷a：先算 24×2=48，再除以 8。',
      answer: '6 分米', type: '解答题', difficulty: 2 },
    { text: '一个梯形上底 3 厘米，下底 7 厘米，高 5 厘米，它的面积是多少平方厘米？',
      point: '梯形面积', unit: '多边形的面积', batch: '苏教版五上 · P42 练一练',
      solution: 'S=(a+b)×h÷2，先算上下底之和，再乘高除以 2。',
      answer: '25 平方厘米', type: '解答题', difficulty: 2 },
    { text: '一块平行四边形麦田，底 250 米，高 160 米。这块麦田有多少公顷？',
      point: '公顷与平方千米', unit: '多边形的面积', batch: '苏教版五上 · P45 练习',
      solution: '先求面积 250×160=40000 平方米，再除以进率 10000 化成公顷。',
      answer: '4 公顷', type: '应用题', difficulty: 2 },

    /* —— 小数乘法和除法(一) —— */
    { text: '计算：0.72 × 5',
      point: '小数乘整数', unit: '小数乘法和除法(一)', batch: '苏教版五上 · P55 例1',
      solution: '先按 72×5 算出 360，因数里有一位小数，从右起数出一位点上小数点。',
      answer: '3.6', type: '计算题', difficulty: 1 },
    { text: '计算：12.6 ÷ 6（想一想：商的小数点要和谁对齐？）',
      point: '小数除以整数', unit: '小数乘法和除法(一)', batch: '苏教版五上 · P58 例2',
      solution: '按整数除法的方法计算，商的小数点要和被除数的小数点对齐。',
      answer: '2.1', type: '计算题', difficulty: 1 },

    /* —— 可能性 —— */
    { text: '袋子里有 3 个红球和 5 个白球，任意摸一个，摸到哪种球的可能性大？为什么？',
      point: '可能性大小', unit: '可能性', batch: '苏教版五上 · P66 练一练',
      solution: '先数总数 8 个，白球个数多，摸到白球的可能性大。',
      answer: '白球的可能性大', type: '解答题', difficulty: 1 },

    /* —— 因数与倍数 —— */
    { text: '在 4、7、12、15、18 这五个数中，哪些数是 3 的倍数？哪些数含有因数 5？',
      point: '因数与倍数', unit: '因数与倍数', batch: '苏教版五上 · P72 练习',
      solution: '用 3、5 逐一试除判断：12、15、18 是 3 的倍数；15 含因数 5。',
      answer: '3 的倍数：12、15、18；含因数 5：15', type: '填空题', difficulty: 1 },
    { text: '两个数的最大公因数是 4，最小公倍数是 24，其中一个数是 8，另一个数是多少？',
      point: '公因数与公倍数', unit: '因数与倍数', batch: '苏教版五上 · 单元测试',
      solution: '两数乘积 = 最大公因数 × 最小公倍数：4×24÷8=12。',
      answer: '12', type: '解答题', difficulty: 3 },

    /* —— 用字母表示数量关系(一) —— */
    { text: '一辆汽车每小时行 v 千米，行了 t 小时。用含有字母的式子表示一共行的千米数；当 v=80、t=3 时，一共行了多少千米？',
      point: '用字母表示数', unit: '用字母表示数量关系(一)', batch: '苏教版五上 · P80 例题',
      solution: '路程=速度×时间，写作 vt；代入 80×3 计算。',
      answer: 'vt；240 千米', type: '填空题', difficulty: 2 },

    /* —— 观察物体(三) —— */
    { text: '用 4 个同样大的正方体摆一个横着的长方体，从正面、上面和侧面看到的分别是什么形状？',
      point: '观察物体', unit: '观察物体(三)', batch: '苏教版五上 · P92 练一练',
      solution: '先摆一摆，再从三个方向逐一观察：正面和上面是长方形，侧面是两个正方形拼成。',
      answer: '正面、上面是长方形，侧面由 2 个正方形拼成（以实际摆法为准）', type: '解答题', difficulty: 1 }
  ];

  async function seedDemo() {
    const subject = S.defaults.subject || '数学';
    const grade = S.defaults.grade || '五年级';
    for (const s of SEED) {
      const res = await Normalize.resolve(s.point, { subject: subject, grade: grade });
      await Store.Questions.create({
        subject: subject, grade: grade,
        unit: s.unit || '',
        pointId: res.point.id, pointName: res.point.name,
        type: s.type, difficulty: s.difficulty,
        text: s.text, answer: s.answer, solution: s.solution,
        source: 'demo', confidence: 0.9, needsConfirm: false
      });
    }
    await Store.Points.recount();
    UI.toast('已载入苏教版五上新教材示例练习（' + SEED.length + ' 题）');
    await render();
  }

  /* =========================================================
   * 动作表
   * ======================================================= */
  const ACTIONS = {
    'goto': function (d) { return navigate(d.to, d.id ? { id: d.id } : {}); },
    'back': back,
    'sheet:close': function () { UI.close(); },
    'dlg:no': function () { UI.close(); if (UI._resolve) { UI._resolve(null); UI._resolve = null; } },
    'dlg:yes': function () { UI.close(); if (UI._resolve) { UI._resolve(true); UI._resolve = null; } },
    'dlg:ok': function () {
      const el = document.getElementById('dlgInput');
      const v = el ? el.value : '';
      UI.close();
      if (UI._resolve) { UI._resolve(v); UI._resolve = null; }
    },

    /* ---- 拍照 ---- */
    'cap:start': function () { ensureSession().mode = 'photo'; startCapture(); },
    'ot:start': function () {
      S.session = null;               // 全新解析会话
      const s = ensureSession();
      s.mode = 'text';
      navigate('capture');
    },
    'ot:more': function () {
      const s = ensureSession();
      s.mode = 'text';
      s.stage = 'pick';
      navigate('capture');
    },
    'ot:copy': async function (d) {
      const im = S.session && S.session.images[+d.i];
      if (!im) return;
      const ok = await copyText(im.text || '');
      UI.toast(ok ? '已复制到剪贴板' : '复制失败，请长按文字手动选择复制', 2200);
    },
    'ot:copyAll': async function () {
      const s = S.session;
      if (!s) return;
      const all = s.images.map(function (im, i) {
        return '【图 ' + (i + 1) + '】\n' + (im.text || '');
      }).join('\n\n');
      const ok = await copyText(all);
      UI.toast(ok ? '全部文字已复制' : '复制失败，请长按文字手动复制', 2200);
    },
    'ot:tobank': async function () {
      const s = S.session;
      if (!s) return;
      buildDrafts();
      if (!S.drafts.length) { UI.toast('没有解析出文字，请重新拍照'); return; }
      s.stage = 'confirm';
      await navigate('confirm');
      await classifyDrafts();
    },
    'cap:add': function () {
      UI.sheet({
        title: '添加图片',
        body: '<div class="row" style="gap:10px">' +
          '<button class="btn primary grow lg" data-act="cap:camera">拍照</button>' +
          '<button class="btn ghost grow lg" data-act="cap:album">从相册选择</button></div>' +
          '<p class="muted mt12">相册支持一次选多张，会自动按选择顺序排列。</p>'
      });
    },
    'cap:camera': function () { UI.close(); document.getElementById('fileCamera').click(); },
    'cap:album': function () { UI.close(); document.getElementById('fileAlbum').click(); },
    'cap:pick': function () { document.getElementById('fileAlbum').click(); },
    'doc:pick': function () { document.getElementById('fileDoc').click(); },
    'cap:rotate': async function (d) {
      const im = S.session.images[+d.i];
      im.blob = await ImageTool.rotate(im.blob, 90);
      URL.revokeObjectURL(im.url);
      im.url = URL.createObjectURL(im.blob);
      await render();
    },
    'cap:crop': function (d) { navigate('crop', { index: +d.i }); },
    'cap:retake': function (d) {
      const im = S.session.images[+d.i];
      URL.revokeObjectURL(im.url);
      S.session.images.splice(+d.i, 1);
      document.getElementById('fileCamera').click();
      render();
    },
    'cap:del': async function (d) {
      const ok = await UI.confirm('删除第 ' + (+d.i + 1) + ' 张图片？');
      if (!ok) return;
      const im = S.session.images[+d.i];
      URL.revokeObjectURL(im.url);
      S.session.images.splice(+d.i, 1);
      await render();
    },
    'cap:run': function () { runOCR(); },
    'cap:manual': async function () {
      const text = await UI.prompt({
        title: '粘贴题目文字', rows: 8,
        placeholder: '把题目文字粘贴到这里，支持 “1. … 2. …” 多题'
      });
      if (!text || !text.trim()) return;
      const s = ensureSession();
      s.images.forEach(im => URL.revokeObjectURL(im.url));
      s.images = [];
      s.images.push({ id: Util.uid('im'), blob: null, url: '', status: 'done', text: text, pct: 1 });
      buildDrafts();
      s.stage = 'confirm';
      await navigate('confirm');
      await classifyDrafts();
    },

    /* ---- 裁剪 ---- */
    'crop:apply': async function () {
      const im = S.session && S.session.images[S.params.index];
      if (!im || !S._crop) return back();
      const r = S._crop.rect();
      const scale = S._crop.img.naturalWidth / S._crop.img.clientWidth;
      const blob = await ImageTool.crop(im.blob, {
        x: r.left * scale, y: r.top * scale, w: r.width * scale, h: r.height * scale
      });
      URL.revokeObjectURL(im.url);
      im.blob = blob;
      im.url = URL.createObjectURL(blob);
      UI.toast('已裁剪');
      await back();
    },
    'crop:rotate': async function () {
      const im = S.session.images[S.params.index];
      im.blob = await ImageTool.rotate(im.blob, 90);
      URL.revokeObjectURL(im.url);
      im.url = URL.createObjectURL(im.blob);
      await render();
    },
    'crop:reset': function () { render(); },

    /* ---- 确认页 ---- */
    'confirm:cancel': async function () {
      S.session.stage = 'pick';
      await navigate('capture');
    },
    'confirm:add': function () {
      S.drafts.push({
        key: Util.uid('d'), imgIndex: 0, no: S.drafts.length + 1,
        text: '', subs: [], options: [], answer: '', solution: '',
        type: '解答题', difficulty: 2, point: '', pointId: '', confidence: 1,
        needsConfirm: true, aiPending: false
      });
      render();
      setTimeout(function () {
        ACTIONS['draft:edit']({ i: String(S.drafts.length - 1) });
      }, 60);
    },
    'draft:edit': async function (d) {
      const i = +d.i;
      const draft = S.drafts[i];
      const body = [draft.text].concat(draft.subs || [], draft.options || []).join('\n');
      const v = await UI.prompt({ title: '编辑第 ' + (i + 1) + ' 题', value: body, rows: 8 });
      if (v == null) return;
      draft.text = v.trim();
      draft.subs = []; draft.options = [];
      draft.type = Splitter.detectType(draft);
      render();
    },
    'draft:split': async function (d) {
      const i = +d.i;
      const draft = S.drafts[i];
      const body = [draft.text].concat(draft.subs || [], draft.options || []).join('\n');
      const v = await UI.prompt({
        title: '拆分题目', value: body, rows: 8,
        hint: '在需要断开的位置单独输入一行 --- ，保存后按此拆成多题'
      });
      if (!v) return;
      const parts = Splitter.splitByMarker(v);
      if (parts.length < 2) { UI.toast('没有找到 --- 分隔符，未拆分'); return; }
      const merged = parts.map(function (p) {
        return Object.assign({}, draft, {
          key: Util.uid('d'), no: p.no, text: p.text, subs: p.subs, options: p.options,
          answer: p.answer, solution: p.solution, type: p.type, difficulty: p.difficulty,
          aiPending: true
        });
      });
      S.drafts.splice.apply(S.drafts, [i, 1].concat(merged));
      await render();
      await classifyDrafts();
    },
    'draft:merge': async function (d) {
      const i = +d.i;
      if (i <= 0) return;
      const cur = S.drafts[i], prev = S.drafts[i - 1];
      const body = [cur.text].concat(cur.subs || [], cur.options || []).join('\n');
      prev.text = (prev.text + '\n' + body).trim();
      prev.subs = []; prev.options = [];
      prev.type = Splitter.detectType(prev);
      prev.needsConfirm = true;
      S.drafts.splice(i, 1);
      await render();
    },
    'draft:del': async function (d) {
      S.drafts.splice(+d.i, 1);
      await render();
    },
    'draft:point': async function (d) {
      const i = +d.i;
      const s = S.session;
      const picked = await pickPoint(S.drafts[i].point, s.subject, s.grade);
      if (!picked) return;
      S.drafts[i].point = picked.name;
      S.drafts[i].pointId = picked.id || '';
      S.drafts[i].needsConfirm = false;
      await render();
    },
    'pp:pick': function (d) {
      const v = { name: d.name, id: d.id };
      UI.close();
      if (UI._resolve) { UI._resolve(v); UI._resolve = null; }
    },
    'pp:cancel': function () { UI.close(); if (UI._resolve) { UI._resolve(null); UI._resolve = null; } },
    'pp:polish': async function () {
      const el = document.getElementById('ppNew');
      const raw = el ? el.value.trim() : '';
      if (!raw) { UI.toast('先输入考点说法，再点「AI 简短」'); return; }
      const btn = document.querySelector('[data-act="pp:polish"]');
      if (btn) { btn.disabled = true; btn.textContent = '润色中…'; }
      try {
        const out = await AI.polish(raw);
        if (el) el.value = out;
        UI.toast(out ? '已提炼：' + out : '没有提炼出结果', 2200);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'AI 简短'; }
      }
    },
    'pp:new': function () {
      const el = document.getElementById('ppNew');
      const name = el ? el.value.trim() : '';
      if (!name) { UI.toast('请输入考点名'); return; }
      UI.close();
      if (UI._resolve) { UI._resolve({ name: name, id: '' }); UI._resolve = null; }
    },
    'confirm:save': function () { saveDrafts(); },

    'confirm:unit': function (d, el) {
      if (!S.session) return;
      S.session.unit = (S.session.unit === d.v) ? '' : d.v;
      document.querySelectorAll('[data-act="confirm:unit"]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.v === S.session.unit);
      });
      const picked = document.getElementById('unitPicked');
      if (picked) picked.textContent = S.session.unit || '未选择';
    },

    'confirm:addUnit': async function () {
      const s = S.session;
      if (!s) return;
      const name = await UI.prompt({ title: '新增章节', rows: 1, placeholder: '章节名称，如：期末专项复习' });
      const clean = (name || '').trim();
      if (!clean) return;
      Catalog.addUnit(s.subject, s.grade, S.defaults.term, S.defaults.version, clean);
      s.unit = clean;
      UI.toast('已添加并选中：' + clean);
      await render();
    },

    'confirm:unitMgr': function () {
      const s = S.session;
      if (!s) return;
      const cat = Catalog.get(s.subject, s.grade, S.defaults.term, S.defaults.version);
      const body = cat.map(function (u) {
        return '<div class="row between" style="padding:9px 2px;border-bottom:0.5px solid var(--color-border-tertiary)">' +
          '<span style="font-size:14px">' + esc(u) + '</span>' +
          '<button class="small" style="color:#b3261e" data-act="confirm:delUnit" data-v="' + esc(u) + '">删除</button></div>';
      }).join('') +
        '<p class="muted mt8">删除只影响章节列表，已入库的题目不受影响。误删可在「我的 → 设置 → 教材目录」恢复默认。</p>';
      UI.sheet({ title: '管理章节（' + cat.length + ' 个）', body: body });
    },

    'confirm:delUnit': function (d) {
      const s = S.session;
      if (!s) return;
      Catalog.removeUnit(s.subject, s.grade, S.defaults.term, S.defaults.version, d.v);
      if (s.unit === d.v) s.unit = '';
      UI.toast('已删除：' + d.v);
      UI.close();
      render();
    },

    /* ---- 举一反三 ---- */
    'gen:del': function (d) {
      if (!S._gen) return;
      S._gen.items.splice(+d.i, 1);
      if (!S._gen.items.length) { UI.close(); return; }
      renderGenSheet();
    },
    'gen:saveall': async function () {
      const g = S._gen;
      if (!g) return;
      const root = document.getElementById('sheet-root');
      const items = g.items.map(function (it, i) {
        const get = function (k) {
          const el = root.querySelector('[data-gen="' + k + '"][data-i="' + i + '"]');
          return el ? el.value.trim() : '';
        };
        return {
          text: get('text'), answer: get('answer'), solution: get('solution'),
          type: it.type, difficulty: it.difficulty
        };
      }).filter(x => x.text);
      if (!items.length) { UI.toast('没有可保存的题目'); return; }
      const q = g.question;
      for (const it of items) {
        await Store.Questions.create({
          subject: q.subject, grade: q.grade, unit: q.unit || '',
          pointId: q.pointId, pointName: q.pointName,
          type: it.type, difficulty: it.difficulty,
          text: it.text, answer: it.answer, solution: it.solution,
          batchName: '举一反三', source: 'generated',
          confidence: 0.9, needsConfirm: false
        });
      }
      await Store.Points.recount();
      S._gen = null;
      UI.close();
      UI.toast('已入库 ' + items.length + ' 道同类题');
      await render();
    },

    /* ---- 题库 ---- */
    'bank:subject': function (d) { S.bank.subject = d.v; render(); },
    'bank:grade': function (d) { S.bank.grade = d.v; render(); },
    'bank:unit': function (d) {
      const u = d.unit || d.v || '';
      S.bank.unit = u;
      if (u) {
        S.bank.subject = S.defaults.subject;
        S.bank.grade = S.defaults.grade;
        S.bank.keyword = ''; S.bank.status = '全部'; S.bank.type = '全部'; S.bank.difficulty = '';
        navigate('bank');
      } else {
        render();
      }
    },
    'unit:paper': function (d) {
      const qs = (S.cache.bankQ || []).filter(q => (q.unit || '未归类') === d.unit);
      if (!qs.length) { UI.toast('这个章节还没有题目'); return; }
      Paper.setIds(qs.map(q => q.id));
      S.paperTitle = d.unit + ' 单元练习';
      UI.toast('已选 ' + qs.length + ' 道题进组卷篮');
      navigate('paper');
    },
    'bank:status': function (d) { S.bank.status = d.v; render(); },
    'bank:clear': function () { S.bank.keyword = ''; S.bank.unit = ''; render(); },
    'bank:confirmList': function () {
      if (S.page !== 'bank') { S.bank.status = 'confirm'; navigate('bank'); return; }
      S.bank.status = S.bank.status === 'confirm' ? '全部' : 'confirm'; render();
    },
    'bank:filter': async function () {
      const b = S.bank;
      const types = ['全部'].concat(CONFIG.questionTypes);
      const body = '<div class="field"><label>题型</label><div class="chips">' +
        types.map(function (t) {
          return '<button class="tag' + (b.type === t ? ' active' : '') + '" data-act="bank:setType" data-v="' + t + '">' + t + '</button>';
        }).join('') + '</div></div>' +
        '<div class="field"><label>难度</label><div class="chips">' +
        ['', '1', '2', '3'].map(function (n) {
          return '<button class="tag' + (String(b.difficulty) === n ? ' active' : '') + '" data-act="bank:setDiff" data-v="' + n + '">' + (n ? '难度 ' + n : '不限') + '</button>';
        }).join('') + '</div></div>' +
        '<button class="btn ghost block" data-act="bank:resetFilter">重置筛选</button>';
      UI.sheet({ title: '筛选', body: body });
    },
    'bank:setType': function (d) { S.bank.type = d.v; UI.close(); render(); },
    'bank:setDiff': function (d) { S.bank.difficulty = d.v; UI.close(); render(); },
    'bank:resetFilter': function () { S.bank.type = '全部'; S.bank.difficulty = ''; UI.close(); render(); },

    /* ---- 题目 ---- */
    'q:toggle': async function (d) {
      const id = d.id;
      S.open[id] = !S.open[id];
      if (S.open[id]) {
        const q = await DB.get('questions', id);
        if (q && q.assetId && !S.imgUrls[id]) {
          S.imgUrls[id] = await Store.Assets.url(q.assetId);
        }
        // 拉取同考点历史题（同类题关联）
        if (q && !S.cache.same[id]) {
          const all = await Store.Questions.list({ subject: q.subject, grade: q.grade });
          S.cache.same[id] = all
            .filter(x => x.pointId && x.pointId === q.pointId && x.id !== q.id)
            .slice(0, 8)
            .map(x => ({ id: x.id, text: x.text, date: x.createdAt, batch: x.batchName, batchDate: x.batchDate }));
        }
      }
      await render();
    },
    'q:same': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      UI.sheet({
        title: Paper.dateStr(q.createdAt) + (q.batchName ? ' · ' + q.batchName : ''),
        body: '<p class="qtext" style="padding:0 0 10px">' + esc(q.text) + optionsHtml(q) + '</p>' +
          '<div class="solution-box" style="margin:0 0 12px"><b>解题思路</b>' + esc(q.solution || '（暂无）') +
          (q.answer ? '<div class="answer-line"><b>答案：</b>' + esc(q.answer) + '</div>' : '') + '</div>' +
          '<div class="row" style="gap:8px">' +
            '<button class="btn ghost grow" data-act="sheet:close">关闭</button>' +
            '<button class="btn soft grow" data-act="q:samePoint" data-id="' + q.pointId + '">查看考点</button>' +
          '</div>'
      });
    },
    'q:samePoint': function (d) {
      UI.close();
      navigate('point', { id: d.id });
    },
    'q:basket': function (d) {
      const inBasket = Paper.toggle(d.id);
      UI.toast(inBasket ? '已加入组卷篮（' + Paper.count() + '）' : '已移出组卷篮');
      render();
    },
    'q:gen': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      await openGenSheet(q);
    },
    'q:master': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      if (q.status === 'mastered') {
        await Store.Questions.update(d.id, { status: 'todo', box: 0, nextReviewAt: Date.now() });
      } else {
        const iv = CONFIG.reviewIntervals;
        const box = Math.min((q.box || 0) + 1, iv.length);
        await Store.Questions.update(d.id, {
          status: 'mastered', box: box,
          lastReviewedAt: Date.now(),
          nextReviewAt: Date.now() + iv[Math.max(0, box - 1)] * 86400e3
        });
      }
      await render();
    },
    'q:point': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      const picked = await pickPoint(q.pointName, q.subject, q.grade);
      if (!picked) return;
      const res = await Normalize.resolve(picked.name, { subject: q.subject, grade: q.grade });
      await Store.Questions.update(d.id, {
        pointId: res.point.id, pointName: res.point.name, needsConfirm: false
      });
      await Store.Points.recount();
      UI.toast('已改为「' + res.point.name + '」');
      await render();
    },
    'q:del': async function (d) {
      const ok = await UI.confirm('删除这道题？原图也会一起删除。');
      if (!ok) return;
      await Store.Questions.remove(d.id);
      delete S.imgUrls[d.id];
      UI.toast('已删除');
      await render();
    },
    'q:openPoint': function (d) { navigate('point', { id: d.id }); },

    /* ---- 考点 ---- */
    'point:review': function (d) {
      S.params = {};
      navigate('review', { pointId: d.id, auto: true });
    },
    'point:mastery': async function (d) {
      const p = S.cache.point;
      if (!p) return;
      await Store.Mastery.set(p.id, d.v);
      const m = Store.Mastery.LEVELS.find(x => x[0] === d.v);
      UI.toast('已标记：' + (m ? m[1] : d.v));
      await render();
    },
    'point:masternote': async function () {
      const p = S.cache.point;
      if (!p) return;
      const v = await UI.prompt({
        title: '掌握情况备注', rows: 3,
        value: (p.mastery && p.mastery.note) || '',
        placeholder: '如：一半学生忘记 ÷2，需再练变式'
      });
      if (v == null) return;
      await Store.Mastery.set(p.id, Store.Mastery.levelOf(p) || 'part', v);
      await render();
    },
    'point:rename': async function (d) {
      const p = S.cache.point;
      if (!p) return;
      const v = await UI.prompt({ title: '重命名考点', value: p.name, rows: 2 });
      if (!v || !v.trim()) return;
      const res = await Normalize.resolve(v.trim(), { subject: p.subject, grade: p.grade });
      if (res.point.id !== p.id) {
        await Store.Points.merge(p.id, res.point.id);
        UI.toast('已并入「' + res.point.name + '」');
        await navigate('point', { id: res.point.id });
        return;
      }
      await DB.put('points', Object.assign(p, { name: v.trim(), norm: Normalize.norm(v) }));
      UI.toast('已重命名');
      await render();
    },
    'point:more': async function () {
      const p = S.cache.point;
      const body = '<button class="btn ghost block" data-act="point:merge">合并到其他考点</button>' +
        '<button class="btn ghost block mt8" data-act="point:rename">重命名</button>' +
        '<button class="btn danger-soft block mt8" data-act="point:delete">删除考点及题目</button>' +
        ((p.aliases || []).length ? '<p class="muted mt12">别名：' + esc(p.aliases.join('、')) + '</p>' : '');
      UI.sheet({ title: '考点管理', body: body });
    },
    'point:merge': async function () {
      const p = S.cache.point;
      UI.close();
      const picked = await pickPoint('', p.subject, p.grade);
      if (!picked || picked.id === p.id) return;
      if (!picked.id) { UI.toast('请选择一个已存在的考点'); return; }
      await Store.Points.merge(p.id, picked.id);
      UI.toast('已合并');
      await navigate('point', { id: picked.id });
    },
    'point:delete': async function () {
      const p = S.cache.point;
      UI.close();
      const ok = await UI.confirm('删除考点「' + p.name + '」及其下的 ' + (S.cache.pointList || []).length + ' 道题？');
      if (!ok) return;
      for (const q of (S.cache.pointList || [])) await Store.Questions.remove(q.id);
      await DB.del('points', p.id);
      UI.toast('已删除');
      await navigate('bank');
    },

    /* ---- 复习 ---- */
    'review:subject': function (d) { S.reviewCfg.subject = d.v; saveDefaults(); render(); },
    'review:scope': function (d) { S.reviewCfg.scope = d.v; saveDefaults(); render(); },
    'review:limit': function (d) { S.reviewCfg.limit = +d.v; saveDefaults(); render(); },
    'review:start': function () { startReview(); },
    'review:again': function () { startReview(); },
    'review:reveal': function () { S.review.revealed = true; render(); },
    'review:mark': async function (d) {
      const r = S.review;
      const q = r.queue[r.idx];
      const iv = CONFIG.reviewIntervals;
      if (d.v === 'ok') {
        const box = Math.min((q.box || 0) + 1, iv.length);
        await Store.Questions.update(q.id, {
          status: 'mastered', box: box, reviewCount: (q.reviewCount || 0) + 1,
          lastReviewedAt: Date.now(), nextReviewAt: Date.now() + iv[Math.max(0, box - 1)] * 86400e3
        });
        r.ok++;
      } else {
        await Store.Questions.update(q.id, {
          status: 'todo', box: 0, wrongCount: (q.wrongCount || 0) + 1,
          reviewCount: (q.reviewCount || 0) + 1,
          lastReviewedAt: Date.now(), nextReviewAt: Date.now() + 86400e3
        });
        r.again++;
      }
      nextReview();
    },
    'review:next': function () {
      if (S.review) { S.review.skipped = (S.review.skipped || 0) + 1; }
      nextReview();
    },
    'review:gen': async function () {
      if (!S.review) return;
      const q = S.review.queue[S.review.idx];
      await openGenSheet(q);
    },
    'review:quit': function () {
      S.review = null;
      render();
    },

    /* ---- 设置 ---- */
    'settings:save': async function () {
      const provider = document.querySelector('[data-change="settings:provider"]').value;
      const proxy = document.getElementById('cfgProxy');
      CONFIG.ocr.provider = provider;
      if (proxy) CONFIG.ocr.proxyUrl = proxy.value.trim();
      CONFIG.llm.enabled = document.getElementById('cfgLlmEnabled').checked;
      CONFIG.llm.baseUrl = document.getElementById('cfgBaseUrl').value.trim() || CONFIG.llm.baseUrl;
      CONFIG.llm.model = document.getElementById('cfgModel').value.trim() || CONFIG.llm.model;
      CONFIG.llm.apiKey = document.getElementById('cfgApiKey').value.trim();
      S.defaults.subject = document.getElementById('defSubject').value;
      S.defaults.grade = document.getElementById('defGrade').value;
      saveDefaults();
      localStorage.setItem('tiku.config', JSON.stringify({
        ocr: { provider: CONFIG.ocr.provider, proxyUrl: CONFIG.ocr.proxyUrl },
        llm: CONFIG.llm
      }));
      UI.toast('配置已保存');
      await render();
    },
    'settings:test': async function () {
      UI.toast('正在测试…');
      try {
        await AI.testConnect();
        UI.toast('连接成功 ✓');
      } catch (e) {
        UI.toast('连接失败：' + e.message, 3000);
      }
    },

    /* ---- 组卷 ---- */
    'paper:up': async function (d) {
      const ids = Paper.ids(), i = ids.indexOf(d.id);
      if (i > 0) { Paper.setIds(ids.slice(0, i - 1).concat([ids[i], ids[i - 1]], ids.slice(i + 1))); }
      PAGES.paper.load(S.params); render();
    },
    'paper:down': async function (d) {
      const ids = Paper.ids(), i = ids.indexOf(d.id);
      if (i >= 0 && i < ids.length - 1) {
        const next = ids.slice();
        next[i] = next[i + 1]; next[i + 1] = ids[i];
        Paper.setIds(next);
      }
      PAGES.paper.load(S.params); render();
    },
    'paper:del': async function (d) {
      Paper.toggle(d.id);
      PAGES.paper.load(S.params); render();
    },
    'paper:clear': async function () {
      const ok = await UI.confirm('清空试卷篮？');
      if (!ok) return;
      Paper.clear();
      PAGES.paper.load(S.params); render();
    },
    'paper:save': async function () {
      const el = document.getElementById('paperTitle');
      const title = (el && el.value.trim()) || '单元练习';
      S.paperTitle = title;
      await Store.Papers.save({ title: title, questionIds: Paper.ids() });
      UI.toast('试卷已保存');
      PAGES.paper.load(S.params); render();
    },
    'paper:preview': function () {
      const el = document.getElementById('paperTitle');
      S.paperTitle = (el && el.value.trim()) || '单元练习';
      S._pv = null;
      navigate('paperView', {});
    },
    'paper:view': async function (d) {
      S._pv = null;
      navigate('paperView', { id: d.id });
    },
    'paper:delSaved': async function (d) {
      const ok = await UI.confirm('删除这份保存的试卷？');
      if (!ok) return;
      await Store.Papers.remove(d.id);
      PAGES.paper.load(S.params); render();
    },
    'paper:answer': function () {
      if (S._pv) S._pv.ans = !S._pv.ans;
      render();
    },
    'paper:print': function () { window.print(); },

    /* ---- 教材切换 ---- */
    'book:switch': function () {
      const def = S.defaults;
      S._bookTerm = def.term;
      UI.sheet({
        title: '当前教材',
        body: '<div class="row" style="gap:8px">' +
            '<select class="select" id="bookSubject" style="flex:1">' +
              CONFIG.subjects.map(x => '<option' + (def.subject === x ? ' selected' : '') + '>' + x + '</option>').join('') +
            '</select>' +
            '<select class="select" id="bookGrade" style="flex:1">' +
              CONFIG.grades.map(x => '<option' + (def.grade === x ? ' selected' : '') + '>' + x + '</option>').join('') +
            '</select>' +
          '</div>' +
          '<div class="field mt12"><label>学期</label><div class="chips" style="padding-bottom:0">' +
            ['上册', '下册'].map(t => '<button class="tag' + (S._bookTerm === t ? ' active' : '') + '" data-act="book:term" data-v="' + t + '">' + t + '</button>').join('') +
          '</div></div>' +
          '<div class="field"><label>教材版本</label>' +
            '<select class="select" id="bookVersion">' +
              Catalog.versions.map(v => '<option' + (def.version === v ? ' selected' : '') + '>' + v + '</option>').join('') +
            '</select></div>' +
          '<p class="muted">目录按此生成；其他版本可用「我的 → 教材目录」自定义编辑。</p>' +
          '<button class="btn primary block" data-act="book:save">确定</button>'
      });
    },
    'book:term': function (d) {
      S._bookTerm = d.v;
      ACTIONS['book:switch']();
    },
    'book:save': function () {
      S.defaults.subject = document.getElementById('bookSubject').value;
      S.defaults.grade = document.getElementById('bookGrade').value;
      S.defaults.term = S._bookTerm || '上册';
      S.defaults.version = document.getElementById('bookVersion').value;
      saveDefaults();
      UI.close();
      UI.toast('已切换教材');
      render();
    },

    /* ---- 教材目录编辑 ---- */
    'settings:catsave': function () {
      const cv = S._catVersion || S.defaults.version;
      const t = document.getElementById('catText');
      Catalog.setCustom(S.defaults.subject, S.defaults.grade, S.defaults.term, cv, Catalog.fromText(t ? t.value : ''));
      S._catVersion = null;
      UI.toast('目录已保存');
      render();
    },
    'settings:catreset': function () {
      const cv = S._catVersion || S.defaults.version;
      Catalog.setCustom(S.defaults.subject, S.defaults.grade, S.defaults.term, cv, []);
      S._catVersion = null;
      UI.toast('已恢复默认目录');
      render();
    },

    /* ---- 数据 ---- */
    'data:seed': async function () { await seedDemo(); },
    'data:export': async function () {
      const data = await Store.exportAll();
      Util.download('tiku-backup-' + Util.fmtDate(Date.now()) + '.json', JSON.stringify(data, null, 2));
      UI.toast('已导出');
    },
    'data:syncUp': async function () {
      try {
        const data = await Store.exportAll();
        const r = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error);
        UI.toast('已备份到电脑（' + j.questions + ' 题）');
      } catch (e) {
        throw new Error(e.message.indexOf('fetch') >= 0
          ? '连不上电脑服务：请确认与电脑同一 Wi-Fi 且电脑上的服务在运行'
          : e.message);
      }
    },
    'data:syncDown': async function () {
      let meta;
      try {
        meta = await (await fetch('/api/sync')).json();
      } catch (e) {
        throw new Error('连不上电脑服务：请确认与电脑同一 Wi-Fi 且电脑上的服务在运行');
      }
      if (meta.error) throw new Error(meta.error);
      if (!meta.exists) { UI.toast('电脑上还没有备份，先在任一设备点「备份本机数据到电脑」'); return; }
      const when = String(meta.savedAt || '').replace('T', ' ').slice(0, 16);
      const ok = await UI.confirm('电脑上的备份保存于 ' + when + '，共 ' + meta.questions +
        ' 题。合并到本机？\\n（相同题目以电脑版本为准，本机新增的题目保留）');
      if (!ok) return;
      const data = await (await fetch('/api/sync?full=1')).json();
      const res = await Store.importAll(data);
      UI.toast('已合并 ' + res.questions + ' 题');
      await render();
    },
    'data:import': function () {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async function () {
        const f = input.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          const res = await Store.importAll(JSON.parse(text));
          UI.toast('导入 ' + res.questions + ' 题');
          await render();
        } catch (e) {
          UI.toast('导入失败：' + e.message, 2600);
        }
      };
      input.click();
    },
    'data:clear': async function () {
      const ok = await UI.confirm('清空所有题目和考点？此操作不可恢复，建议先导出备份。');
      if (!ok) return;
      await DB.clear('questions');
      await DB.clear('points');
      await DB.clear('assets');
      localStorage.setItem('tiku.cleared', '1');
      UI.toast('已清空');
      await navigate('home');
    }
  };

  /* 复习推进 */
  async function prepareReview(pointId) {
    const cfg = S.reviewCfg;
    const status = cfg.scope === 'all' ? '全部' : 'todo';
    let qs = await Store.Questions.draw({
      subject: cfg.subject, status: status, limit: cfg.limit, pointId: pointId || ''
    });
    if (cfg.scope === 'wrong') qs = qs.filter(q => (q.wrongCount || 0) > 0 || q.status !== 'mastered');
    // 薄弱考点：老师标过「部分掌握 / 未掌握」的考点优先
    if (cfg.scope === 'weak') {
      const weakIds = (await DB.all('points'))
        .filter(p => p.mastery && p.mastery.level && p.mastery.level !== 'good')
        .map(p => p.id);
      qs = qs.filter(q => weakIds.indexOf(q.pointId) >= 0);
    }
    if (!qs.length) { UI.toast('这个范围里还没有题目'); return false; }
    S.review = { queue: qs, idx: 0, revealed: false, ok: 0, again: 0, done: false, started: true };
    return true;
  }

  async function startReview(pointId) {
    const ok = await prepareReview(pointId);
    if (ok) await render();
  }

  function nextReview() {
    const r = S.review;
    r.idx++;
    r.revealed = false;
    if (r.idx >= r.queue.length) r.done = true;
    render();
  }

  /* =========================================================
   * 事件绑定
   * ======================================================= */
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const fn = ACTIONS[act];
    if (!fn) return;
    e.preventDefault();
    try {
      const r = fn(el.dataset, el, e);
      if (r && r.catch) r.catch(function (err) { console.error(err); UI.toast(err.message || '操作失败', 2400); });
    } catch (err) {
      console.error(err);
      UI.toast(err.message || '操作失败');
    }
  });

  document.addEventListener('change', function (e) {
    const el = e.target.closest('[data-change]');
    if (!el) return;
    const key = el.dataset.change;
    if (key === 'confirm:subject') {
      S.session.subject = el.value;
      S.drafts.forEach(function (d) { d.point = ''; d.pointId = ''; d.needsConfirm = true; d.aiPending = true; });
      render().then(classifyDrafts);
    } else if (key === 'confirm:grade') {
      S.session.grade = el.value;
      S.drafts.forEach(function (d) { d.point = ''; d.pointId = ''; d.needsConfirm = true; d.aiPending = true; });
      render().then(classifyDrafts);
    } else if (key === 'settings:provider') {
      CONFIG.ocr.provider = el.value;
      render();
    } else if (key === 'settings:catVersion') {
      S._catVersion = el.value;
      render();
    } else if (key === 'settings:llm') {
      CONFIG.llm.enabled = el.checked;
    }
  });

  /* 隐藏文件输入 */
  document.getElementById('fileCamera').addEventListener('change', async function (e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await addFiles(files);
  });
  document.getElementById('fileAlbum').addEventListener('change', async function (e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await addFiles(files);
  });
  document.getElementById('fileDoc').addEventListener('change', async function (e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const file = files[0];
    UI.toast('正在解析 ' + file.name + ' …', 4000);
    try {
      const res = DocParse.extractDoc
        ? await DocParse.extractDoc(file)
        : { text: await DocParse.extract(file), images: [] };
      const text = OCR.tidy ? OCR.tidy(res.text) : res.text;
      if (!text.trim()) {
        throw new Error('没有解析出文字。扫描版 PDF（图片型）无法提取文字，请回到首页用拍照录入');
      }
      const s = ensureSession();
      s.images.forEach(im => URL.revokeObjectURL(im.url));
      s.images = [{ id: Util.uid('im'), blob: null, url: '', status: 'done', text: text, pct: 1, docImages: res.images || [] }];
      if (!s.batchName) s.batchName = file.name.replace(/\.[a-z0-9]+$/i, '');
      buildDrafts();
      s.stage = 'confirm';
      await navigate('confirm');
      await classifyDrafts();
    } catch (err) {
      UI.toast(err.message || '解析失败', 3200);
    }
  });

  /* 离开页面时尽量不要丢 OCR worker */
  window.addEventListener('beforeunload', function () { OCR.destroy(); });

  /* 调试钩子（控制台可用：__tiku.S、__tiku.navigate(...) 等） */
  window.__tiku = { S: S, navigate: navigate, UI: UI, ACTIONS: ACTIONS,
    ensureSession: ensureSession, buildDrafts: buildDrafts, classifyDrafts: classifyDrafts,
    seedDemo: seedDemo, Store: Store };

  /* =========================================================
   * 启动
   * ======================================================= */
  (async function boot() {
    try {
      await DB.open();
      await Store.Points.recount();
      // 不再自动生成示例题；需要例子时在首页点「载入示例（苏教版五上新教材练习）」
    } catch (e) {
      console.error(e);
    }
    // 支持 #bank / #review 等 hash 直达
    const initial = (location.hash || '').replace(/^#\/?/, '');
    await navigate(PAGES[initial] ? initial : 'home', {}, true);
  })();
})();
