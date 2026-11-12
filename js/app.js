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
    open: {},             // questionId -> 思路/原图是否展开
    openImg: {},          // questionId -> 配图区是否展开（undefined 时有配图的题默认展开）
    cache: { same: {} },  // same: questionId -> 同考点历史题缓存
    dcalc: { showAns: false, t0: null, acc: 0, tick: null, base: '00:00' },  // 每日计算 UI 状态
    dcalcPick: '',        // 每日计算设置里临时选的年级
    dcalcDirty: false,
    bank: { subject: '全部', grade: '全部', keyword: '', status: '全部', type: '全部', difficulty: '', unit: '', point: '', lesson: '', practice: '', ptype: '', page: '', multiUnit: [], multiPoint: [] },
    imgSel: {},          // 配图弹层里已勾选的图下标
    _bf: null,           // 筛选弹层的草稿状态
    _lassMode: 'q',      // 改课时弹层：q=按题目、point=按考点
    _lassSel: {},        // 改课时弹层里已勾选的题目 id
    batch: { on: false, set: {} },   // 题库批量选择模式：set 为题目 id 集合
    jpSel: { on: false, set: {} },   // 讲评页批量选择（标为已讲评）
    jpLast: null,                    // 上一次「标为已讲评」的一批（供撤回）
    jpTags: false,                   // 讲评页是否显示题卡标签（默认不显示，观课时页面更干净）
    reviewCfg: { subject: '全部', scope: 'due', limit: 10 },
    review: null
  };

  (function loadDefaults() {
    try {
      const d = JSON.parse(localStorage.getItem('tiku.defaults') || 'null');
      if (d && d.subject) S.defaults = Object.assign(S.defaults, d);
      const r = JSON.parse(localStorage.getItem('tiku.reviewCfg') || 'null');
      if (r) S.reviewCfg = Object.assign(S.reviewCfg, r);
      S.jpTags = localStorage.getItem('tiku.jp.tags') === '1';
    } catch (e) {}
  })();

  function saveDefaults() {
    localStorage.setItem('tiku.defaults', JSON.stringify(S.defaults));
    localStorage.setItem('tiku.reviewCfg', JSON.stringify(S.reviewCfg));
  }

  /* =========================================================
   * 导入草稿（确认页未入库时的自动保存 / 恢复）
   * ======================================================= */
  const DRAFT_KEY = 'tiku.draft';

  function readDraftStore() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function clearDraftStore() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
  }

  function storeDraft() {
    if (!S.session || !S.drafts.length) return;
    const s = S.session;
    const plain = S.drafts.map(function (d) {
      return {
        no: d.no, text: d.text, subs: d.subs || [], options: d.options || [],
        answer: d.answer || '', solution: d.solution || '',
        type: d.type, difficulty: d.difficulty,
        images: d.images || [], point: d.point || '', pointId: d.pointId || '',
        pointUnit: d.pointUnit || '', points: d.points || [],
        lesson: d.lesson || '',
        confidence: d.confidence || 0, needsConfirm: !!d.needsConfirm
      };
    });
    const data = {
      subject: s.subject, grade: s.grade, unit: s.unit || '',
      batchName: s.batchName || '', batchDate: s.batchDate || '',
      practiceType: s.practiceType || '', pageNo: s.pageNo || '',
      pool: (s.imgPool || []).slice(),
      savedAt: Date.now(), drafts: plain
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } catch (e) {
      // 图形太多存不下：先只去掉图形池再存一次
      try {
        data.pool = [];
        localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
      } catch (e2) {
        // 还不行：题目配图也去掉（文字和考点不丢）
        try {
          data.drafts.forEach(function (d) { d.images = []; });
          localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
          if (!S._draftImgWarn) {
            S._draftImgWarn = true;
            UI.toast('草稿过大，配图未存入草稿', 2600);
          }
        } catch (e3) { /* 存不下就算了 */ }
      }
    }
  }

  /** 离开确认页前询问：保存草稿 / 不保存 / 取消 */
  function askDraftChoice() {
    return new Promise(function (resolve) {
      UI._resolve = resolve;
      UI.sheet({
        title: '还没入库',
        body: '<p style="font-size:14px;line-height:1.7;color:var(--ink-2);margin-bottom:14px">' +
          '当前编辑的 ' + S.drafts.length + ' 道题还没入库，要保存成草稿吗？保存后可在首页恢复继续入库。</p>' +
          '<button class="btn primary block" data-act="draft:keep">保存草稿并返回</button>' +
          '<button class="btn ghost block mt8" data-act="draft:drop">不保存，直接返回</button>' +
          '<button class="btn soft block mt8" data-act="draft:stay">取消，继续编辑</button>'
      });
    });
  }

  /* =========================================================
   * 每日计算（首页）：按学期设置的年级 + 教材进度（周次）+ 工作日自动刷新 5 道计算题
   * ======================================================= */
  const DCALC_KEY = 'tiku.dcalcCfg';

  function readDcalcCfg() {
    try { return JSON.parse(localStorage.getItem(DCALC_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveDcalcCfg(cfg) {
    try { localStorage.setItem(DCALC_KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  /** 学期标识：8 月起算秋季学期，2–7 月算春季学期 */
  function semKeyOf(dt) {
    const y = dt.getFullYear();
    return dt.getMonth() >= 7 ? y + '秋' : y + '春';
  }
  function defaultStartOf(semKey) {
    const m = String(semKey || '').match(/^(\d{4})(秋|春)$/);
    if (!m) return '';
    return m[2] === '秋' ? m[1] + '-09-01' : m[1] + '-02-16';
  }
  function dcDateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** 周末自动回退到周五：每个工作日刷新一组，双休日沿用周五的 */
  function dcalcWorkday(now) {
    const d = new Date(now);
    const wd = d.getDay();
    if (wd === 0) d.setDate(d.getDate() - 2);
    else if (wd === 6) d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  /** 按学期周次推算当前教学单元（教材日历） */
  function dcalcUnit(cfg, day) {
    const startStr = cfg.startDate || defaultStartOf(cfg.semKey) || defaultStartOf(semKeyOf(new Date()));
    const start = startStr ? new Date(startStr + 'T00:00:00') : new Date(day);
    if (isNaN(start)) return { week: 1, unit: '' };
    let week = Math.floor((day - start) / 6048e5) + 1;
    if (!(week >= 1)) week = 1;
    const cat = Catalog.get('数学', cfg.grade, S.defaults.term, S.defaults.version);
    if (week > cat.length) week = cat.length;
    return { week: week, unit: cat[week - 1] || '' };
  }

  /* ---- 种子随机：同一天同年级同单元 → 同一组题（换工作日自动换题） ---- */
  function dcHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function dcRi(rnd, a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
  function dcPick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function dcGcd(a, b) { return b ? dcGcd(b, a % b) : a; }
  function dcFrac(n, d) {
    if (d < 0) { n = -n; d = -d; }
    const g = dcGcd(Math.abs(n), d) || 1;
    n /= g; d /= g;
    return d === 1 ? String(n) : n + '/' + d;
  }
  function dcRound(v) { return Math.round(v * 100) / 100; }
  function dcFmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function dcFmtSec(totalSec) {
    const s = Math.max(0, totalSec | 0);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* ---- 计算题型目录（div=true 的题型出现频次自动加倍，默认除法题更多） ---- */
  const DCALC_KINDS = [
    { k: 'addSub20',  l: '20以内加减法',   div: false },
    { k: 'addSub100', l: '100以内加减法',  div: false },
    { k: 'addSub3',   l: '三位数加减法',   div: false },
    { k: 'tableMul',  l: '表内乘法',       div: false },
    { k: 'tableDiv',  l: '表内除法',       div: true },
    { k: 'mul1',      l: '多位数乘一位数', div: false },
    { k: 'div1',      l: '除数是一位数',   div: true },
    { k: 'mul2',      l: '两位数乘两位数', div: false },
    { k: 'div2',      l: '除数是两位数',   div: true },
    { k: 'decAddSub', l: '小数加减法',     div: false },
    { k: 'decMulInt', l: '小数乘整数',     div: false },
    { k: 'decMulDec', l: '小数乘小数',     div: false },
    { k: 'decDivInt', l: '小数除以整数',   div: true },
    { k: 'fracAddSub', l: '分数加减法',    div: false },
    { k: 'fracMul',   l: '分数乘法',       div: false },
    { k: 'fracDiv',   l: '分数除法',       div: true },
    { k: 'equation',  l: '解方程',         div: false },
    { k: 'jianBian',  l: '简便运算',       div: false },
    { k: 'areaCalc',  l: '面积公式计算',   div: false }
  ];

  /* ---- 计算题生成器（kind → f(rnd, lv)；lv: 1 简单 / 2 中等 / 3 挑战，默认 2） ---- */
  const DCALC_GEN = {
    addSub20: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const a = dcRi(r, 2, 8);
        if (r() < 0.5) { const b = dcRi(r, 1, 10 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
        const b = dcRi(r, 1, a - 1); return { q: a + ' − ' + b + ' =', a: String(a - b) };
      }
      if (lv === 3) {
        const a = dcRi(r, 2, 12), b = dcRi(r, 2, 9);
        if (r() < 0.5) { const c = dcRi(r, 1, 9); return { q: a + ' + ' + b + ' + ' + c + ' =', a: String(a + b + c) }; }
        const t = a + b, c = dcRi(r, 1, t - 1); return { q: a + ' + ' + b + ' − ' + c + ' =', a: String(t - c) };
      }
      const plus = r() < 0.5, a = dcRi(r, 2, 18);
      if (plus) { const b = dcRi(r, 1, 20 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
      const b = dcRi(r, 1, a - 1); return { q: a + ' − ' + b + ' =', a: String(a - b) };
    },
    addSub100: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const plus = r() < 0.5, a = dcRi(r, 11, 45);
        if (plus) { const b = dcRi(r, 3, 50 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
        const b = dcRi(r, 4, a - 3); return { q: a + ' − ' + b + ' =', a: String(a - b) };
      }
      if (lv === 3) {
        const a = dcRi(r, 23, 78), b = dcRi(r, 6, 21), t = a + b;
        const c = dcRi(r, 4, t - 5); return { q: a + ' + ' + b + ' − ' + c + ' =', a: String(t - c) };
      }
      const plus = r() < 0.5, a = dcRi(r, 12, 95);
      if (plus) { const b = dcRi(r, 5, 99 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
      const b = dcRi(r, 6, a - 5); return { q: a + ' − ' + b + ' =', a: String(a - b) };
    },
    addSub3: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const plus = r() < 0.5, a = dcRi(r, 60, 400);
        if (plus) { const b = dcRi(r, 20, 500 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
        const b = dcRi(r, 30, a - 25); return { q: a + ' − ' + b + ' =', a: String(a - b) };
      }
      if (lv === 3) {
        const plus = r() < 0.5, a = dcRi(r, 650, 1850);
        if (plus) { const b = dcRi(r, 60, 1950 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
        const b = dcRi(r, 80, a - 60); return { q: a + ' − ' + b + ' =', a: String(a - b) };
      }
      const plus = r() < 0.5, a = dcRi(r, 150, 950);
      if (plus) { const b = dcRi(r, 15, 999 - a); return { q: a + ' + ' + b + ' =', a: String(a + b) }; }
      const b = dcRi(r, 25, a - 20); return { q: a + ' − ' + b + ' =', a: String(a - b) };
    },
    tableMul: function (r, lv) {
      lv = lv || 2;
      const hi = lv === 1 ? 5 : 9, lo = lv === 3 ? 3 : 2;
      const a = dcRi(r, lo, hi), b = dcRi(r, lv === 3 ? 4 : lo, hi);
      return { q: a + ' × ' + b + ' =', a: String(a * b) };
    },
    tableDiv: function (r, lv) {
      lv = lv || 2;
      const hi = lv === 1 ? 5 : 9, lo = lv === 3 ? 3 : 2;
      const b = dcRi(r, lo, hi), c = dcRi(r, lv === 3 ? 4 : lo, hi);
      return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) };
    },
    mul1: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const a = dcRi(r, 12, 98), b = dcRi(r, 2, 6); return { q: a + ' × ' + b + ' =', a: String(a * b) }; }
      if (lv === 3) { const a = dcRi(r, 1002, 2998), b = dcRi(r, 3, 9); return { q: a + ' × ' + b + ' =', a: String(a * b) }; }
      const a = dcRi(r, 102, 498), b = dcRi(r, 3, 9); return { q: a + ' × ' + b + ' =', a: String(a * b) };
    },
    div1: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const b = dcRi(r, 2, 5), c = dcRi(r, 6, 29); return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) }; }
      if (lv === 3) { const b = dcRi(r, 3, 9), c = dcRi(r, 25, 198); return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) }; }
      const b = dcRi(r, 3, 9), c = dcRi(r, 12, 98); return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) };
    },
    mul2: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const a = dcRi(r, 11, 29), b = dcRi(r, 11, 19); return { q: a + ' × ' + b + ' =', a: String(a * b) }; }
      if (lv === 3) { const a = dcRi(r, 13, 79), b = dcRi(r, 12, 39); return { q: a + ' × ' + b + ' =', a: String(a * b) }; }
      const a = dcRi(r, 12, 49), b = dcRi(r, 11, 29); return { q: a + ' × ' + b + ' =', a: String(a * b) };
    },
    div2: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const b = dcRi(r, 11, 19), c = dcRi(r, 3, 9); return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) }; }
      if (lv === 3) { const b = dcRi(r, 12, 49), c = dcRi(r, 12, 48); return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) }; }
      const b = dcRi(r, 11, 32), c = dcRi(r, 6, 24); return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) };
    },
    decAddSub: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const a = dcRi(r, 12, 45) / 10;
        if (r() < 0.5) { const b = dcRi(r, 12, Math.max(13, 48 - a * 10)) / 10; return { q: a + ' + ' + b + ' =', a: String(dcRound(a + b)) }; }
        const b = dcRi(r, 8, Math.max(9, a * 10 - 4)) / 10; return { q: a + ' − ' + b + ' =', a: String(dcRound(a - b)) };
      }
      if (lv === 3) {
        const a = dcRi(r, 115, 985) / 100;
        if (r() < 0.5) { const b = dcRi(r, 105, Math.max(115, 995 - a * 100)) / 100; return { q: a + ' + ' + b + ' =', a: String(dcRound(a + b)) }; }
        const b = dcRi(r, 60, Math.max(65, a * 100 - 50)) / 100; return { q: a + ' − ' + b + ' =', a: String(dcRound(a - b)) };
      }
      const plus = r() < 0.5, a = dcRi(r, 15, 96) / 10;
      if (plus) { const b = dcRi(r, 12, 90) / 10; return { q: a + ' + ' + b + ' =', a: String(dcRound(a + b)) }; }
      const b = dcRi(r, 8, Math.max(9, a * 10 - 6)) / 10; return { q: a + ' − ' + b + ' =', a: String(dcRound(a - b)) };
    },
    decMulInt: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const a = dcRi(r, 12, 45) / 10, b = dcRi(r, 2, 6); return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)) }; }
      if (lv === 3) { const a = dcRi(r, 105, 985) / 100, b = dcRi(r, 3, 29); return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)) }; }
      const a = dcRi(r, 12, 98) / 10, b = dcRi(r, 3, 24); return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)) };
    },
    decMulDec: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const a = dcRi(r, 12, 45) / 10, b = dcRi(r, 12, 45) / 10; return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)) }; }
      if (lv === 3) { const a = dcRi(r, 105, 985) / 100, b = dcRi(r, 105, 985) / 100; return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)) }; }
      const a = dcRi(r, 12, 98) / 10, b = dcRi(r, 12, 98) / 10; return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)) };
    },
    decDivInt: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const c = dcRi(r, 12, 45) / 10, b = dcRi(r, 2, 5); return { q: (dcRound(c * b)) + ' ÷ ' + b + ' =', a: String(c) }; }
      if (lv === 3) { const c = dcRi(r, 105, 985) / 100, b = dcRi(r, 3, 9); return { q: (dcRound(c * b)) + ' ÷ ' + b + ' =', a: String(c) }; }
      const c = dcRi(r, 12, 98) / 10, b = dcRi(r, 2, 8); return { q: (dcRound(c * b)) + ' ÷ ' + b + ' =', a: String(c) };
    },
    fracAdd: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const d = dcPick(r, [2, 3, 4, 5, 6, 8, 10]);
        const a = dcRi(r, 1, d - 1), b = dcRi(r, 1, d - a);
        return { q: a + '/' + d + ' + ' + b + '/' + d + ' =', a: dcFrac(a + b, d) };
      }
      const pool = lv === 3 ? [4, 6, 8, 9, 10, 12, 15] : [2, 3, 4, 5, 6, 8, 10, 12];
      const d1 = dcPick(r, pool), d2 = dcPick(r, pool);
      const L = (d1 * d2) / dcGcd(d1, d2);
      const a = dcRi(r, 1, d1 - 1), b = dcRi(r, 1, d2 - 1);
      const n = a * (L / d1) + b * (L / d2);
      return { q: a + '/' + d1 + ' + ' + b + '/' + d2 + ' =', a: dcFrac(n, L) };
    },
    fracSub: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const d = dcPick(r, [2, 3, 4, 5, 6, 8, 10]);
        const a = dcRi(r, 2, d - 1), b = dcRi(r, 1, a - 1);
        return { q: a + '/' + d + ' − ' + b + '/' + d + ' =', a: dcFrac(a - b, d) };
      }
      const pool = lv === 3 ? [4, 6, 8, 9, 10, 12, 15] : [2, 3, 4, 5, 6, 8, 10];
      const d1 = dcPick(r, pool), d2 = dcPick(r, pool);
      const L = (d1 * d2) / dcGcd(d1, d2);
      let a = dcRi(r, 1, d1 - 1), b = dcRi(r, 1, d2 - 1);
      if (a * (L / d1) < b * (L / d2)) { const t = a; a = b; b = t; const td = d1; d1 = d2; d2 = td; }
      if (a * (L / d1) < b * (L / d2)) return DCALC_GEN.fracAdd(r, lv);
      return { q: a + '/' + d1 + ' − ' + b + '/' + d2 + ' =', a: dcFrac(a * (L / d1) - b * (L / d2), L) };
    },
    fracMul: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const a = dcRi(r, 1, 9), b = dcRi(r, 2, 12), c = dcRi(r, 2, 5); return { q: a + '/' + b + ' × ' + c + ' =', a: dcFrac(a * c, b) }; }
      const hi = lv === 3 ? 14 : 12;
      const a = dcRi(r, lv === 3 ? 2 : 1, lv === 3 ? 11 : 9), b = dcRi(r, 2, hi), c = dcRi(r, lv === 3 ? 2 : 1, lv === 3 ? 11 : 9), d = dcRi(r, 2, hi);
      return { q: a + '/' + b + ' × ' + c + '/' + d + ' =', a: dcFrac(a * c, b * d) };
    },
    fracDiv: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) { const a = dcRi(r, 1, 9), b = dcRi(r, 2, 12), c = dcRi(r, 2, 5); return { q: a + '/' + b + ' ÷ ' + c + ' =', a: dcFrac(a, b * c) }; }
      const hi = lv === 3 ? 14 : 12;
      const a = dcRi(r, lv === 3 ? 2 : 1, lv === 3 ? 11 : 9), b = dcRi(r, 2, hi), c = dcRi(r, lv === 3 ? 2 : 1, lv === 3 ? 11 : 9), d = dcRi(r, 2, hi);
      return { q: a + '/' + b + ' ÷ ' + c + '/' + d + ' =', a: dcFrac(a * d, b * c) };
    },
    equation: function (r, lv) {
      lv = lv || 2;
      if (lv === 1) {
        const x = dcRi(r, 2, 20), a = dcRi(r, 1, 9);
        if (r() < 0.5) return { q: '解方程：x + ' + a + ' = ' + (x + a) + '，x =', a: String(x) };
        const b = x - a >= 1 ? x - a : x + a;
        return { q: x - a >= 1 ? ('解方程：x − ' + a + ' = ' + b + '，x =') : ('解方程：x + ' + a + ' = ' + b + '，x ='), a: String(x) };
      }
      if (lv === 3) {
        const a = dcRi(r, 3, 9), bb = dcRi(r, 2, a - 1), x = dcRi(r, 2, 12);
        const c = (a - bb) * x;
        return { q: '解方程：' + a + 'x − ' + bb + 'x = ' + c + '，x =', a: String(x) };
      }
      const x = dcRi(r, 2, 12), a = dcRi(r, 2, 9), b = dcRi(r, 1, 20);
      const plus = r() < 0.5, y = plus ? a * x + b : a * x - b;
      return { q: '解方程：' + a + 'x ' + (plus ? '+' : '−') + ' ' + b + ' = ' + y + '，x =', a: String(x) };
    },
    jianBian: function (r, lv) {
      lv = lv || 2;
      if (lv === 1 || (lv === 2 && r() < 0.5)) { const a = dcRi(r, 3, 30); return { q: '25 × ' + a + ' × 4 =', a: String(100 * a) }; }
      const b = dcRi(r, 12, 60), a = dcRi(r, 3, 19), c = dcRi(r, 2, 20);
      if (lv === 3 && r() < 0.5) { const mx = Math.max(a, c), mn = Math.min(a, c); return { q: b + ' × ' + mx + ' − ' + b + ' × ' + mn + ' =', a: String(b * (mx - mn)) }; }
      return { q: b + ' × ' + a + ' + ' + b + ' × ' + c + ' =', a: String(b * (a + c)) };
    },
    areaCalc: function (r, lv) {
      lv = lv || 2;
      const lu = dcPick(r, ['厘米', '分米', '米']);
      if (lv === 1) {
        if (r() < 0.5) { const w = dcRi(r, 3, 12), h = dcRi(r, 2, 9); return { q: '长方形长 ' + w + lu + '、宽 ' + h + lu + '，面积 =（　）平方' + lu, a: String(w * h) }; }
        const a = dcRi(r, 3, 12); return { q: '正方形边长 ' + a + lu + '，面积 =（　）平方' + lu, a: String(a * a) };
      }
      if (lv === 3) {
        const kind = dcPick(r, ['p', 't', 'tr']);
        if (kind === 'p') { const a = dcRi(r, 12, 48) / 10, h = dcRi(r, 12, 35) / 10; return { q: '平行四边形底 ' + a + lu + '、高 ' + h + lu + '，面积 =（　）平方' + lu, a: String(dcRound(a * h)) }; }
        if (kind === 't') { const a = dcRi(r, 12, 40) / 10, h = dcRi(r, 12, 30) / 10; return { q: '三角形底 ' + a + lu + '、高 ' + h + lu + '，面积 =（　）平方' + lu, a: String(dcRound(a * h / 2)) }; }
        const a = dcRi(r, 8, 30) / 10, b = dcRi(r, 12, 40) / 10, h = dcRi(r, 8, 24) / 10;
        return { q: '梯形上底 ' + a + lu + '、下底 ' + b + lu + '、高 ' + h + lu + '，面积 =（　）平方' + lu, a: String(dcRound((a + b) * h / 2)) };
      }
      const kind = dcPick(r, ['p', 't', 'c']);
      if (kind === 'p') { const a = dcRi(r, 6, 24), h = dcRi(r, 3, 15); return { q: '平行四边形底 ' + a + lu + '、高 ' + h + lu + '，面积 =（　）平方' + lu, a: String(a * h) }; }
      if (kind === 't') { let a, h; do { a = dcRi(r, 3, 20); h = dcRi(r, 3, 20); } while ((a * h) % 2); return { q: '三角形底 ' + a + lu + '、高 ' + h + lu + '，面积 =（　）平方' + lu, a: String(a * h / 2) }; }
      const w = dcRi(r, 4, 18), h = dcRi(r, 3, 15); return { q: '长方形长 ' + w + lu + '、宽 ' + h + lu + '，面积 =（　）平方' + lu, a: String(w * h) };
    }
  };
  DCALC_GEN.fracAddSub = function (r, lv) { return r() < 0.5 ? DCALC_GEN.fracAdd(r, lv) : DCALC_GEN.fracSub(r, lv); };

  /* ---- 难度档位 ---- */
  const DCALC_DIFFS = [{ v: 1, l: '简单' }, { v: 2, l: '中等' }, { v: 3, l: '挑战' }];
  function dcDiffLabel(v) { return (DCALC_DIFFS.find(function (x) { return x.v === (v || 2); }) || DCALC_DIFFS[1]).l; }

  /* ---- 自定义题型备注 → 自动出题规则（如「商中间有0的除法」） ---- */
  /** 按备注文本生成一道匹配题；暂无规则的备注返回 null */
  function dcNoteGen(text, rnd) {
    const t = String(text || '');
    // 生成一道的工厂：三位商 ÷ 一位除数，商满足 pred
    const gen = function (pred) {
      for (let k = 0; k < 40; k++) {
        const b = dcRi(rnd, 2, 9), c = dcRi(rnd, 100, 998), s = String(c);
        if (!pred(s)) continue;
        return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) };
      }
      return null;
    };
    if (/商?.{0,3}中(间|间有).{0,3}0|中间有0/.test(t)) {
      return gen(function (s) { return s.length === 3 && s[1] === '0'; });
    }
    if (/末尾.{0,3}0|最后.{0,3}0/.test(t)) {
      return gen(function (s) { return s.length === 3 && s[2] === '0' && s[1] !== '0'; });
    }
    if (/0/.test(t) && /除|÷/.test(t)) {
      return gen(function (s) { return s.indexOf('0') >= 0 && s[0] !== '0'; });
    }
    if (/除|÷/.test(t)) {
      const b = dcRi(rnd, 2, 9), c = dcRi(rnd, 12, 98);
      return { q: (b * c) + ' ÷ ' + b + ' =', a: String(c) };
    }
    return null;
  }
  /** 汇总某天所有备注题（每条备注 n 道/天），返回 { qs, skipped } */
  function dcNoteQs(notes, rnd, per) {
    const qs = []; const skipped = [];
    (notes || []).forEach(function (nt) {
      if (!nt || !nt.t) return;
      const n = Math.max(1, Math.min(5, nt.n || 1));
      let made = 0;
      for (let i = 0; i < n * 6 && made < n; i++) {
        const g = dcNoteGen(nt.t, rnd);
        if (g && !qs.some(function (x) { return x.q === g.q; })) { qs.push(g); made++; }
      }
      if (made < n) skipped.push(nt.t);
    });
    return { qs: qs.slice(0, Math.max(0, per - 1)), skipped: skipped };
  }

  /** 各年级默认题型（除法占比更高） */
  function dcDefaultKinds(grade) {
    const g = grade || '';
    if (/一/.test(g)) return ['addSub20'];
    if (/二/.test(g)) return ['addSub100', 'tableMul', 'tableDiv', 'div1'];
    if (/三/.test(g)) return ['addSub3', 'mul1', 'div1', 'tableDiv', 'div2'];
    if (/四/.test(g)) return ['mul2', 'div2', 'mul1', 'div1', 'addSub3'];
    if (/五/.test(g)) return ['decDivInt', 'decDivInt', 'decMulInt', 'decAddSub', 'div2'];
    return ['fracDiv', 'fracDiv', 'fracAddSub', 'decDivInt', 'jianBian'];
  }

  /** 按选中题型生成加权题池：除法类出现 2 次 → 默认除法题数更多 */
  function dcWeightedPool(kinds, grade) {
    const valid = (kinds || []).filter(function (k) { return !!DCALC_GEN[k]; });
    const base = valid.length ? valid : dcDefaultKinds(grade);
    return base.concat(base.filter(function (k) {
      const def = DCALC_KINDS.find(function (x) { return x.k === k; });
      return def && def.div;
    }));
  }

  /** 从题库题目中提取「学生常错的计算」（wrongCount>0 且题干首行是纯式题），最多 12 条 */
  function dcExtractWeak(questions) {
    const out = []; const seen = {};
    (questions || []).forEach(function (q) {
      if (!q || !(q.wrongCount > 0)) return;
      const t = String(q.text || q.rawText || '').split('\n')[0] || '';
      if (t.indexOf('/') >= 0) return; // 分数题不参与（避免 1/2 误判成除法）
      const m = t.match(/^\s*(\d+(?:\.\d+)?)\s*([+\-−×xX*÷])\s*(\d+(?:\.\d+)?)\s*[=＝]?/);
      if (!m) return;
      const op = ({ 'x': '×', 'X': '×', '*': '×', '−': '−' })[m[2]] || m[2];
      const key = m[1] + op + m[3];
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ a: parseFloat(m[1]), op: op, b: parseFloat(m[3]) });
    });
    return out.slice(0, 12);
  }

  /** 常错计算所属的题型（用于限制：只有选中的题型才会出现） */
  function dcWeakKind(w) {
    const decA = String(w.a).indexOf('.') >= 0, decB = String(w.b).indexOf('.') >= 0;
    if (w.op === '+' || w.op === '−') {
      if (decA || decB) return 'decAddSub';
      const mx = Math.max(w.a, w.b);
      return mx <= 20 ? 'addSub20' : mx <= 100 ? 'addSub100' : 'addSub3';
    }
    if (w.op === '×') {
      if (decA || decB) return decB ? 'decMulDec' : 'decMulInt';
      const mx = Math.max(w.a, w.b);
      return mx <= 9 ? 'tableMul' : mx <= 99 ? 'mul1' : 'mul2';
    }
    if (decA) return 'decDivInt';
    if (w.b <= 9 && w.a <= 81) return 'tableDiv';
    return w.b <= 9 ? 'div1' : 'div2';
  }

  /** 参考一道常错计算改数据出同类题（题型不在 kinds 内则返回 null） */
  function dcWeakVaried(w, rnd, kinds) {
    const kind = dcWeakKind(w);
    if (!kind || kinds.indexOf(kind) < 0) return null;
    const jitter = function (v, step) {
      const d = (1 + Math.floor(rnd() * step)) * (rnd() < 0.5 ? -1 : 1);
      return Math.max(step >= 2 ? 1 : 0.1, dcRound(v + d));
    };
    if (w.op === '+') {
      const a = jitter(w.a, Math.max(2, Math.round(w.a * 0.2))), b = jitter(w.b, Math.max(2, Math.round(w.b * 0.2)));
      return { q: a + ' + ' + b + ' =', a: String(dcRound(a + b)), k: kind };
    }
    if (w.op === '−') {
      let a = jitter(w.a, Math.max(2, Math.round(w.a * 0.2))), b = jitter(w.b, Math.max(2, Math.round(w.b * 0.2)));
      if (a < b) { const t = a; a = b; b = t; }
      if (a === b) a = dcRound(a + 2);
      return { q: a + ' − ' + b + ' =', a: String(dcRound(a - b)), k: kind };
    }
    if (w.op === '×') {
      const a = jitter(w.a, 2), b = jitter(w.b, 2);
      return { q: a + ' × ' + b + ' =', a: String(dcRound(a * b)), k: kind };
    }
    // ÷ 保整除：除数不变，换商
    const q0 = Math.max(2, Math.round(w.a / Math.max(1, w.b)));
    const c = Math.max(2, q0 + (rnd() < 0.5 ? -1 : 1) * dcRi(rnd, 1, 3));
    return { q: dcRound(w.b * c) + ' ÷ ' + w.b + ' =', a: String(c), k: kind };
  }

  /** 采集题库里的常错计算（ IndexedDB ，预览时调用一次） */
  async function dcCollectWeak() {
    try {
      const all = await Store.Questions.list({});
      return dcExtractWeak(all);
    } catch (e) { return []; }
  }

  /* ---- 我的计算题库（localStorage，导入文件生成） ---- */
  const CALC_BANK_KEY = 'tiku.calcBank';
  function readCalcBank() {
    try { const v = JSON.parse(localStorage.getItem(CALC_BANK_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function saveCalcBank(items) {
    try { localStorage.setItem(CALC_BANK_KEY, JSON.stringify(items.slice(0, 300))); } catch (e) {}
  }
  /** 「出题时优先用题库」当前是否开启（表单临时态优先，其次已存配置，默认开） */
  function dcalcUseBankNow() {
    if (S.dcalcUseBank === true || S.dcalcUseBank === false) return S.dcalcUseBank;
    return (readDcalcCfg() || {}).useBank !== false;
  }
  /** 计算一道式题的答案（整数/小数一步运算、分数一步运算），算不出返回 '' */
  function dcCalcAnswer(expr) {
    let s = String(expr || '').trim().replace(/[=＝？?。]+$/, '').replace(/\s/g, '');
    let m = s.match(/^(\d+)\/(\d+)([+\-−×xX*÷/])(\d+)\/(\d+)$/);
    if (m) {
      const n1 = +m[1], d1 = +m[2], n2 = +m[4], d2 = +m[5];
      let op = m[3];
      if (op === '−') op = '-';
      if (op === '×' || op === 'x' || op === 'X' || op === '*') op = '*';
      if (op === '÷') op = '/';
      if (!d1 || !d2 || (op === '/' && !n2)) return '';
      if (op === '+') return dcFrac(n1 * d2 + n2 * d1, d1 * d2);
      if (op === '-') return dcFrac(n1 * d2 - n2 * d1, d1 * d2);
      if (op === '*') return dcFrac(n1 * n2, d1 * d2);
      return dcFrac(n1 * d2, d1 * n2);
    }
    m = s.match(/^(\d+(?:\.\d+)?)([+\-−×xX*÷/])(\d+(?:\.\d+)?)$/);
    if (!m) return '';
    const a = parseFloat(m[1]), b = parseFloat(m[3]);
    let op = m[2];
    if (op === '−') op = '-';
    if (op === '×' || op === 'x' || op === 'X' || op === '*') op = '*';
    if (op === '÷' || op === '/') op = '/';
    if (op === '+') return String(dcRound(a + b));
    if (op === '-') return String(dcRound(a - b));
    if (op === '*') return String(dcRound(a * b));
    if (!b) return '';
    return String(dcRound(a / b));
  }

  /* ---- 编辑答案 · 反推式子 ----
   * 老师填了答案 X、原式 a op b：选保留哪个数，系统改另一个数，使学生算出的答案恰好等于 X。
   * 全程用分数精确运算，只有能「精确算对」的方案才会提供——绝不出现式子不变、答案却是错的。 */
  function dcFr(n, d) {
    if (!d) return null;
    if (n === 0) d = 1;
    const g = dcGcd(Math.abs(n), Math.abs(d)) || 1;
    n /= g; d /= g;
    if (d < 0) { n = -n; d = -d; }
    return { n: n, d: d };
  }
  function dcFrAdd(x, y) { return dcFr(x.n * y.d + y.n * x.d, x.d * y.d); }
  function dcFrSub(x, y) { return dcFr(x.n * y.d - y.n * x.d, x.d * y.d); }
  function dcFrMul(x, y) { return dcFr(x.n * y.n, x.d * y.d); }
  function dcFrDiv(x, y) { if (!y || y.n === 0) return null; return dcFr(x.n * y.d, x.d * y.n); }
  /** 分数式里用的写法：整数也写成 n/1（保证 a/b op c/d 的解析格式成立） */
  function dcFrStr(fr) { return fr ? (fr.d === 1 ? fr.n + '/1' : fr.n + '/' + fr.d) : ''; }
  /** 分母只含 2/5 因子 → 有限小数 */
  function dcFrIsDec(fr) {
    let d = fr.d;
    while (d % 2 === 0) d /= 2;
    while (d % 5 === 0) d /= 5;
    return d === 1;
  }
  function dcFrDecStr(fr) {
    let d = fr.d, tw = 0, fv = 0;
    while (d % 2 === 0) { d /= 2; tw++; }
    while (d % 5 === 0) { d /= 5; fv++; }
    const max = Math.max(tw, fv);
    const scaled = fr.n * Math.pow(2, max - tw) * Math.pow(5, max - fv);
    let s = (scaled / Math.pow(10, max)).toFixed(max);
    // 只去小数部分的尾零（不能动整数位：'20'、'0' 都不能被削掉）
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return (s === '-0' || s === '' || s === '-') ? '0' : s;
  }
  /** '3/4' | '3.6' | '50' → {n,d}（精确分数），解析失败返回 null */
  function dcFrVal(s) {
    s = String(s || '').trim().replace(/＝/g, '=').replace(/=+$/, '').replace(/−/g, '-');
    let m = s.match(/^(-?\d+)\/(-?\d+)$/);
    if (m) return +m[2] ? dcFr(+m[1], +m[2]) : null;
    m = s.match(/^(-?\d+)(?:\.(\d+))?$/);
    if (!m) return null;
    if (m[2] === undefined) return { n: +m[1], d: 1 };
    const dec = m[2], p = Math.pow(10, dec.length);
    return dcFr((+m[1]) * p + (m[1].charAt(0) === '-' ? -parseInt(dec, 10) : parseInt(dec, 10)), p);
  }
  /** 两个数字串是否数值相等（兼容 '3/4' vs '0.75'） */
  function dcSameNum(x, y) {
    const a = dcFrVal(x), b = dcFrVal(y);
    return !!(a && b && a.n * b.d === b.n * a.d);
  }
  /**
   * 反推方案：原式 a op b，老师填的答案 X。
   * 返回 [{ key:'first'|'second', newQ, desc }]——保留第一个/第二个数、另一个数改成多少。
   * 每个方案都会先用 dcCalcAnswer 复核，算不出 X 的一律不给。
   */
  function dcSolveFixes(expr, ansStr) {
    const s = String(expr || '').trim().replace(/[=＝？?。]+$/, '').replace(/\s/g, '');
    const X = dcFrVal(ansStr);
    if (!X) return [];
    const fixes = [];
    const dispOp = function (op) { return op === '-' ? '−' : op; };
    const hadEq = /[=＝]\s*$/.test(String(expr || ''));
    const tail = hadEq ? ' =' : '';
    const tryFix = function (A, B, op, keepFirst, fmtA, fmtB) {
      let nb = null;
      if (keepFirst) {          // A op ? = X
        if (op === '+') nb = dcFrSub(X, A);
        else if (op === '-') nb = dcFrSub(A, X);
        else if (op === '×') nb = A.n === 0 ? null : dcFrDiv(X, A);
        else nb = X.n === 0 ? null : dcFrDiv(A, X);        // A ÷ ? = X → ? = A ÷ X
      } else {                   // ? op B = X
        if (op === '+') nb = dcFrSub(X, B);
        else if (op === '-') nb = dcFrAdd(X, B);
        else if (op === '×') nb = B.n === 0 ? null : dcFrDiv(X, B);
        else nb = dcFrMul(B, X);                           // ? ÷ B = X → ? = B × X
      }
      if (!nb) return null;
      const newQ = fmtA(keepFirst ? A : nb) + ' ' + dispOp(op) + ' ' + fmtB(keepFirst ? nb : B) + tail;
      // 硬校验：改完的式子必须精确算出老师填的答案
      if (!dcSameNum(dcCalcAnswer(newQ), ansStr)) return null;
      const oldV = keepFirst ? fmtB(B) : fmtA(A);
      const newV = keepFirst ? fmtB(nb) : fmtA(nb);
      return {
        key: keepFirst ? 'first' : 'second', newQ: newQ,
        desc: '保留' + (keepFirst ? '第一个数 ' + fmtA(A) : '第二个数 ' + fmtB(B)) +
          (oldV === newV ? '' : '，把' + (keepFirst ? '第二个数 ' + oldV : '第一个数 ' + oldV) + ' 改成 ' + newV)
      };
    };
    // 分数式 a/b op c/d
    let m = s.match(/^(\d+)\/(\d+)([+\-−×xX*÷/])(\d+)\/(\d+)$/);
    if (m) {
      const A = { n: +m[1], d: +m[2] }, B = { n: +m[4], d: +m[5] };
      let op = m[3];
      if (op === '−') op = '-'; if (op === '/') op = '÷'; if (op === 'x' || op === 'X' || op === '*') op = '×';
      const fs = function (fr) { return dcFrStr(dcFr(fr.n, fr.d)); };
      const f1 = tryFix(A, B, op, true, fs, fs); if (f1) fixes.push(f1);
      const f2 = tryFix(A, B, op, false, fs, fs); if (f2) fixes.push(f2);
      return fixes;
    }
    // 整数/小数式 a op b（另一个数必须还是有限小数，否则不给这个选项）
    m = s.match(/^(\d+(?:\.\d+)?)([+\-−×xX*÷/])(\d+(?:\.\d+)?)$/);
    if (!m) return [];
    const aS = m[1], bS = m[3];
    let op = m[2];
    if (op === '−') op = '-'; if (op === '/') op = '÷'; if (op === 'x' || op === 'X' || op === '*') op = '×';
    const A = dcFrVal(aS), B = dcFrVal(bS);
    if (!A || !B) return [];
    const dec = function (fr) { return dcFrIsDec(fr) ? dcFrDecStr(fr) : null; };
    const fa = function (fr) { return dec(fr); };
    const f1 = tryFix(A, B, op, true, fa, fa); if (f1) fixes.push(f1);
    const f2 = tryFix(A, B, op, false, fa, fa); if (f2) fixes.push(f2);
    return fixes;
  }
  /** 判断一条式题属于哪种题型（与所选题型过滤配套），不认识返回 '' */
  function calcKindOf(q) {
    const s = String(q || '');
    let m = s.match(/^\s*(\d+)\/(\d+)\s*([+\-−×xX*÷/])\s*(\d+)\/(\d+)/);
    if (m) {
      const op = m[3] === 'x' || m[3] === 'X' || m[3] === '*' ? '×' : m[3];
      if (op === '+' || op === '-' || op === '−') return 'fracAddSub';
      if (op === '×') return 'fracMul';
      if (op === '÷' || op === '/') return 'fracDiv';
    }
    m = s.match(/^\s*(\d+(?:\.\d+)?)\s*([+\-−×xX*÷/])\s*(\d+(?:\.\d+)?)/);
    if (!m) return '';
    const a = parseFloat(m[1]), b = parseFloat(m[3]);
    const op = m[2] === 'x' || m[2] === 'X' || m[2] === '*' ? '×' : (m[2] === '/' ? '÷' : (m[2] === '−' ? '-' : m[2]));
    const decA = m[1].indexOf('.') >= 0, decB = m[3].indexOf('.') >= 0;
    if (op === '+' || op === '-') {
      if (decA || decB) return 'decAddSub';
      const mx = Math.max(a, b);
      return mx <= 20 ? 'addSub20' : mx <= 100 ? 'addSub100' : 'addSub3';
    }
    if (op === '×') {
      if (decA || decB) return decB ? 'decMulDec' : 'decMulInt';
      const mx = Math.max(a, b);
      return mx <= 9 ? 'tableMul' : mx <= 99 ? 'mul1' : 'mul2';
    }
    if (op === '÷') {
      if (decA) return 'decDivInt';
      if (b <= 9 && a <= 81) return 'tableDiv';
      return b <= 9 ? 'div1' : 'div2';
    }
    return '';
  }
  /** 从导入文本提取计算式题：逐行扫描，一行里有多道式题也能全部提取；
   *  文字题/方程行自动跳过（x 不当乘号），分数式优先匹配。返回 { items, total } */
  function dcParseCalcText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const items = []; const seen = {}; let total = 0;
    const normOp = function (o) {
      if (o === 'x' || o === 'X' || o === '*') return '×';
      if (o === '/') return '÷';
      if (o === '-') return '−';
      return o;
    };
    const FRE = /(\d+)\s*\/\s*(\d+)\s*([+\-−×*÷])\s*(\d+)\s*\/\s*(\d+)\s*[=＝]?/g;
    const RE = /(\d+(?:\.\d+)?)\s*([+\-−×*÷])\s*(\d+(?:\.\d+)?)\s*[=＝]?/g;
    lines.forEach(function (raw) {
      let s = String(raw).trim();
      if (!s) return;
      total++;
      // 先提取分数式（a/b op c/d），再把已占用部分从行里去掉
      FRE.lastIndex = 0;
      let fm;
      while ((fm = FRE.exec(s))) {
        const q = fm[1] + '/' + fm[2] + ' ' + normOp(fm[3]) + ' ' + fm[4] + '/' + fm[5];
        const ans = dcCalcAnswer(q);
        if (ans !== '' && !seen[q]) { seen[q] = 1; items.push({ q: q + ' =', a: ans, at: Date.now() }); }
      }
      const s2 = s.replace(FRE, ' ');
      RE.lastIndex = 0;
      let m;
      while ((m = RE.exec(s2))) {
        const q = m[1] + ' ' + normOp(m[2]) + ' ' + m[3];
        const ans = dcCalcAnswer(q);
        if (ans !== '' && !seen[q]) { seen[q] = 1; items.push({ q: q + ' =', a: ans, at: Date.now() }); }
      }
    });
    return { items: items, total: total };
  }

  /** 下一个周一（周一同日算下周一；周日则明天） */
  function dcNextMonday(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    const wd = d.getDay();
    d.setDate(d.getDate() + (wd === 1 ? 7 : (8 - wd) % 7 || 7));
    return d;
  }

  /** 某日期是计划开始（周一）后的第几个工作日（0 起） */
  function dcWorkdayIndex(planStart, day) {
    let n = 0;
    const d = new Date(planStart);
    for (let i = 0; i < 400; i++) {
      if (dcDateKey(d) === dcDateKey(day)) return n;
      const w = d.getDay();
      if (w >= 1 && w <= 5) n++;
      d.setDate(d.getDate() + 1);
    }
    return n;
  }

  /** 生成某一天的题组（种子 = planSeed + 序号，同一天同组；题型只来自所选 kinds） */
  function dcDaySet(cfg, index, day) {
    const info = dcalcUnit(cfg, day);
    const rnd = mulberry32(dcHash(String(cfg.planSeed || 's') + '|' + index + '|' + (cfg.grade || '') + '|' + cfg.perDay));
    const pool = dcWeightedPool(cfg.kinds, cfg.grade);
    const kinds = (cfg.kinds && cfg.kinds.length) ? cfg.kinds : dcDefaultKinds(cfg.grade);
    const lv = cfg.diff || 2;
    const per = Math.max(1, Math.min(30, cfg.perDay || 5));
    const weak = cfg.weak || [];
    const bank = (cfg.useBank === false) ? [] : readCalcBank().filter(function (it) {
      if (it.g && cfg.grade && it.g !== cfg.grade) return false; // 只补充当前学段
      const k = it.mk || calcKindOf(it.q); // 手动改过的题型优先，以老师编辑为准
      return k && kinds.indexOf(k) >= 0; // 题库题也必须属于所选题型
    });
    const qs = []; const seen = {};
    // 自定义备注题型优先占最前面的题位（如「商中间有0的除法」每天 N 道）
    const noteR = dcNoteQs(cfg.notes, rnd, per);
    noteR.qs.forEach(function (g) { seen[g.q] = 1; qs.push(g); });
    for (let i = qs.length; i < per; i++) {
      let g = null;
      // 每 5 题的第 3 题优先用「学生常错计算」改数据出同类题
      if (weak.length && i % 5 === 2) {
        for (let t = 0; t < 6 && !g; t++) {
          g = dcWeakVaried(weak[Math.floor(rnd() * weak.length)], rnd, kinds);
          if (g && seen[g.q]) g = null;
        }
      }
      // 开启「我的计算题库」后隔题插入导入的式题
      if (!g && bank.length && i % 2 === 0) {
        for (let t = 0; t < 4 && !g; t++) {
          const it = bank[Math.floor(rnd() * bank.length)];
          if (it && !seen[it.q]) g = { q: it.q, a: it.a, k: 'bank' };
        }
      }
      for (let t = 0; t < 12 && !g; t++) {
        g = DCALC_GEN[pool[i % pool.length]](rnd, lv);
        if (g && seen[g.q]) g = null;
      }
      if (g) { seen[g.q] = 1; qs.push(g); }
    }
    // 应用预览时的手动编辑（预览确认后按天+题号覆盖）
    const edits = cfg.planEdits || {};
    Object.keys(edits).forEach(function (key) {
      const parts = key.split(':');
      if (+parts[0] === index && qs[+parts[1]]) {
        qs[+parts[1]] = Object.assign({}, qs[+parts[1]], edits[key]);
      }
    });
    return { qs: qs, week: info.week, unit: info.unit };
  }

  /** 排出下周一～周五的一周计划 */
  function dcBuildPlan(fields) {
    const monday = dcNextMonday(new Date());
    const days = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      const set = dcDaySet(fields, i, d);
      days.push({
        dateKey: dcDateKey(d), wd: '周' + '一二三四五'[i],
        md: (d.getMonth() + 1) + '月' + d.getDate() + '日',
        qs: set.qs, week: set.week, unit: set.unit
      });
    }
    return { monday: dcDateKey(monday), mondayMd: (monday.getMonth() + 1) + '月' + monday.getDate() + '日', days: days };
  }

  /** 组装当前每日计算状态：setup / pending（已确认未开始）/ active / weekDone */
  function dcalcBuild() {
    const cfg = readDcalcCfg();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!cfg || !cfg.grade || cfg.semKey !== semKeyOf(today) || !cfg.confirmed || !cfg.planStart) {
      return { state: 'setup', semNew: !!(cfg && cfg.grade && cfg.confirmed && cfg.semKey && cfg.semKey !== semKeyOf(today)) };
    }
    const planStart = new Date(cfg.planStart + 'T00:00:00');
    const planEnd = new Date(planStart);
    planEnd.setDate(planEnd.getDate() + 4);
    if (today < planStart) return { state: 'pending', grade: cfg.grade, planStart: cfg.planStart, perDay: cfg.perDay || 5, kindsN: (cfg.kinds || []).length, diffL: dcDiffLabel(cfg.diff) };
    if (today > planEnd) return { state: 'weekDone', grade: cfg.grade };
    const idx = dcWorkdayIndex(planStart, today);
    const set = dcDaySet(cfg, idx, today);
    return {
      state: 'active', grade: cfg.grade, perDay: cfg.perDay || 5, timerMin: cfg.timerMin || 5, diffL: dcDiffLabel(cfg.diff),
      dateKey: dcDateKey(today), wd: '周' + '日一二三四五六'[today.getDay()],
      week: set.week, unit: set.unit, qs: set.qs
    };
  }

  /** 每日计算设置表单（首页设置卡与弹层共用） */
  function dcalcSetupBody() {
    const cfg = readDcalcCfg() || {};
    const pick = S.dcalcPick || cfg.grade || S.defaults.grade || '五年级';
    if (!S.dcalcKinds) S.dcalcKinds = (cfg.kinds && cfg.kinds.length ? cfg.kinds.slice() : dcDefaultKinds(pick));
    if (S.dcalcDiff === undefined || S.dcalcDiff === null) S.dcalcDiff = cfg.diff || 2;
    if (S.dcalcUseBank !== true && S.dcalcUseBank !== false) S.dcalcUseBank = cfg.useBank !== false;
    const gradeChips = CONFIG.grades.map(function (g) {
      return '<button class="tag' + (g === pick ? ' active' : '') + '" data-act="dcalc:g" data-v="' + esc(g) + '">' + esc(g) + '</button>';
    }).join('');
    const kindChips = DCALC_KINDS.map(function (x) {
      return '<button class="tag' + (S.dcalcKinds.indexOf(x.k) >= 0 ? ' active' : '') + '" data-act="dcalc:k" data-k="' + x.k + '">' + esc(x.l) + '</button>';
    }).join('');
    const diffChips = DCALC_DIFFS.map(function (x) {
      return '<button class="tag' + (S.dcalcDiff === x.v ? ' active' : '') + '" data-act="dcalc:diff" data-v="' + x.v + '">' + x.l + '</button>';
    }).join('');
    const bank = readCalcBank();
    const grade = pick;
    const bankG = bank.filter(function (it) { return !it.g || it.g === grade; });
    const bankHtml = bankG.length
      ? '<div class="row between mt8" style="align-items:center;margin-bottom:6px">' +
        '<label style="font-weight:600;font-size:13px">我的计算题库 · ' + bankG.length + ' 道（' + esc(grade) + '）</label>' +
        '<span><button class="small" data-act="dcalc:useBank" style="color:' + (S.dcalcUseBank ? 'var(--brand)' : 'var(--ink-3)') + ';font-weight:600">' + (S.dcalcUseBank ? '✓ 出题时优先用题库' : '已停用，点这里启用') + '</button>　' +
        '<button class="small" data-act="dcalc:clearBank" style="color:var(--danger)">清空</button></span></div>'
      : '';
    if (!S.dcalcNotes) S.dcalcNotes = (cfg.notes || []).slice();
    const notesHtml = '<div id="dcNoteList"' + (S.dcalcNotes.length ? ' class="mt8"' : '') + '>' + (S.dcalcNotes.length ? S.dcalcNotes.map(function (nt, i) {
      return '<div class="row between" style="align-items:center;padding:6px 2px;border-bottom:1px dashed var(--line)">' +
        '<span style="font-size:13.5px">📌 ' + esc(nt.t) + ' · <b>每天 ' + nt.n + ' 道</b></span>' +
        '<button class="small" data-act="dcalc:delNote" data-i="' + i + '" style="color:var(--danger)">删除</button></div>';
    }).join('') : '') + '</div>';
    const start = cfg.startDate || defaultStartOf(semKeyOf(new Date()));
    return '<p class="muted" style="margin-bottom:8px">选好题型、难度、题数并预览一周，确认后<b>下周一</b>开始按顺序每天发布一组。出题只出<b>所选题型</b>。</p>' +
      '<div class="chips" style="flex-wrap:wrap;overflow:visible">' + gradeChips + '</div>' +
      '<div class="field mt8"><label>学期开始日期（用来算教学周）</label>' +
        '<input class="input" type="date" id="dcStart" value="' + start + '"></div>' +
      '<div class="row mt8" style="gap:8px">' +
        '<div class="field" style="flex:1"><label>每日题数</label>' +
          '<input class="input" type="number" id="dcPerDay" min="1" max="30" value="' + (cfg.perDay || 5) + '"></div>' +
        '<div class="field" style="flex:1"><label>倒计时（分钟）</label>' +
          '<input class="input" type="number" id="dcTimerMin" min="1" max="60" value="' + (cfg.timerMin || 5) + '"></div>' +
      '</div>' +
      '<div class="row between mt8" style="align-items:center;margin-bottom:6px">' +
        '<label style="font-weight:600;font-size:13px">难度</label>' +
        '<div class="chips" style="overflow:visible">' + diffChips + '</div>' +
      '</div>' +
      '<div class="row between mt8" style="align-items:center;margin-bottom:6px">' +
        '<label style="font-weight:600;font-size:13px">计算题型（点选，默认除法题更多）</label>' +
        '<span><button class="small" data-act="dcalc:allK" style="color:var(--brand);font-weight:600">全选</button>　' +
        '<button class="small" data-act="dcalc:noneK" style="color:var(--ink-3)">清空</button></span>' +
      '</div>' +
      '<div class="chips" style="flex-wrap:wrap;overflow:visible">' + kindChips + '</div>' +
      '<div class="row between mt12" style="align-items:center;margin-bottom:6px">' +
        '<label style="font-weight:600;font-size:13px">题型备注（每天多练，自动出同类题）</label>' +
      '</div>' +
      '<div class="row" style="gap:8px;align-items:flex-end">' +
        '<div class="field" style="flex:1">' +
          '<input class="input" id="dcNoteText" placeholder="例：商中间有0的除法"></div>' +
        '<div class="field" style="width:78px">' +
          '<input class="input" type="number" id="dcNoteN" min="1" max="5" value="1" title="每天几道"></div>' +
        '<button class="btn soft" data-act="dcalc:addNote" style="white-space:nowrap">＋添加</button>' +
      '</div>' +
      notesHtml +
      bankHtml +
      '<input type="file" id="dcCalcFile" accept=".txt,.pdf,.docx,.doc" style="display:none">' +
      '<button class="btn soft block mt8" data-act="dcalc:impCalc">📄 导入文件生成计算题库（txt / Word / PDF，一行一道式题）</button>' +
      '<button class="btn soft block mt8" data-act="dcalc:ocrCalc">📷 拍照识别计算题入库（一步式题，自动算答案）</button>' +
      '<button class="btn primary block mt12" data-act="dcalc:preview">生成一周预览（下周一～周五）</button>';
  }

  /** 拍照识别计算题 · 确认层：核对识别结果（可逐条移除）后加入题库 */
  function dcOcrSheet() {
    const st = S._dcOcr;
    if (!st) return;
    const rows = st.items.map(function (it, i) {
      return '<div class="dc-q"><span><span class="dc-num">' + (i + 1) + '</span>' + esc(it.q) + '</span>' +
        '<span class="dc-ans">答案：' + esc(it.a) + '</span>' +
        '<button class="small del" style="padding:2px 6px" data-act="dcoc:rm" data-i="' + i + '">✕</button></div>';
    }).join('');
    UI.sheet({
      title: '识别到 ' + st.items.length + ' 道计算题',
      body: '<p class="muted" style="margin-bottom:8px">答案已自动算好，点 ✕ 可删掉识别错误的行，确认无误后加入「我的计算题库」（上限 300 道）。</p>' +
        rows +
        '<div class="row mt12" style="gap:8px">' +
          '<button class="btn ghost grow" data-act="sheet:close">取消</button>' +
          '<button class="btn primary grow" data-act="dcoc:save">✓ 加入计算题库（' + st.items.length + ' 道）</button>' +
        '</div>'
    });
  }

  /** 每日计算 · 编辑一题：式子 / 答案 / 题型 / 难度都可改，改了就以编辑为准。
   *  答案与式子算出的不一致时（opts.warn 非空）：有方案（opts.fixes）列出「保留哪个数、
   *  系统改另一个数」的按钮；没有方案则只能改回系统答案——绝不出现式子不变、答案错误。 */
  function dcEditSheet(plan, di, i, opts) {
    const day = plan.days[di];
    const g = day && day.qs[i];
    if (!g) return;
    opts = opts || {};
    const warn = opts.warn;
    const vals = opts.vals || {};
    const fixes = opts.fixes || [];
    const qNow = vals.q !== undefined ? vals.q : g.q;
    const aNow = vals.a !== undefined ? vals.a : g.a;
    const kindNow = vals.kindIn !== undefined ? vals.kindIn : (g.mk || calcKindOf(g.q) || '');
    const diffNow = vals.diffIn !== undefined ? vals.diffIn : (g.diff !== undefined && g.diff !== null ? String(g.diff) : '');
    const kindOpts = '<option value="">自动识别</option>' + DCALC_KINDS.map(function (k) {
      return '<option value="' + k.k + '"' + (kindNow === k.k ? ' selected' : '') + '>' + k.l + '</option>';
    }).join('');
    const diffOpts = '<option value="">跟随整体难度</option>' + DCALC_DIFFS.map(function (x) {
      return '<option value="' + x.v + '"' + (diffNow === String(x.v) ? ' selected' : '') + '>' + x.l + '</option>';
    }).join('');
    const fromBank = g.k === 'bank' || (g.src === 'bank');
    let footer;
    if (fixes && fixes.length) {
      // 答案与式子不一致 → 列出「保留哪个数、另一个数改成多少」的精确方案
      footer = '<div class="mt12">' +
        '<p style="font-weight:600;font-size:13.5px;margin:0 0 6px">要让答案等于「' + esc(aNow) + '」，选一个不变的数，系统改另一个数：</p>' +
        fixes.map(function (f) {
          return '<button class="btn primary block" style="text-align:left;margin-bottom:8px" data-act="dcalc:editFix" data-d="' + di + '" data-i="' + i + '" data-q="' + esc(f.newQ) + '">' +
            esc(f.desc) + '<br><span style="font-weight:400;font-size:12px">式子改为：' + esc(f.newQ) + ' = ' + esc(aNow) + '</span></button>';
        }).join('') +
        '<button class="btn soft block" data-act="dcalc:editSys" data-d="' + di + '" data-i="' + i + '">不改式子，答案用系统算的 ' + esc(vals.computed || '') + '</button>' +
        '<button class="btn ghost block mt8" data-act="sheet:close">取消</button></div>';
    } else if (warn) {
      // 不一致且没有可改的方案（改出来除不尽/太怪）→ 只能改回系统答案
      footer = '<div class="row mt12" style="gap:8px">' +
        '<button class="btn ghost grow" data-act="sheet:close">取消</button>' +
        '<button class="btn soft grow" data-act="dcalc:editSys" data-d="' + di + '" data-i="' + i + '">用系统答案 ' + esc(vals.computed || '') + '</button>' +
      '</div>';
    } else {
      footer = '<div class="row mt12" style="gap:8px">' +
        '<button class="btn ghost grow" data-act="sheet:close">取消</button>' +
        '<button class="btn primary grow" data-act="dcalc:editSave" data-d="' + di + '" data-i="' + i + '">保存修改</button>' +
      '</div>';
    }
    UI.sheet({
      title: '编辑 ' + day.md + ' 第 ' + (i + 1) + ' 题',
      body: (warn ? '<div class="card flat" style="background:var(--warn-soft,#fff7e6);border-color:#ffe3b8;margin-bottom:10px">' +
          '<p class="small" style="color:#8a5300">' + esc(warn) + '</p></div>' : '') +
        '<div class="field"><label>式子</label>' +
          '<textarea class="textarea" id="dcEq" rows="2">' + esc(qNow) + '</textarea></div>' +
        '<div class="field"><label>答案</label>' +
          '<input class="input" id="dcAnsv" value="' + esc(aNow) + '"></div>' +
        '<div class="row mt8" style="gap:8px">' +
          '<select class="select" id="dcKind" style="flex:1.4">' + kindOpts + '</select>' +
          '<select class="select" id="dcDiff" style="flex:1">' + diffOpts + '</select>' +
        '</div>' +
        (fromBank
          ? '<p class="muted mt8" style="font-size:12px">这题来自「我的计算题库」，修改会同步更新题库里的这道题；题型 / 难度改动也会被记住，之后出题筛选按你改的算。</p>'
          : '<p class="muted mt8" style="font-size:12px">改式子后答案会自动重算；你填的答案和算出来的不一样时，会让你选保留式子里的哪个数，系统改另一个数来配你的答案，保证答案和式子一定对得上。</p>') +
        footer
    });
  }

  /** 应用一次编辑（save / 以我填的为准 / 用系统答案 三条路径共用）。
   *  题型覆盖记在 mk、难度记在 diff（不占用 bank 标记位），存进 planEdits —— 改了就以编辑为准。 */
  function dcEditApply(plan, di, i, q, ansIn, kindIn, diffIn) {
    const g = plan.days[di].qs[i];
    const computed = dcCalcAnswer(q);
    const a = (ansIn && ansIn.trim()) ? ansIn.trim() : computed;
    const oldKey = String(g.q || '').replace(/\s/g, '');
    const wasBank = g.src === 'bank' || g.k === 'bank';
    g.q = q; g.a = a;
    if (kindIn) g.mk = kindIn; else delete g.mk;
    if (diffIn) g.diff = +diffIn; else delete g.diff;
    plan.edits = plan.edits || {};
    const entry = { q: q, a: a };
    if (kindIn) entry.mk = kindIn;
    if (diffIn) entry.diff = +diffIn;
    plan.edits[di + ':' + i] = entry;
    // 来自计算题库的题：同步更新题库本身（题型/难度覆盖记在 mk/md，之后出题筛选以它为准）
    if (wasBank) {
      const bank = readCalcBank();
      const it = bank.find(function (x) { return String(x.q || '').replace(/\s/g, '') === oldKey; });
      if (it) {
        it.q = q; it.a = a;
        if (kindIn) it.mk = kindIn; else delete it.mk;
        if (diffIn) it.md = +diffIn; else delete it.md;
        saveCalcBank(bank);
      }
    }
    // 回到预览：保持编辑前展开的那几天（不跳回第一天）
    UI.sheet({ title: '一周预览 · 下周一～周五', body: dcalcPlanBody(plan, 'preview', '', plan._openDays || []) });
    const kLabel = kindIn ? (function () { const x = DCALC_KINDS.find(function (k) { return k.k === kindIn; }); return ' · 题型：' + (x ? x.l : kindIn); })() : '';
    UI.toast('已更新，答案：' + a + kLabel, 2600);
  }

  /** 一周计划预览 / 查看内容（mode='preview' 时带确认按钮；notes 为附加说明；
   *  openDays 为要保持展开的天下标——编辑某天的题后回到预览，还停在那一天） */
  function dcalcPlanBody(plan, mode, notes, openDays) {
    const n = plan.days[0] ? plan.days[0].qs.length : 0;
    const head = '<p class="muted" style="margin-bottom:8px">' + plan.mondayMd + '（周一）开始按顺序发布，每天 ' + n + ' 题；点开每天可浏览题目' + (mode === 'preview' ? '，<b>右侧为参考答案（仅预览时显示，发布后默认隐藏）</b>，每题可点 ✎ 编辑（式子、答案、题型、难度都能改）' : '') + '。' + (notes || '') + '</p>';
    const od = openDays || [];
    const days = plan.days.map(function (day, dayIdx) {
      const rows = day.qs.map(function (g, i) {
        const ansHtml = mode === 'preview'
          ? '<span class="dc-ans">答案：' + esc(g.a) + '</span>'
          : '<span class="dc-ans" style="display:none">答案：' + esc(g.a) + '</span>';
        const editBtn = (mode === 'preview')
          ? '<button class="small" style="color:var(--brand);padding:2px 6px" data-act="dcalc:editQ" data-d="' + dayIdx + '" data-i="' + i + '" aria-label="编辑">✎</button>'
          : '';
        return '<div class="dc-q"><span><span class="dc-num">' + (i + 1) + '</span>' + esc(g.q) + '</span>' + ansHtml + editBtn + '</div>';
      }).join('');
      const open = od.indexOf(dayIdx) >= 0 || (mode === 'preview' && dayIdx === 0 && !od.length);
      return '<details class="dc-day"' + (open ? ' open' : '') + '>' +
        '<summary>' + day.md + ' ' + day.wd + ' · 第 ' + day.week + ' 周' + (day.unit ? ' · ' + esc(day.unit) : '') + '（' + day.qs.length + ' 题）</summary>' + rows + '</details>';
    }).join('');
    let ops = '';
    if (mode === 'preview') {
      ops = '<div class="row mt12" style="gap:8px">' +
        '<button class="btn ghost grow" data-act="dcalc:preview">↻ 换一批</button>' +
        '<button class="btn primary grow" data-act="dcalc:confirmPlan">✓ 确认，下周一按此开始</button></div>' +
        '<button class="btn soft block mt8" data-act="dcalc:export">🖨 导出 / 打印这一周</button>';
    } else {
      ops = '<button class="btn soft block mt12" data-act="dcalc:setup">修改设置</button>' +
        '<button class="btn soft block mt8" data-act="dcalc:export">🖨 导出 / 打印这一周</button>';
    }
    return head + days + ops;
  }

  /** 当前预览里展开着的天下标（编辑前先记下，回来还停在那天） */
  function dcOpenDays() {
    const out = [];
    document.querySelectorAll('.dc-day').forEach(function (el, i) { if (el.open) out.push(i); });
    return out;
  }

  /** 首页每日计算卡片：setup（未设置/新学期/未确认）/ pending（已确认未开始）/ active / weekDone */
  function dcalcCardHtml() {
    const dc = S.cache.dcalc;
    if (!dc || dc.state === 'setup') {
      return '<section class="card" style="border-left:3px solid var(--brand)">' +
        '<div class="card-h"><h3>每日计算 · ' + (dc && dc.semNew ? '新学期开始啦' : '先设置一下') + '</h3></div>' +
        dcalcSetupBody() +
      '</section>';
    }
    if (dc.state === 'pending') {
      const d = new Date(dc.planStart + 'T00:00:00');
      return '<section class="card" style="border-left:3px solid var(--ok,#12b76a)">' +
        '<div class="card-h"><h3>每日计算 · 已确认 ✓</h3>' +
          '<button class="small" style="color:var(--brand);font-weight:600" data-act="dcalc:setup">设置 ✎</button></div>' +
        '<p class="muted" style="margin-bottom:8px">' + (d.getMonth() + 1) + '月' + d.getDate() + '日（周一）开始按顺序发布，每天 ' + dc.perDay + ' 题（' + esc(dc.grade) + ' · ' + dc.kindsN + ' 种题型 · 难度：' + (dc.diffL || '中等') + '）。</p>' +
        '<button class="btn soft block" data-act="dcalc:planView">先看一周计划</button>' +
      '</section>';
    }
    if (dc.state === 'weekDone') {
      return '<section class="card" style="border-left:3px solid var(--ok,#12b76a)">' +
        '<div class="card-h"><h3>每日计算 · 本周计划已完成</h3></div>' +
        '<p class="muted" style="margin-bottom:8px">' + esc(dc.grade) + ' · 本周一到周五的题已发布完，预览并确认下一周后继续。</p>' +
        '<button class="btn primary block" data-act="dcalc:setup">预览并确认下一周</button>' +
      '</section>';
    }
    // active
    const d = new Date(dc.dateKey + 'T00:00:00');
    const timerTxt = dc.timerMin + ':00';
    const rows = dc.qs.map(function (g, i) {
      return '<div class="dc-q"><span><span class="dc-num">' + (i + 1) + '</span>' + esc(g.q) + '</span>' +
        '<span class="dc-ans" style="display:none">答案：' + esc(g.a) + '</span></div>';
    }).join('');
    return '<section class="card">' +
      '<div class="card-h"><h3>每日计算 · ' + dc.wd + '（' + (d.getMonth() + 1) + '月' + d.getDate() + '日）</h3>' +
        '<button class="small" style="color:var(--brand);font-weight:600" data-act="dcalc:setup">设置 ✎</button></div>' +
      '<p class="muted" style="margin-bottom:6px">' + esc(dc.grade) + ' · 第 ' + dc.week + ' 周' + (dc.unit ? ' · ' + esc(dc.unit) : '') + ' · 难度：' + (dc.diffL || '中等') + ' · 共 ' + dc.qs.length + ' 题，答案已隐藏</p>' +
      rows +
      '<div class="row mt12" style="gap:8px">' +
        '<button class="btn soft grow" data-act="dcalc:timer"><span id="dcTime" class="dc-time">' + timerTxt + '</span> · 倒计时开始</button>' +
        '<button class="btn primary grow" data-act="dcalc:ans">对答案</button>' +
      '</div>' +
    '</section>';
  }


  /* =========================================================
   * 考点 × 单元：给考点名自动带上「·第N单元」后缀
   * ======================================================= */
  function unitSuffixOf(unit, subject, grade) {
    if (!unit) return '';
    const cat = Catalog.get(subject, grade, S.defaults.term, S.defaults.version);
    const i = cat.indexOf(unit);
    return i >= 0 ? '·第' + (i + 1) + '单元' : '';
  }

  /**
   * 按单元解析考点：
   *  - 有章节时考点名带「·第N单元」后缀，同单元同考点自动归到一起；
   *  - 已带后缀的先按精确匹配复用，避免被模糊规则并回无后缀考点。
   */
  /** 从「·第N单元」后缀反推单元名（不在目录返回 ''） */
  function unitSuffixToUnit(name, subject, grade) {
    const m = String(name || '').match(/·第(\d+)单元$/);
    if (!m) return '';
    const cat = Catalog.get(subject, grade, S.defaults.term, S.defaults.version);
    const i = Number(m[1]) - 1;
    return (i >= 0 && i < cat.length) ? cat[i] : '';
  }

  async function resolveUnitPoint(rawName, unit, subject, grade) {
    const base = Normalize.pretty(rawName || '') || '未分类';
    const suf = unitSuffixOf(unit, subject, grade);
    const suffixed = (base !== '未分类' && suf && !/第\d+单元$/.test(base)) ? base + suf : base;
    const pts = (await DB.all('points')).filter(function (p) {
      return p.subject === subject && p.grade === grade;
    });

    // 1) 单元在目录里：考点名带「·第N单元」后缀，只在同后缀考点里精确匹配，
    //    匹配不到就新建——绝不合并到其他单元的同名考点
    //    也不套用全局同义词表：老师在这个单元写「轴对称图形」就该是「轴对称图形」，
    //    改写成「平面图形的认识」正是分类被改乱的原因
    if (suffixed !== base) {
      const target = base + suf;
      const n = Normalize.norm(target);
      const hit = pts.find(function (p) { return p.norm === n; });
      if (hit) {
        if (unit && (hit.units || []).indexOf(unit) < 0) {
          hit.units = (hit.units || []).concat([unit]);
          await DB.put('points', hit);
        }
        return { point: hit, isNew: false, matched: 'exact', score: 1 };
      }
      // 新建带后缀的考点（别名记下无后缀叫法，方便下次联想）
      const point = {
        id: Util.uid('p'), name: target, norm: n,
        subject: subject, grade: grade, units: unit ? [unit] : [],
        aliases: [base],
        count: 0, createdAt: Date.now()
      };
      await DB.put('points', point);
      return { point: point, isNew: true, matched: 'unit-new', score: 1 };
    }

    // 2) 选了单元但单元不在目录（没有「第N单元」后缀可用）：
    //    只在「同单元」的考点里按名字/别名找，找不到就新建——不做跨单元归并
    if (unit) {
      const nb = Normalize.norm(base);
      const sameUnit = pts.filter(function (p) {
        return (p.units || []).indexOf(unit) >= 0 || unitSuffixToUnit(p.name, subject, grade) === unit;
      });
      const hit = sameUnit.find(function (p) {
        return p.norm === nb || Normalize.pretty(pointBaseName(p.name)) === base ||
          (p.aliases || []).some(function (a) { return Normalize.pretty(a) === base; });
      });
      if (hit) {
        if ((hit.units || []).indexOf(unit) < 0) {
          hit.units = (hit.units || []).concat([unit]);
          await DB.put('points', hit);
        }
        return { point: hit, isNew: false, matched: 'unit-exact', score: 1 };
      }
      const point = {
        id: Util.uid('p'), name: base, norm: nb,
        subject: subject, grade: grade, units: [unit],
        aliases: [base], count: 0, createdAt: Date.now()
      };
      await DB.put('points', point);
      return { point: point, isNew: true, matched: 'unit-new', score: 1 };
    }

    // 3) 没选单元：按原来的全局同义规则解析
    return Normalize.resolve(base, { subject: subject, grade: grade });
  }

  /* ---- 一题挂多个考点 / 多个单元 ----
   * q.points = [{id, name}]，q.units = ['单元名']；
   * 老数据没有数组字段时回退到单值字段 pointId/pointName/unit。 */
  function qUnitsOf(q) {
    if (!q) return [];
    const arr = (q.units && q.units.length) ? q.units.filter(Boolean) : (q.unit ? [q.unit] : []);
    return arr.length ? arr : ['未归类'];
  }
  function qPointsOf(q) {
    if (!q) return [];
    const arr = (q.points && q.points.length) ? q.points.filter(p => p && p.name).map(p => ({ id: p.id || '', name: p.name })) : [];
    if (q.pointId || q.pointName) {
      const first = arr[0];
      if (!first || first.id !== q.pointId) arr.unshift({ id: q.pointId || '', name: q.pointName || '未分类' });
    }
    if (!arr.length) arr.push({ id: '', name: '未分类' });
    return arr;
  }
  /* ---- 课时（单元下的再分类）----
   * q.lessons 与 q.units 按下标一一对应（第 i 个单元的课时 = lessons[i]，空串表示没分课时）；
   * 老数据没有数组字段时回退 q.lesson（主单元的课时）。 */
  function qLessonOf(q, unit) {
    if (!q) return '';
    const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
    const i = us.indexOf(unit);
    if (i >= 0 && q.lessons && q.lessons[i]) return q.lessons[i];
    return (i === 0 && q.lesson) ? q.lesson : '';
  }
  function qLessonsOf(q) {
    if (!q) return [];
    const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
    return us.map(function (u, i) {
      return (q.lessons && q.lessons[i]) || (i === 0 && q.lesson) || '';
    });
  }
  /** 题库某单元下出现过的课时名（去重）；目录里配好的课时排在最前面 */
  function knownLessonsOf(unit, subject, grade) {
    const out = [];
    const sbj = subject || S.defaults.subject, gd = grade || S.defaults.grade;
    // 目录里配好的课时优先：目录配了课时就只给目录课时（老师编辑目录后，重选课时只看到目录里的课时名）
    Catalog.lessonsOf(sbj, gd, S.defaults.term, S.defaults.version, unit || '').forEach(function (L) {
      if (L && out.indexOf(L) < 0) out.push(L);
    });
    if (out.length) return out;
    (S.cache.bankQ || []).forEach(function (q) {
      const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
      us.forEach(function (u, i) {
        if (unit && u !== unit) return;
        const L = (q.lessons && q.lessons[i]) || (!unit && i === 0 && q.lesson) || '';
        if (L && out.indexOf(L) < 0) out.push(L);
      });
    });
    return out;
  }

  /* ---- 课时：按「这道题所属的单元」给选项（v1.18.0） ---- */
  /** 这道题该按哪个单元选课时：题目单元 → 考点自带单元 → 考点名「·第N单元」后缀 */
  function lessonUnitOf(q, subject, grade) {
    if (!q) return '';
    const us = qUnitsOf(q).filter(function (u) { return u && u !== '未归类'; });
    if (us.length) return us[0];
    const sbj = subject || q.subject || S.defaults.subject;
    const gd = grade || q.grade || S.defaults.grade;
    const pts = qPointsOf(q);
    for (let i = 0; i < pts.length; i++) {
      const u = unitSuffixToUnit(pts[i].name, sbj, gd);
      if (u) return u;
    }
    return '';
  }
  /** 草稿（还没入库）该按哪个单元选课时 */
  function lessonUnitOfDraft(d, s) {
    if (!d || !s) return '';
    if (s.unit) return s.unit;
    const pts = (d.points && d.points.length) ? d.points : (d.point ? [{ name: d.point, units: d.pointUnit ? [d.pointUnit] : [] }] : []);
    for (let i = 0; i < pts.length; i++) {
      const u = (pts[i].units && pts[i].units[0]) || unitSuffixToUnit(pts[i].name, s.subject, s.grade);
      if (u) return u;
    }
    return '';
  }
  /** 某单元在题库里已经用过的课时（不看目录） */
  function usedLessonsOf(unit, subject, grade) {
    const out = [];
    (S.cache.bankQ || []).forEach(function (q) {
      const us = qUnitsOf(q);
      us.forEach(function (u, i) {
        if (unit && u !== unit) return;
        if (!unit && i > 0) return;
        const L = (q.lessons && q.lessons[i]) || (i === 0 && q.lesson) || '';
        if (L && L !== '无' && out.indexOf(L) < 0) out.push(L);
      });
    });
    return out;
  }
  /** 选课时能看到的全部课时：目录课时 + 题库里用过的（两者取并集，谁也不藏） */
  function lessonChoices(unit, subject, grade) {
    const out = [];
    const push = function (L) { if (L && L !== '无' && out.indexOf(L) < 0) out.push(L); };
    const sbj = subject || S.defaults.subject, gd = grade || S.defaults.grade;
    Catalog.lessonsOf(sbj, gd, S.defaults.term, S.defaults.version, unit || '').forEach(push);
    usedLessonsOf(unit, subject, grade).forEach(push);
    return out;
  }

  /* ---- 练习名称 / 练习类型 / 页码 ----
   * 老题目只有 batchName（如「数学练习册P23」）：没显式字段时按关键词推断类型、从名称里取页码，
   * 这样以前录的题也能直接用新筛选，不用重新录。 */
  function practiceNameOf(q) { return String((q && q.batchName) || '').trim(); }
  function practiceTypeOf(q) {
    if (!q) return '';
    if (q.practiceType) return q.practiceType;
    const n = practiceNameOf(q);
    if (!n) return '';
    if (/口算/.test(n)) return '口算本';
    if (/练习册|补充习题|配套|作业本/.test(n)) return '配套练习册';
    if (/卷|测试|考试|单元/.test(n)) return '单元测试';
    if (/课本|教材/.test(n)) return '课本习题';
    return '';
  }
  function pageNoOf(q) {
    if (q && q.pageNo) return String(q.pageNo).replace(/^[Pp]\.?\s*/, '');
    const m = practiceNameOf(q).match(/[Pp]\.?\s*(\d{1,3})/);
    return m ? m[1] : '';
  }
  /** 中文数字（1-99），单元标题用 */
  function cnNum(n) {
    n = Number(n);
    if (!n || n < 0) return '';
    const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n < 10) return d[n];
    if (n === 10) return '十';
    if (n < 20) return '十' + d[n % 10];
    if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
    return String(n);
  }
  /** 单元卡标题：「第几单元」用汉字 + 单元名（如 第三单元 · 小数除法）；不在目录里就原样显示 */
  function unitLabelOf(unit, subject, grade) {
    if (!unit || unit === '未归类') return unit || '';
    const sbj = subject || (S.bank && S.bank.subject !== '全部' ? S.bank.subject : S.defaults.subject);
    const gd = grade || (S.bank && S.bank.grade !== '全部' ? S.bank.grade : S.defaults.grade);
    const cat = Catalog.get(sbj, gd, S.defaults.term, S.defaults.version);
    const i = cat.indexOf(unit);
    return i >= 0 ? '第' + cnNum(i + 1) + '单元 · ' + unit : unit;
  }

  /* ---- 一键撤销 / 恢复 ----
   * 只针对题目数据：操作前抓一份原样（before），操作后再抓一份（after）；
   * 撤销 = 把 before 写回，恢复 = 把 after 写回 —— 删掉的题会整条回来。 */
  const Undo = (function () {
    const CAP = 20;
    const stack = [];
    let idx = -1;
    async function snap(ids) {
      const m = {};
      for (const id of (ids || [])) m[id] = (await DB.get('questions', id)) || null;
      return m;
    }
    async function begin(ids) { return await snap([].concat(ids || [])); }
    async function end(label, before) {
      const ids = Object.keys(before || {});
      if (!ids.length) return false;
      const after = await snap(ids);
      let changed = false;
      for (const id of ids) {
        if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) { changed = true; break; }
      }
      if (!changed) return false;
      stack.splice(idx + 1);
      stack.push({ label: label || '操作', before: before, after: after });
      if (stack.length > CAP) stack.shift();
      idx = stack.length - 1;
      return true;
    }
    async function write(map) {
      for (const id of Object.keys(map)) {
        if (map[id]) await DB.put('questions', map[id]);
        else await DB.del('questions', id);
      }
      try { await Store.Points.recount(); } catch (e) { /* 计数失败不影响撤销 */ }
    }
    async function undo() {
      if (idx < 0) return false;
      const e = stack[idx];
      await write(e.before);
      idx--;
      return e.label;
    }
    async function redo() {
      if (idx >= stack.length - 1) return false;
      const e = stack[idx + 1];
      await write(e.after);
      idx++;
      return e.label;
    }
    function state() {
      return {
        canUndo: idx >= 0, canRedo: idx < stack.length - 1,
        undoLabel: idx >= 0 ? stack[idx].label : '',
        redoLabel: idx < stack.length - 1 ? stack[idx + 1].label : ''
      };
    }
    function clear() { stack.length = 0; idx = -1; }
    return { begin: begin, end: end, undo: undo, redo: redo, state: state, clear: clear };
  })();

  /* ---- 筛选条件（练习名称 → 练习类型 / 页码 / 单元 / 课时 / 考点 / 题型 / 难度）
   * 每项都是「有选就缩小范围，没选就不限」 */
  function matchFilter(q, f) {
    f = f || {};
    if (f.practice && practiceNameOf(q) !== f.practice) return false;
    if (f.ptype && practiceTypeOf(q) !== f.ptype) return false;
    if (f.page && pageNoOf(q) !== String(f.page)) return false;
    if (f.unit && qUnitsOf(q).indexOf(f.unit) < 0) return false;
    if (f.lesson) {
      const hit = qUnitsOf(q).some(function (u) {
        return (!f.unit || u === f.unit) && qLessonOf(q, u) === f.lesson;
      });
      if (!hit) return false;
    }
    if (f.point && !qPointsOf(q).some(function (p) { return p.name === f.point; })) return false;
    if (f.type && f.type !== '全部' && q.type !== f.type) return false;
    if (f.difficulty && String(q.difficulty) !== String(f.difficulty)) return false;
    return true;
  }
  function filterQuestions(qs, f) {
    return (qs || []).filter(function (q) { return matchFilter(q, f); });
  }
  function hasFilter(f) {
    f = f || {};
    return !!(f.practice || f.ptype || f.page || f.unit || f.lesson || f.point ||
      (f.type && f.type !== '全部') || f.difficulty ||
      (f.multiUnit && f.multiUnit.length) || (f.multiPoint && f.multiPoint.length));
  }

  /* ---- 目录课时 · 自动配对与自动归类 ----
   * 1) syncCatalogLessons：题库里某单元已经用过的课时，自动配对进教材目录（老师可在设置里改）；
   * 2) autoAssignLessons：目录里配好课时后，按「考点名 ↔ 课时名」自动把没课时的题归到课时，
   *    判断不出的留给「分配课时」批量工具（按考点选课时或「无」）。 */
  function catalogLessonsAll(subject, grade) {
    const out = {};
    Catalog.get(subject, grade, S.defaults.term, S.defaults.version).forEach(function (u) {
      out[u] = Catalog.lessonsOf(subject, grade, S.defaults.term, S.defaults.version, u);
    });
    return out;
  }
  /** 题库已用课时 → 自动并入目录（返回并入了几个单元） */
  async function syncCatalogLessons(subject, grade) {
    const sbj = subject || S.defaults.subject, gd = grade || S.defaults.grade;
    const used = {};
    (S.cache.bankQ || []).forEach(function (q) {
      if (q.subject !== sbj || q.grade !== gd) return;
      const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
      const ls = qLessonsOf(q);
      us.forEach(function (u, i) {
        if (!u || u === '未归类' || !ls[i] || ls[i] === '无') return;   // 「无」是显式标记，不配对进目录
        (used[u] = used[u] || []);
        if (used[u].indexOf(ls[i]) < 0) used[u].push(ls[i]);
      });
    });
    let n = 0;
    Object.keys(used).forEach(function (u) {
      const cur = Catalog.lessonsOf(sbj, gd, S.defaults.term, S.defaults.version, u);
      const merged = cur.slice();
      used[u].forEach(function (L) { if (merged.indexOf(L) < 0) merged.push(L); });
      if (merged.length !== cur.length) { Catalog.setLessons(sbj, gd, S.defaults.term, S.defaults.version, u, merged); n++; }
    });
    return n;
  }
  /** 考点基本名（去掉「·第N单元」后缀） */
  function pointBaseName(name) {
    return String(name || '').replace(/·第\d+单元$/, '').trim();
  }
  /** 目录配好课时后：按考点名匹配课时，把没课时的题自动归类。返回 { assigned, pending } */
  async function autoAssignLessons(subject, grade) {
    const sbj = subject || S.defaults.subject, gd = grade || S.defaults.grade;
    const catLs = catalogLessonsAll(sbj, gd);
    const all = await Store.Questions.list({});
    let assigned = 0, pending = 0;
    for (const q of all) {
      if (q.subject !== sbj || q.grade !== gd) continue;
      const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
      if (!us.length) continue;
      const ls = qLessonsOf(q);
      // 已经全有课时（含显式「无」）的题不动
      const needIdx = [];
      us.forEach(function (u, i) { if (!ls[i]) needIdx.push(i); });
      if (!needIdx.length) continue;
      const bases = qPointsOf(q).map(function (p) { return pointBaseName(p.name); }).filter(Boolean);
      const patchLessons = ls.slice();
      let changed = false;
      needIdx.forEach(function (i) {
        const u = us[i];
        const lessons = catLs[u] || [];
        if (!lessons.length) return;
        const hits = lessons.filter(function (L) {
          return bases.some(function (b) { return b === L || b.indexOf(L) >= 0 || L.indexOf(b) >= 0; });
        });
        if (hits.length === 1) { patchLessons[i] = hits[0]; changed = true; }
      });
      if (changed) {
        await Store.Questions.update(q.id, { lessons: patchLessons, lesson: patchLessons.filter(Boolean)[0] || q.lesson || '' });
        assigned++;
      } else {
        pending++;
      }
    }
    return { assigned: assigned, pending: pending };
  }
  /** 某单元下「还没有课时」的题（显式『无』也算已分配） */
  function unassignedOf(q, unit) {
    const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
    const i = us.indexOf(unit);
    if (i < 0) return false;
    return !((q.lessons && q.lessons[i]) || (i === 0 && q.lesson) || '');
  }
  /** 写库时同步主字段（pointId/pointName/unit 取第一个），保证老逻辑不受影响 */
  function syncPrimaryRef(q) {
    const pts = qPointsOf(q);
    q.points = pts;
    q.pointId = pts[0].id;
    q.pointName = pts[0].name;
    const us = qUnitsOf(q);
    q.units = us;
    q.unit = us[0] === '未归类' ? '' : us[0];
    return q;
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

  /** 顶栏的一键撤销 / 恢复（题库、全部题目页共用） */
  function undoBtnsHtml() {
    const st = Undo.state();
    return '<button class="tb-btn mini" data-act="undo:do" aria-label="撤销"' +
        ' title="' + (st.canUndo ? '撤销：' + esc(st.undoLabel) : '还没有可撤销的操作') + '">↶</button>' +
      '<button class="tb-btn mini" data-act="undo:redo" aria-label="恢复"' +
        ' title="' + (st.canRedo ? '恢复：' + esc(st.redoLabel) : '还没有可恢复的操作') + '">↷</button>';
  }

  async function navigate(page, params, replace) {
    // 确认页未入库就离开：先问要不要存草稿
    if (S.page === 'confirm' && page !== 'confirm' && S.session && S.drafts.length) {
      const choice = await askDraftChoice();
      if (choice === null) return;              // 留在本页
      if (choice === 'save') storeDraft();
      else clearDraftStore();
    }
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
    if (S.page === 'confirm' && S.session && S.drafts.length) {
      const choice = await askDraftChoice();
      if (choice === null) return;
      if (choice === 'save') storeDraft();
      else clearDraftStore();
    }
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
    // 删除/编辑后回到原位置：S._scrollAnchor 记录的是操作前那张卡的页面纵坐标
    if (typeof S._scrollAnchor === 'number') {
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.max(0, Math.min(S._scrollAnchor, maxY)));
      S._scrollAnchor = null;
    }
    // 确认页内容有变化时自动存草稿（编辑中随时可恢复）
    if (S.page === 'confirm' && S.session && S.drafts.length) storeDraft();
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
    const batch = !!opts.batch;
    const selSet = opts.selSet || S.batch.set;
    const selAct = opts.selAct || 'batch:sel';
    const sel = batch && !!selSet[q.id];
    const clean = !!opts.clean;          // 讲评观课模式：不显示标签、不显示编辑类按钮
    // 标签 = 考点（主考点，多考点显示 +N） + 单元名 + 课时名
    const pts = qPointsOf(q);
    const mainUnit = qUnitsOf(q)[0] || '';
    // 课时按「这道题实际所属的单元」取：题目单元没有时用考点自带的单元（考点名后缀「·第N单元」）
    const lessonUnit = lessonUnitOf(q) || mainUnit;
    const mainLesson = qLessonOf(q, lessonUnit);
    // 卡片标签随时点都能直接编辑（批量模式除外——点卡片是勾选题目）
    return '<article class="card" data-id="' + q.id + '"' + (batch ? ' data-act="' + selAct + '"' : '') + '>' +
      (clean && !batch ? '' :
      '<div class="row between wrap" style="gap:6px;margin-bottom:8px">' +
        '<div class="row wrap" style="gap:6px">' +
          (batch ? '<span class="bcheck' + (sel ? ' on' : '') + '"></span>' : '') +
          (opts.hidePoint ? '' : '<span' + (batch ? ' class="chip brand"' : ' class="chip tap" data-act="q:point" data-id="' + q.id + '" title="点击修改考点"') + '>' + esc(pts[0].name || '未分类') + (pts.length > 1 ? ' +' + (pts.length - 1) : '') + '</span>') +
          (mainUnit && mainUnit !== '未归类' ? '<span class="chip gray">📖 ' + esc(mainUnit) + '</span>' : '') +
          (batch
            ? (mainLesson ? '<span class="chip gray">⏱ ' + esc(mainLesson) + '</span>' : '')
            : '<span class="chip gray tap" data-act="q:lessonSel" data-id="' + q.id + '" title="点击选课时">⏱ ' +
              (mainLesson ? esc(mainLesson) : '<span style="color:var(--warn)">课时待确认</span>') + '</span>') +
          '<span' + (batch ? ' class="chip gray"' : ' class="chip gray tap" data-act="q:typeSel" data-id="' + q.id + '" title="点击修改题型"') + '>' + esc(q.type) + '</span>' +
          '<span' + (batch ? ' class="chip gray"' : ' class="chip gray tap" data-act="q:diffSel" data-id="' + q.id + '" title="点击修改难度"') + '>难度 ' + q.difficulty + '</span>' +
        '</div>' +
      '</div>') +
      '<p class="qtext" style="padding:0">' + esc(q.text) + '</p>' +
      optionsHtml(q) +
      /* 配图区：有配图的题默认打开（可收起），不随思路展开状态；观课模式纯展示 */
      (!(q.images && q.images.length)
        ? ''
        : (clean
          ? '<div class="dimg-list mt8">' + q.images.map(function (src) {
              return '<div class="dimg-item"><img src="' + src + '" alt="题目图形"></div>';
            }).join('') + '</div>'
          : (S.openImg[q.id] !== false
            ? '<div class="dimg-list mt8">' + q.images.map(function (src, k) {
                return '<div class="dimg-item"><img src="' + src + '" alt="题目图形">' +
                  '<button class="dimg-x" data-act="q:imgDel" data-id="' + q.id + '" data-k="' + k + '" aria-label="移除图形">✕</button></div>';
              }).join('') +
              '<div class="row between" style="margin-top:4px"><p class="muted" style="font-size:12px">↑ 题目图形（点 ✕ 移除，点「配图」可增删）</p>' +
              '<button class="small muted" data-act="q:imgToggle" data-id="' + q.id + '">收起配图</button></div></div>'
            : '<div class="row between mt8"><span class="chip gray">📐 ' + q.images.length + ' 张配图</span>' +
              '<button class="small muted" data-act="q:imgToggle" data-id="' + q.id + '">展开配图</button></div>'))) +
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
        '' +
        sameBox(q)
        : '') +
      (batch ? '' :
      '<div class="qops" style="padding:10px 0 0">' +
        '<button data-act="q:toggle" data-id="' + q.id + '">' + (open ? '收起' : (clean ? '看答案 / 思路' : '展开思路/原图')) + '</button>' +
        (clean ? '' : '<button data-act="q:edit" data-id="' + q.id + '">编辑</button>') +
        (clean ? '' : '<button data-act="q:imgs" data-id="' + q.id + '">配图</button>') +
        (clean ? '' : '<button data-act="q:basket" data-id="' + q.id + '">' + (Paper.has(q.id) ? '✓ 已入卷' : '加入组卷') + '</button>') +
        (clean ? '' : '<button data-act="q:point" data-id="' + q.id + '">改考点</button>') +
        (clean ? '' : '<button data-act="q:jp" data-id="' + q.id + '">' + (jpHas(q.id) ? '✓ 在讲评单' : '讲评') + '</button>') +
        (opts.extraOps || '') +
        (clean ? '' : '<button class="del" data-act="q:del" data-id="' + q.id + '">删除</button>') +
      '</div>') +
    '</article>';
  }

  /** 批量分配 / 修改课时：两种模式
   *  「按题目」：列出每道题的题干（看得出是哪题），勾选一批后点课时一次改；
   *  「按考点整批」：还没课时的点课时归入，已分好的点课时可改。 */
  function lessonAssignSheet(unit) {
    S._lassUnit = unit;
    const unitQs = (S.cache.bankQ || []).filter(function (q) {
      return qUnitsOf(q).indexOf(unit) >= 0;
    });
    const lessons = lessonChoices(unit);
    const lessonOfIn = function (q) {
      const us = qUnitsOf(q);
      const idx = us.indexOf(unit);
      if (idx < 0) return '';
      return (q.lessons && q.lessons[idx]) || (idx === 0 && q.lesson) || '';
    };
    const pendingQs = unitQs.filter(function (q) { return unassignedOf(q, unit); });
    const mode = S._lassMode || 'q';
    const modeChips = '<div class="chips" style="margin-bottom:10px">' +
      '<button class="tag' + (mode === 'q' ? ' active' : '') + '" data-act="bank:lassMode" data-v="q" data-unit="' + esc(unit) + '">按题目选</button>' +
      '<button class="tag' + (mode === 'point' ? ' active' : '') + '" data-act="bank:lassMode" data-v="point" data-unit="' + esc(unit) + '">按考点整批</button>' +
      '</div>';

    /* ---------- 按题目：勾题 → 点课时 ---------- */
    if (mode === 'q') {
      const sel = S._lassSel || {};
      const selIds = Object.keys(sel).filter(function (id) { return sel[id]; });
      const rows = unitQs.map(function (q) {
        const cur = lessonOfIn(q);
        const text = String(q.text || '').replace(/\s+/g, ' ').trim();
        return '<div class="lass-row' + (sel[q.id] ? ' on' : '') + '" data-act="bank:lassSel" data-id="' + q.id + '">' +
          '<span class="bcheck' + (sel[q.id] ? ' on' : '') + '"></span>' +
          '<div class="lass-main">' +
            '<div class="lass-text">' + esc(text.slice(0, 90)) + (text.length > 90 ? '…' : '') + '</div>' +
            '<div class="lass-meta">' + esc(qPointsOf(q).map(function (p) { return p.name; }).join('、') || '未分类') +
              ' · ' + (cur ? '课时 ' + esc(cur) : '<span style="color:var(--warn)">未分课时</span>') + '</div>' +
          '</div></div>';
      }).join('');
      const lessonBtns = lessons.map(function (L) {
        return '<button class="tag' + (selIds.length ? '' : ' dim') + '" data-act="bank:lassApply" data-unit="' + esc(unit) + '" data-v="' + esc(L) + '">' + esc(L) + '</button>';
      }).join('') +
        '<button class="tag' + (selIds.length ? '' : ' dim') + '" data-act="bank:lassApply" data-unit="' + esc(unit) + '" data-v="无">无</button>';
      const body =
        '<p class="muted" style="margin-bottom:8px">「' + esc(unitLabelOf(unit)) + '」共 ' + unitQs.length + ' 题，' + pendingQs.length + ' 题还没分课时。' +
          '勾选要改的题（可以多选），再点下面的课时——一次改完。</p>' +
        modeChips +
        (unitQs.length ? rows : '<div class="empty">这个单元还没有题目</div>') +
        (lessons.length
          ? '<div class="lass-bar">' +
              '<div class="row between" style="margin-bottom:8px">' +
                '<span class="small" style="font-weight:600">已选 ' + selIds.length + ' 题</span>' +
                '<span class="row" style="gap:8px">' +
                  '<button class="small" style="color:var(--brand);font-weight:600" data-act="bank:lassAll" data-unit="' + esc(unit) + '" data-v="1">全选</button>' +
                  '<button class="small" style="color:var(--ink-3)" data-act="bank:lassAll" data-unit="' + esc(unit) + '" data-v="">清空</button>' +
                '</span>' +
              '</div>' +
              '<div class="chips wrapv" style="margin:0">' + lessonBtns + '</div>' +
            '</div>'
          : '<div class="empty" style="padding:14px 0">这个单元还没配课时——去「我的 → 设置 → 每单元的课时」里配好，这里就能按课时改了<br>' +
            '<button class="btn soft sm" style="margin-top:10px" data-act="bank:lessonEdit" data-unit="' + esc(unit) + '">＋ 现在给这个单元加课时</button></div>');
      UI.sheet({ title: '改课时 · ' + unitLabelOf(unit), body: body });
      return;
    }

    // 待分配：按考点列出
    const byPending = {};
    pendingQs.forEach(function (q) {
      qPointsOf(q).forEach(function (p) {
        const key = p.id || 'n:' + p.name;
        const e = byPending[key] || (byPending[key] = { name: p.name, count: 0 });
        e.count++;
      });
    });
    const pendingRows = Object.keys(byPending).map(function (k) {
      const p = byPending[k];
      const chips = '<div class="chips wrapv" style="margin-top:6px">' +
        lessons.map(function (L) {
          return '<button class="tag" data-act="bank:assignLesson" data-unit="' + esc(unit) + '" data-point="' + esc(p.name) + '" data-v="' + esc(L) + '">' + esc(L) + '</button>';
        }).join('') +
        '<button class="tag" data-act="bank:assignLesson" data-unit="' + esc(unit) + '" data-point="' + esc(p.name) + '" data-v="无">无</button></div>';
      return '<div class="list-item" style="flex-wrap:wrap;align-items:flex-start">' +
        '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div>' +
        '<span class="muted" style="font-size:12px">' + p.count + ' 题未分课时，点课时一次归入：</span>' + chips + '</div></div>';
    }).join('');

    // 已分配：按考点列出，标出当前课时，点课时即改
    const byDone = {};
    unitQs.filter(function (q) { return !unassignedOf(q, unit); }).forEach(function (q) {
      qPointsOf(q).forEach(function (p) {
        const key = p.id || 'n:' + p.name;
        const e = byDone[key] || (byDone[key] = { name: p.name, count: 0, cur: {} });
        e.count++;
        const L = lessonOfIn(q);
        if (L) e.cur[L] = (e.cur[L] || 0) + 1;
      });
    });
    const curOf = function (e) {
      return Object.keys(e.cur).sort(function (a, b) { return e.cur[b] - e.cur[a]; })[0] || '';
    };
    const doneRows = Object.keys(byDone).map(function (k) {
      const e = byDone[k];
      const cur = curOf(e);
      const chip = function (act, L, label) {
        return '<button class="tag' + (cur === L ? ' active' : '') + '" data-act="' + act + '" data-unit="' + esc(unit) + '" data-point="' + esc(e.name) + '" data-v="' + esc(L) + '">' + esc(label || L) + '</button>';
      };
      const chips = '<div class="chips wrapv" style="margin-top:6px">' +
        lessons.map(function (L) { return chip('bank:reassignLesson', L); }).join('') +
        chip('bank:reassignLesson', '无', '无') + '</div>';
      return '<div class="list-item" style="flex-wrap:wrap;align-items:flex-start">' +
        '<div class="li-main"><div class="li-t">' + esc(e.name) + '</div>' +
        '<span class="muted" style="font-size:12px">' + e.count + ' 题 · 当前：' + (cur || '未标') + '，点课时改成：</span>' + chips + '</div></div>';
    }).join('');

    let body = modeChips;
    if (pendingQs.length) {
      body += '<p class="muted" style="margin-bottom:8px">「' + esc(unit) + '」还有 ' + pendingQs.length + ' 题没分课时。系统按考点判断不出的，在这里按考点批量归：点一个课时，该考点下这些题就都归到那个课时；点「无」表示明确不按课时分。</p>' +
        '<div class="sec-title">待分配</div>' + pendingRows;
    } else {
      body += '<p class="muted" style="margin-bottom:8px">「' + esc(unit) + '」的题都分过课时了。下面是已分配的考点，点一个课时就能整批改过去（改过的题跟着换）。</p>';
    }
    if (doneRows) body += '<div class="sec-title">已分配 · 点课时可改</div>' + doneRows;
    if (!pendingRows && !doneRows) body += '<div class="empty">这个单元还没有题目</div>';
    UI.sheet({ title: '分配课时 · ' + unitLabelOf(unit), body: body });
  }

  /** 把一批题在某个单元下的课时统一改成 v（v='无' 表示明确不按课时分） */
  async function setLessonForQuestions(ids, unit, v) {
    for (const id of (ids || [])) {
      const q = await DB.get('questions', id);
      if (!q) continue;
      const us = qUnitsOf(q);
      const i = us.indexOf(unit);
      if (i < 0) continue;
      const ls = qLessonsOf(q);
      ls[i] = v;
      await Store.Questions.update(id, { lessons: ls, lesson: ls.filter(function (x) { return x && x !== '无'; })[0] || ls[0] || '' });
    }
  }

  /* =========================================================
   * 课时选择弹层（题库题卡 / 录入草稿通用）
   * 选项来源 = 这道题所属单元的课时（教材目录 + 题库里用过的）
   * 没有单元时按关键字新建；有关键字也能直接新建到该单元下
   * ======================================================= */
  function lessonChipsHtml() {
    const st = S._lp;
    if (!st) return '';
    const unit = st.unit || '';
    const kwRaw = String(st.kw || '').trim();
    const kw = kwRaw.toLowerCase();
    const sbj = st.subject || S.defaults.subject;
    const gd = st.grade || S.defaults.grade;
    const catAll = unit ? Catalog.lessonsOf(sbj, gd, S.defaults.term, S.defaults.version, unit) : [];
    const all = lessonChoices(unit, sbj, gd);
    const usedOnly = all.filter(function (L) { return catAll.indexOf(L) < 0; });
    const hit = function (L) { return !kw || String(L).toLowerCase().indexOf(kw) >= 0; };
    const chip = function (v) {
      return '<button class="tag' + (String(st.cur || '') === v ? ' active' : '') +
        '" data-act="lesson:pick" data-v="' + esc(v) + '">' + esc(v) + '</button>';
    };
    let html = '';
    const catHit = catAll.filter(hit);
    const usedHit = usedOnly.filter(hit);
    if (catHit.length) html += '<div class="sec-title">本单元课时</div><div class="chips wrapv">' + catHit.map(chip).join('') + '</div>';
    if (usedHit.length) html += '<div class="sec-title">题库里用过的</div><div class="chips wrapv">' + usedHit.map(chip).join('') + '</div>';
    if (!catHit.length && !usedHit.length) {
      html += '<p class="muted" style="margin:2px 0 8px">' +
        (kwRaw ? '没有匹配「' + esc(kwRaw) + '」的课时。' : (unit ? '这个单元还没配课时。' : '这道题还没归单元，也就没有现成课时。')) +
        '直接在下面的框里输入课时名，点「新建」就能用。</p>';
    }
    if (kwRaw) {
      const exists = all.some(function (L) { return String(L).toLowerCase() === kw; });
      if (!exists) {
        html += '<button class="btn soft block mt12" data-act="lesson:new" data-v="' + esc(kwRaw) + '">＋ 新建课时「' + esc(kwRaw) + '」' +
          (unit ? '（记到「' + esc(unit) + '」下）' : '（先当课时名用）') + '</button>';
      }
    }
    html += '<div class="chips" style="margin-top:14px"><button class="tag" data-act="lesson:pick" data-v="">' +
      (st.cur ? '清除课时' : '暂不标课时') + '</button></div>';
    return html;
  }

  function lessonPickBody() {
    const st = S._lp;
    if (!st) return '';
    const unit = st.unit || '';
    const preview = String(st.text || '').replace(/\s+/g, ' ').trim();
    return '<p class="qtext" style="padding:0 0 8px;font-size:13.5px;color:var(--ink-2)">' +
        esc(preview.slice(0, 70)) + (preview.length > 70 ? '…' : '') + '</p>' +
      '<p class="muted" style="margin-bottom:8px">' +
        (unit
          ? '单元：<b>' + esc(unitLabelOf(unit, st.subject, st.grade)) + '</b>' + (st.unitFrom ? '（按考点「' + esc(st.unitFrom) + '」所属单元）' : '')
          : '这道题还没归单元，所以没有现成课时——可以直接输入课时名；想以后自动列课时，先在题目考点里选好单元。') +
        (st.cur ? '　当前：<b>' + esc(st.cur) + '</b>' : '') + '</p>' +
      '<div class="field"><label>找课时 / 新建（输入关键字过滤）</label>' +
        '<input class="input" id="lpKw" placeholder="如：三角形、第2课时" value="' + esc(st.kw || '') + '" autocomplete="off"></div>' +
      '<div id="lpChips">' + lessonChipsHtml() + '</div>';
  }

  function lessonPickSheet(opt) {
    S._lp = Object.assign({ kw: '' }, opt || {});
    UI.sheet({
      title: opt && opt.mode === 'draft' ? '给这道题选课时' : '改课时',
      body: lessonPickBody(),
      onMount: function (root) {
        const inp = root.querySelector('#lpKw');
        if (!inp) return;
        inp.addEventListener('input', function () {
          if (S._lp) S._lp.kw = inp.value;
          const box = document.getElementById('lpChips');
          if (box) box.innerHTML = lessonChipsHtml();
        });
        if (window.innerWidth > 520) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 80);
      }
    });
  }

  /** 落地：把课时写到题（题库）或草稿（确认页） */
  async function applyLessonChoice(v) {
    const st = S._lp;
    if (!st) return;
    const val = String(v || '').trim();
    if (st.mode === 'draft') {
      const d = S.drafts[st.i];
      if (d) d.lesson = val;
      UI.close();
      UI.toast(val ? '课时改为「' + val + '」' : '已清除课时');
      await render();
      return;
    }
    const q = await DB.get('questions', st.id);
    if (!q) { UI.close(); return; }
    const unit = st.unit || lessonUnitOf(q) || qUnitsOf(q)[0] || '';
    const us = qUnitsOf(q);
    const idx = us.indexOf(unit);
    const lessons = us.map(function (u, i) { return i === idx ? val : qLessonOf(q, u); });
    const before = await Undo.begin([q.id]);
    await Store.Questions.update(q.id, { lessons: lessons, lesson: idx === 0 ? val : (q.lesson || '') });
    await Undo.end('改课时', before);
    UI.close();
    UI.toast(val ? '课时已改为「' + val + '」（可撤销）' : '已清除课时（可撤销）');
    await render();
  }

  /** 编辑某单元的课时列表（设置页「每单元的课时」→ ✎） */
  function lessonEditSheet(unit) {
    const cv2 = S._catVersion || S.defaults.version;
    const ls = Catalog.lessonsOf(S.defaults.subject, S.defaults.grade, S.defaults.term, cv2, unit);
    UI.sheet({
      title: '「' + unit + '」的课时',
      body: '<p class="muted" style="margin-bottom:8px">每行一个课时（如：第1课时、三角形的面积）。保存后系统会按考点自动把该单元没课时的题归到对应课时，判断不出的去题库该单元卡「分配课时」批量归；清空表示这个单元不按课时分。</p>' +
        '<textarea class="textarea" id="unitLessonText" style="min-height:140px" placeholder="第1课时&#10;第2课时">' + esc(Catalog.toText(ls)) + '</textarea>' +
        '<div class="row mt12" style="gap:8px">' +
          '<button class="btn ghost grow" data-act="sheet:close">取消</button>' +
          '<button class="btn primary grow" data-act="settings:lessonsSave" data-unit="' + esc(unit) + '">保存并自动归类</button></div>'
    });
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
   * 讲评：把课上要讲的题收进讲评单（localStorage 持久化），
   * 讲评时可一键调出题库里同考点 / 同题型的题，并排对比分析。
   * ======================================================= */
  const PAGES = {};
  const JP_KEY = 'tiku.jp.ids';

  function jpLoad() {
    try { return JSON.parse(localStorage.getItem(JP_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function jpSave(ids) {
    try { localStorage.setItem(JP_KEY, JSON.stringify(ids.slice(0, 100))); } catch (e) {}
  }
  function jpHas(id) { return jpLoad().indexOf(id) >= 0; }

  /** 讲评 / 对比里的一块题目（含考点·单元·课时·题型标签、配图、答案与思路） */
  function jpCmpBox(q, label) {
    if (!q) return '<div class="cmp-box"><b>' + esc(label) + '</b><p class="muted">题目不存在</p></div>';
    const pts = qPointsOf(q);
    const mainUnit = qUnitsOf(q)[0] || '';
    const mainLesson = qLessonOf(q, mainUnit);
    const imgs = (q.images && q.images.length)
      ? '<div class="dimg-list mt8">' + q.images.map(function (src) {
          return '<div class="dimg-item"><img src="' + src + '" alt="题目图形"></div>';
        }).join('') + '</div>'
      : '';
    return '<div class="cmp-box">' +
      '<b>' + esc(label) + '</b>' +
      '<div class="row wrap" style="gap:6px;margin:8px 0 4px">' +
        (pts[0].name ? '<span class="chip brand">' + esc(pts[0].name || '未分类') + (pts.length > 1 ? ' +' + (pts.length - 1) : '') + '</span>' : '') +
        (mainUnit && mainUnit !== '未归类' ? '<span class="chip gray">📖 ' + esc(mainUnit) + '</span>' : '') +
        (mainLesson ? '<span class="chip gray">⏱ ' + esc(mainLesson) + '</span>' : '') +
        '<span class="chip gray">' + esc(q.type || '') + '</span>' +
        '<span class="chip gray">难度 ' + esc(q.difficulty) + '</span>' +
      '</div>' +
      '<p class="cmp-text">' + esc(q.text) + '</p>' +
      ((q.options && q.options.length) ? '<p class="cmp-text opt">' + q.options.map(esc).join('<br>') + '</p>' : '') +
      imgs +
      (q.answer ? '<div class="answer-line"><b>答案：</b>' + esc(q.answer) + '</div>' : '') +
      (q.solution ? '<div class="solution-box mt8"><b>解题思路</b>' + esc(q.solution) + '</div>' : '') +
    '</div>';
  }

  /* ---- 考点名相似度（v1.14.0）：共同文字越多越「类似」 ---- */
  /** 两个考点名最长的一段共同文字（去掉「的、与、和」这类虚词再比） */
  function pointCommon(a, b) {
    const A = String(a || '').replace(/[\s的与和及了之其、，,·（）()“”"']/g, '');
    const B = String(b || '').replace(/[\s的与和及了之其、，,·（）()“”"']/g, '');
    let best = '';
    const dp = [];
    for (let x = 0; x <= A.length; x++) dp.push(new Array(B.length + 1).fill(0));
    for (let x = 1; x <= A.length; x++) {
      for (let y = 1; y <= B.length; y++) {
        if (A.charAt(x - 1) === B.charAt(y - 1)) {
          const n = dp[x - 1][y - 1] + 1;
          dp[x][y] = n;
          if (n > best.length) best = A.substr(x - n, n);
        }
      }
    }
    return best;
  }
  /** 题与题的考点相似度：取最像的一对考点名（共同文字越长越像） */
  function pointSimOf(a, b) {
    const an = qPointsOf(a).map(function (p) { return p.name; }).filter(Boolean);
    const bn = qPointsOf(b).map(function (p) { return p.name; }).filter(Boolean);
    let best = { score: 0, common: '', name: '' };
    an.forEach(function (x) {
      bn.forEach(function (y) {
        const c = pointCommon(x, y);
        if (c.length > best.score) best = { score: c.length, common: c, name: y };
      });
    });
    return best;
  }
  /** 2 个字以上相同才算「类似」，避免「数」「图」这类单字到处命中 */
  const SIM_MIN = 2;

  /** 同类对比：同考点 → 类似考点（共同文字多的靠前）→ 同题型 */
  async function jpCmpSheet(qid) {
    const q = await DB.get('questions', qid);
    if (!q) return;
    S._jpCmpId = qid;
    const all = await Store.Questions.list({ type: q.type });
    const myPts = qPointsOf(q).map(p => p.id).filter(Boolean);
    const myNames = qPointsOf(q).map(p => p.name).filter(Boolean);
    const others = all.filter(function (x) { return x.id !== q.id; });
    const exact = [], sim = [], typeOnly = [];
    others.forEach(function (x) {
      const xp = qPointsOf(x);
      const isExact = xp.some(function (p) { return (p.id && myPts.indexOf(p.id) >= 0) || myNames.indexOf(p.name) >= 0; });
      if (isExact) { exact.push(x); return; }
      const sr = pointSimOf(q, x);
      if (sr.score >= SIM_MIN) { sim.push({ q: x, score: sr.score, common: sr.common }); return; }
      typeOnly.push(x);
    });
    sim.sort(function (a, b) { return b.score - a.score || (b.q.createdAt || 0) - (a.q.createdAt || 0); });

    const rowHtml = function (x, extra) {
      const pts = qPointsOf(x);
      return '<div class="list-item" data-act="jp:cmpShow" data-id="' + x.id + '">' +
        '<div class="li-main"><div class="li-t">' + esc(Util.cut(x.text, 36)) + '</div>' +
        '<div class="li-s">' + (extra ? extra + ' · ' : '') + esc(pts[0].name || '未分类') + ' · ' + esc(x.type || '') + ' · 难度 ' + esc(x.difficulty) + '</div></div>' +
        ARROW + '</div>';
    };
    const body =
      '<p class="muted" style="margin-bottom:8px">当前考点：<b>' + esc(myNames[0] || '未分类') + '</b>，题型：<b>' + esc(q.type || '') + '</b>。点一道题，和讲评题并排对比分析。</p>' +
      (exact.length
        ? '<div class="sec-title">同考点 · ' + exact.length + ' 道</div>' + exact.slice(0, 20).map(function (x) { return rowHtml(x); }).join('')
        : '<div class="sec-title">同考点 · 0 道</div><div class="empty small" style="padding:10px 0">题库里还没有同考点的其他题</div>') +
      (sim.length
        ? '<div class="sec-title">类似考点 · ' + sim.length + ' 道（共同文字越多越靠前）</div>' +
          sim.slice(0, 20).map(function (e) { return rowHtml(e.q, '共同「' + esc(e.common) + '」'); }).join('')
        : '') +
      (typeOnly.length
        ? '<div class="sec-title">同题型 · ' + typeOnly.length + ' 道</div>' + typeOnly.slice(0, 20).map(function (x) { return rowHtml(x); }).join('')
        : '');
    UI.sheet({ title: '同类对比 · 选一道题', body: body });
  }

  /* =========================================================
   * 讲评包（v1.13.0）
   * 把讲评单里的题 + 同考点/同题型候选题，打包成一条链接（推到自己的
   * GitHub Pages）或一个自包含 HTML 文件。链接页打开一次即离线可用。
   * ======================================================= */
  const PACK_SVC_KEY = 'tiku.pack.svc';
  const PACK_KEEP_KEY = 'tiku.pack.keep';

  function packServiceUrl() {
    const v = localStorage.getItem(PACK_SVC_KEY) || (CONFIG.pack && CONFIG.pack.serviceUrl) || 'http://127.0.0.1:8787';
    return String(v).replace(/\/+$/, '');
  }
  function packKeepDays() {
    const n = Number(localStorage.getItem(PACK_KEEP_KEY));
    return n > 0 ? n : ((CONFIG.pack && CONFIG.pack.keepDays) || 7);
  }

  function packItemOf(q, role) {
    const us = qUnitsOf(q);
    const u = us[0] || '';
    return {
      role: role,
      id: q.id,
      text: q.text || '',
      options: (q.options || []).slice(),
      answer: q.answer || '',
      solution: q.solution || '',
      type: q.type || '',
      difficulty: q.difficulty || '',
      unit: (u && u !== '未归类') ? u : '',
      lesson: qLessonOf(q, u) || '',
      points: qPointsOf(q).map(function (p) { return p.name; }).filter(Boolean),
      images: (q.images || []).slice()
    };
  }

  /** 组包：讲评单的题当主体，再补每道的同考点/同题型候选（最多 3 道/题，总数封顶） */
  async function buildPack() {
    const mains = (S.cache.jpQs || []).slice();
    if (!mains.length) throw new Error('讲评单是空的，先在题库里点题目卡下面的「讲评」把题加进来');
    const seen = {};
    mains.forEach(function (q) { seen[q.id] = 1; });
    const all = await Store.Questions.list({});
    const sameMax = (CONFIG.pack && CONFIG.pack.sameMax) || 30;
    const picks = [];
    mains.forEach(function (q) {
      const pts = qPointsOf(q).map(function (p) { return p.name; }).filter(Boolean);
      const rank = function (x) {
        const xp = qPointsOf(x).map(function (p) { return p.name; });
        if (pts.length && xp.some(function (n) { return pts.indexOf(n) >= 0; })) return 0;
        const s2 = pointSimOf(q, x).score;
        if (s2 >= SIM_MIN) return 1 + (20 - Math.min(20, s2));   // 共同文字多的靠前
        return 30;
      };
      const pool = all.filter(function (x) {
        if (seen[x.id]) return false;
        return rank(x) < 30 || x.type === q.type;
      }).sort(function (a, b) {
        return rank(a) - rank(b) || (b.createdAt || 0) - (a.createdAt || 0);
      }).slice(0, 3);
      pool.forEach(function (x) {
        if (seen[x.id] || picks.length >= sameMax) return;
        seen[x.id] = 1;
        picks.push(x);
      });
    });
    const items = mains.map(function (q) { return packItemOf(q, 'main'); })
      .concat(picks.map(function (q) { return packItemOf(q, 'same'); }));
    const first = mains[0];
    let unit = qUnitsOf(first)[0] || '';
    if (unit === '未归类') unit = '';
    return {
      title: (unit ? unitLabelOf(unit) + ' · ' : '') + '讲评包',
      subject: first.subject || '',
      grade: first.grade || '',
      unit: unit,
      items: items,
      mainCount: mains.length,
      sameCount: picks.length
    };
  }

  function packBytes(p) {
    let n = 0;
    p.items.forEach(function (it) {
      n += (it.text || '').length + (it.answer || '').length + (it.solution || '').length;
      (it.images || []).forEach(function (src) { n += String(src).length; });
    });
    return n;
  }

  async function packSheet() {
    let p;
    try { p = await buildPack(); } catch (e) { UI.toast(e.message, 2600); return; }
    S._pack = p;
    const imgs = p.items.reduce(function (n, it) { return n + (it.images || []).length; }, 0);
    const bytes = packBytes(p);
    const mb = bytes / 1048576;
    const keep = packKeepDays();
    const keepChips = [3, 7, 15].map(function (d) {
      return '<button class="tag' + (keep === d ? ' active' : '') + '" data-act="pack:keep" data-v="' + d + '">' + d + ' 天</button>';
    }).join('');
    const body = '' +
      '<p class="muted" style="margin-bottom:10px">讲评题 <b>' + p.mainCount + '</b> 道 · 同类题 <b>' + p.sameCount +
        '</b> 道 · 配图 <b>' + imgs + '</b> 张 · 约 <b>' + (mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB') + '</b></p>' +
      '<div class="field"><label>标题（显示在页面顶部）</label>' +
        '<input class="input" id="packTitle" value="' + esc(p.title) + '"></div>' +
      '<div class="field"><label>保留多久（到期自动从线上清掉）</label><div class="chips">' + keepChips + '</div></div>' +
      '<button class="btn primary block" data-act="pack:link">🔗 生成链接（含二维码）</button>' +
      '<p class="muted" style="margin:6px 0 14px">需要电脑上的题库服务在运行（本机 8787）。生成后教室电脑/手机打开链接，打开一次就会缓存，之后断网也能讲。</p>' +
      '<button class="btn ghost block" data-act="pack:file">💾 导出单文件 HTML（离线兜底）</button>' +
      '<p class="muted" style="margin:6px 0 0">手机或不方便开服务时用这个：一个 HTML 文件，用微信发到教室电脑，双击就能看，断网也不影响。</p>';
    UI.sheet({ title: '生成讲评包', body: body });
  }

  function qrSvg(text) {
    try {
      if (typeof qrcode !== 'function') return '';
      const q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch (e) { return ''; }
  }

  function packResultSheet(res) {
    const url = res.url || '';
    const when = res.expiresAt ? PackView.fmt(res.expiresAt) : '';
    const body = '' +
      '<p class="muted" style="margin-bottom:8px">教室电脑或手机打开这条链接：</p>' +
      '<input class="input code" id="packUrl" readonly value="' + esc(url) + '">' +
      '<div class="row" style="gap:8px;margin:10px 0 6px">' +
        '<button class="btn primary grow" data-act="pack:copy">复制链接</button>' +
        '<a class="btn ghost grow" href="' + esc(url) + '" target="_blank" rel="noopener" style="text-align:center">现在打开</a>' +
      '</div>' +
      (qrSvg(url) ? '<div class="qr-wrap">' + qrSvg(url) + '<p class="muted">手机扫这个也能进</p></div>' : '') +
      '<p class="muted" style="margin-top:10px">· 线上共 ' + res.packs + ' 个包，占用约 ' + res.sizeMB + ' MB' +
        (when ? '，本包保留到 ' + when : '') + '</p>' +
      '<p class="muted">· GitHub Pages 需要 30–90 秒生效，刚生成就打不开是正常的，等一会儿刷新。</p>' +
      '<p class="muted">· 课前在教室电脑上打开一次，页面就会缓存，课上断网也能翻。</p>';
    UI.sheet({ title: '讲评包已生成', body: body });
  }

  async function packExportFile() {
    const p = S._pack;
    if (!p) { UI.toast('先点「生成讲评包」'); return; }
    const t = document.getElementById('packTitle');
    if (t && t.value.trim()) p.title = t.value.trim();
    let src = '';
    try { src = await (await fetch('js/packview.js')).text(); } catch (e) { src = ''; }
    const html = window.PackView && PackView.standalone
      ? PackView.standalone(p, src)
      : '<!doctype html><meta charset="utf-8"><h1>' + esc(p.title) + '</h1><p>打包失败</p>';
    Util.download('讲评包-' + (p.unit || '本课') + '-' + Util.fmtDate(Date.now()) + '.html', html);
    UI.toast('已导出，用微信发到教室电脑双击打开', 3000);
  }

  /* =========================================================
   * 数据码同步（手机 ↔ 电脑，免同一 Wi-Fi）
   * 一端把题库（含考点/组卷/配图）压成一串文字码，微信发给自己，
   * 另一端粘贴导入合并。数据只存各自本机；只有讲评包上云。
   * ======================================================= */
  const DCODE_PREFIX = 'TK1.';

  function dcodeEncode(data) {
    return DCODE_PREFIX + LZString.compressToEncodedURIComponent(JSON.stringify(data));
  }

  function dcodeDecode(text) {
    let s = String(text || '').trim();
    if (!s) throw new Error('请先粘贴数据码');
    if (s[0] === '{') {   // 兼容直接粘贴 JSON 备份
      const d = JSON.parse(s);
      if (!d || !Array.isArray(d.questions)) throw new Error('不是题点的数据');
      return d;
    }
    const i = s.indexOf(DCODE_PREFIX);
    if (i < 0) throw new Error('不是有效的数据码（应以 TK1. 开头）');
    s = s.slice(i + DCODE_PREFIX.length).replace(/\s+/g, '');
    const json = LZString.decompressFromEncodedURIComponent(s);
    if (!json) throw new Error('数据码不完整：发送时可能被折断，重新复制粘贴试试');
    const d = JSON.parse(json);
    if (!d || !Array.isArray(d.questions)) throw new Error('数据码内容不正确');
    return d;
  }

  function dcodeGenDraw() {
    const st = S._dc;
    const daysChips = [{ v: 0, l: '全部' }, { v: 3, l: '最近 3 天' }, { v: 7, l: '最近 7 天' }].map(function (o) {
      return '<button class="tag' + (st.days === o.v ? ' active' : '') + '" data-act="dcode:opt" data-k="days" data-v="' + o.v + '">' + o.l + '</button>';
    }).join('');
    let result = '';
    if (st.code) {
      const kb = Math.round(st.code.length / 1024);
      result = '<div class="field" style="margin-top:12px"><label>数据码（' + st.n + ' 题 · 配图 ' + st.imgs + ' 张 · 约 ' +
        (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB') + '）</label>' +
        '<textarea class="input" id="dcodeOut" readonly rows="7" style="word-break:break-all" onclick="this.select()">' + esc(st.code) + '</textarea></div>' +
        '<button class="btn primary block" data-act="dcode:copy">📋 复制数据码</button>' +
        (st.code.length > 300000
          ? '<p class="muted" style="margin:6px 0 0">码比较长，微信发长文本可能被折断。建议改成「只传文字」重新生成，或改用「导出全部数据（JSON）」发文件。</p>'
          : '<p class="muted" style="margin:6px 0 0">复制后用微信/QQ 发给自己（或文件传输助手），另一台设备在「粘贴数据码导入」里粘贴即可。</p>');
    }
    UI.sheet({ title: '生成数据码', body:
      '<p class="muted" style="margin-bottom:10px">把题库打包成一串文字，另一台设备粘贴导入即合并，不用连同一 Wi-Fi、不用上传云端。</p>' +
      '<div class="field"><label>范围</label><div class="chips">' + daysChips + '</div></div>' +
      '<div class="field"><label>配图</label><div class="chips">' +
        '<button class="tag' + (st.withImg ? ' active' : '') + '" data-act="dcode:opt" data-k="withImg" data-v="1">含配图（码大）</button>' +
        '<button class="tag' + (!st.withImg ? ' active' : '') + '" data-act="dcode:opt" data-k="withImg" data-v="0">只传文字（码小）</button></div></div>' +
      '<button class="btn ghost block mt8" data-act="dcode:make">生成数据码</button>' + result });
  }

  async function dcodeGenSheet() {
    S._dc = { withImg: true, days: 0, code: '', n: 0, imgs: 0 };
    dcodeGenDraw();
  }

  /* ---- 导出分版本（新增/全部）+ 草稿随包 ---- */
  function draftForExport(stripImgs) {
    const d = readDraftStore();
    if (!d || !(d.drafts || []).length) return null;
    if (!stripImgs) return d;
    const c = JSON.parse(JSON.stringify(d));
    (c.drafts || []).forEach(function (x) { x.images = []; });
    c.pool = [];
    return c;
  }

  /** 导入时合并草稿：本机没草稿直接用；都有则把导入的接在后面（按文本+答案去重） */
  function mergeImportedDraft(dr) {
    if (!dr || !Array.isArray(dr.drafts) || !dr.drafts.length) return 0;
    const local = readDraftStore();
    if (!local || !Array.isArray(local.drafts) || !local.drafts.length) {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(dr)); } catch (e) { return 0; }
      return dr.drafts.length;
    }
    const seen = {};
    local.drafts.forEach(function (x) { seen[(x.text || '').slice(0, 60) + '|' + (x.answer || '')] = 1; });
    let n = 0, nextNo = local.drafts.length + 1;
    dr.drafts.forEach(function (x) {
      const k = (x.text || '').slice(0, 60) + '|' + (x.answer || '');
      if (seen[k]) return;
      seen[k] = 1;
      x.no = nextNo++;
      local.drafts.push(x);
      n++;
    });
    local.savedAt = Date.now();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(local)); } catch (e) { return 0; }
    return n;
  }

  async function exportSheet() {
    const data = await Store.exportAll();
    const last = Number(localStorage.getItem('tiku.lastExportAt') || 0);
    const imgs = data.questions.reduce(function (n, q) { return n + (q.images || []).length; }, 0);
    const newQs = last ? data.questions.filter(function (q) { return (q.createdAt || 0) > last; }) : [];
    S._exp = { data: data, last: last };
    const when = last
      ? new Date(last).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    const draftN = (function () { const d = readDraftStore(); return d && d.drafts ? d.drafts.length : 0; })();
    let body = '<p class="muted" style="margin-bottom:10px">本机现有 <b>' + data.questions.length + '</b> 道题 · <b>' +
      data.points.length + '</b> 个考点 · 配图 <b>' + imgs + '</b> 张' +
      (draftN ? ' · 未入库草稿 <b>' + draftN + '</b> 道' : '') +
      (last ? '<br>上次导出：' + esc(when) + '，之后新增 <b>' + newQs.length + '</b> 道题' : '<br>还没有导出过') + '</p>';
    if (last && newQs.length) {
      body += '<button class="btn primary block" data-act="data:doExport" data-mode="inc">只导出上次之后新增的（' + newQs.length + ' 题）</button>' +
        '<p class="muted" style="margin:6px 0 10px">推荐：另一端导入时相同的题不会重复进。</p>';
    }
    body += '<button class="btn ' + (last && newQs.length ? 'ghost' : 'primary') + ' block" data-act="data:doExport" data-mode="all">导出全部（' + data.questions.length + ' 题）</button>' +
      '<p class="muted" style="margin:6px 0 0">导出文件里带上草稿（另一端导入后可在首页继续编辑入库）。导出后会记录「本次导出时间」，下次默认只导新增。</p>';
    UI.sheet({ title: '导出数据', body: body });
  }

  function dcodeImportSheet() {
    UI.sheet({ title: '粘贴数据码导入', body:
      '<p class="muted" style="margin-bottom:10px">把另一台设备生成的数据码整段粘贴到下面（微信里长按 → 复制，到这里长按 → 粘贴），点「检查并导入」确认合并。</p>' +
      '<textarea class="input" id="dcodeIn" rows="8" placeholder="粘贴 TK1. 开头的数据码（也支持直接粘贴备份 JSON）"></textarea>' +
      '<button class="btn primary block mt8" data-act="dcode:doImport">检查并导入</button>' +
      '<p class="muted" style="margin:6px 0 0">合并规则：考点按名字归到本机已有考点；题目按编号，新的加入、已有的用码里的版本覆盖。导入的数据只存在本机浏览器里，不上云。</p>' });
  }

  /* =========================================================
   * 云端文字快照同步（只同步文字/考点/删除记录，配图不同步）
   * ======================================================= */
  const SYNC_CURSOR_KEY = 'tiku.sync.cursor';
  const SYNC_HASH_KEY = 'tiku.sync.hash';

  function syncReady() { return !!(window.CloudSync && window.CloudSync.originOk()); }
  function readSyncCursor() {
    try { return JSON.parse(localStorage.getItem(SYNC_CURSOR_KEY) || '{}'); } catch (e) { return {}; }
  }
  function writeSyncCursor(c) {
    try { localStorage.setItem(SYNC_CURSOR_KEY, JSON.stringify(c)); } catch (e) {}
  }

  async function buildSyncPayload() {
    const data = await Store.exportAll();
    const qs = data.questions.map(function (q) {
      const c = Object.assign({}, q);
      delete c.images;      // 配图不进云端
      delete c.assetId;
      return c;
    });
    return { questions: qs, points: data.points, papers: data.papers, deleted: Store.deletions(), savedAt: Date.now() };
  }

  let syncPushTimer = null, syncBusy = false;
  function scheduleSyncPush(delay) {
    if (!syncReady()) return;
    clearTimeout(syncPushTimer);
    syncPushTimer = setTimeout(function () { syncPushNow(); }, delay == null ? 2500 : delay);
  }

  async function syncPushNow() {
    if (!syncReady() || syncBusy) return false;
    syncBusy = true;
    try {
      const payload = await buildSyncPayload();
      const h = window.CloudSync.hashOf(JSON.stringify(payload));
      if (localStorage.getItem(SYNC_HASH_KEY) === h) { S.syncMsg = '内容没变化'; return true; }
      await window.CloudSync.push(payload, h);
      localStorage.setItem(SYNC_HASH_KEY, h);
      if ((payload.deleted || []).length) Store.clearDeletions();
      S.syncMsg = '已上传 ' + payload.questions.length + ' 题（' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）';
      return true;
    } catch (e) {
      S.syncMsg = '上传失败：' + (e.message || e);
      return false;
    } finally {
      syncBusy = false;
    }
  }

  /** 把另一台设备的文字快照并到本机：文字覆盖，配图保留本机的 */
  async function applySyncDoc(doc) {
    const payload = doc && doc.payload;
    if (!payload || !Array.isArray(payload.questions)) return 0;
    const remoteAt = doc.updated_at || 0;

    // 1) 考点：同 norm 复用本机，不重复建
    const localPts = await DB.all('points');
    const byNorm = {};
    localPts.forEach(function (p) { byNorm[p.subject + '|' + p.grade + '|' + (p.norm || p.name)] = p; });
    const remap = {};
    const toAdd = [];
    (payload.points || []).forEach(function (p) {
      if (!p || !p.id) return;
      const key = p.subject + '|' + p.grade + '|' + (p.norm || p.name);
      if (byNorm[key]) remap[p.id] = byNorm[key].id;
      else { byNorm[key] = p; toAdd.push(p); }
    });
    if (toAdd.length) await DB.bulkPut('points', toAdd);

    // 2) 题目：本机更新过的不动；其余用远端文字覆盖，配图保留
    const local = await DB.all('questions');
    const byId = {};
    local.forEach(function (q) { byId[q.id] = q; });
    let n = 0;
    for (const rq of payload.questions) {
      if (!rq || !rq.id) continue;
      const lq = byId[rq.id];
      if (lq && (lq.updatedAt || 0) > (rq.updatedAt || 0)) continue;   // 本机的新，别覆盖
      const next = Object.assign({}, rq);
      if (next.pointId && remap[next.pointId]) next.pointId = remap[next.pointId];
      if (Array.isArray(next.points)) {
        next.points = next.points.map(function (p) {
          return p && remap[p.id] ? Object.assign({}, p, { id: remap[p.id] }) : p;
        });
      }
      next.images = (lq && lq.images) || [];        // 图只认本机的
      next.assetId = (lq && lq.assetId) || '';
      next.fromSync = true;                          // 标记：配图没跟着来
      await DB.put('questions', next);
      n++;
    }

    // 3) 删除记录：另一台删掉的题，本机也删（本机改得更晚的保留）
    for (const id of (payload.deleted || [])) {
      const lq = byId[id];
      if (!lq) continue;
      if ((lq.updatedAt || 0) > remoteAt) continue;
      await DB.del('questions', id);
      n++;
    }
    await Store.Points.recount();
    return n;
  }

  async function syncPullNow(silent) {
    if (!syncReady()) return 0;
    if (syncBusy) return 0;
    let docs;
    syncBusy = true;
    try {
      docs = await window.CloudSync.pull();
    } catch (e) {
      S.syncMsg = '拉取失败：' + (e.message || e);
      return 0;
    } finally {
      syncBusy = false;
    }
    const cursor = readSyncCursor();
    const me = window.CloudSync.deviceId();
    let applied = 0, newest = 0;
    for (const doc of docs) {
      if (!doc || doc.device === me) continue;
      if ((doc.updated_at || 0) <= (cursor[doc.device] || 0)) continue;
      try {
        applied += await applySyncDoc(doc);
        cursor[doc.device] = doc.updated_at || 0;
        newest = Math.max(newest, doc.updated_at || 0);
      } catch (e) {
        S.syncMsg = '合并失败：' + (e.message || e);
      }
    }
    writeSyncCursor(cursor);
    if (newest) S.syncMsg = '已从另一台设备同步（' + new Date(newest).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）';
    if (applied) {
      if (!silent) UI.toast('已同步 ' + applied + ' 处改动', 2600);
      S.cache.homeDraft = null;
      await render();
    }
    return applied;
  }

  function syncStatusHtml() {
    const cs = window.CloudSync;
    if (!cs) return '<p class="muted">同步组件没加载</p>';
    if (!cs.originOk()) {
      return '<p class="small" style="color:var(--warn);line-height:1.7;margin:0 0 8px">' +
        '自动同步需要联网、并从线上地址打开题库（当前是从本地文件打开的，浏览器不允许跨域请求）。<br>' +
        '改用平时打开题库的那个线上链接即可自动同步。</p>';
    }
    const st = cs.status || {};
    return '<p class="small" style="line-height:1.9;margin:0 0 8px">' +
      '设备：<b>' + esc(cs.deviceName()) + '</b>' +
      (st.lastPush ? '<br>上次上传：' + esc(new Date(st.lastPush).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : '') +
      (st.lastPull ? '<br>上次拉取：' + esc(new Date(st.lastPull).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : '') +
      (S.syncMsg ? '<br>' + esc(S.syncMsg) : '') + '</p>';
  }

  PAGES.jp = {
    tab: false,
    topbar() {
      const n = (S.cache.jpQs || []).length;
      const on = S.jpSel.on;
      const sel = Object.keys(S.jpSel.set).length;
      return backBtn() + '<div class="tb-title">讲评<div class="tb-sub">' +
          (on ? '批量选择 · 已选 ' + sel + ' 题' : n + ' 道待讲评') + '</div></div>' +
        (on ? '<button class="tb-btn text" data-act="jp:batch">退出</button>' : '') +
        (!on && n ? '<button class="tb-btn text" data-act="jp:batch">批量</button>' : '') +
        (!on && n ? '<button class="tb-btn text" data-act="jp:tags">' + (S.jpTags ? '隐藏标签' : '显示标签') + '</button>' : '') +
        (!on && n ? '<button class="tb-btn text" data-act="pack:open">生成包</button>' : '');
    },
    async load() {
      const ids = jpLoad();
      const qs = [];
      for (const id of ids) {
        const q = await DB.get('questions', id);
        if (q) qs.push(q);
      }
      if (qs.length !== ids.length) jpSave(qs.map(x => x.id));   // 清掉已删除的题
      S.cache.jpQs = qs;
    },
    html() {
      const qs = S.cache.jpQs || [];
      const last = S.jpLast
        ? '<div class="row between" style="margin:14px 4px 0"><span class="muted" style="font-size:12.5px">刚标了 ' + S.jpLast.ids.length + ' 道已讲评</span>' +
            '<button class="small" style="color:var(--brand);font-weight:600" data-act="jp:undone">↩ 撤回</button></div>'
        : '';
      if (!qs.length) {
        return '<section class="card">' +
          '<div class="empty"><b>还没有要讲评的题</b>在题库 / 全部题目里点题目卡下方的「讲评」按钮加入' +
          (S.jpLast ? '<br>上一批已讲评 ' + S.jpLast.ids.length + ' 道，点下面可以撤回' : '') + '</div>' +
          '<button class="btn primary block mt12" data-act="goto" data-to="bank">去题库选题</button>' +
          (S.jpLast ? '<button class="btn ghost block mt12" data-act="jp:undone">↩ 撤回上次讲评</button>' : '') +
        '</section>';
      }
      const batch = S.jpSel.on;
      return (batch
          ? '<p class="muted" style="margin:2px 4px 10px">勾选这一课已经讲完的题（可多选），点底部「标为已讲评」一次移出讲评单。</p>'
          : '') +
        qs.map(function (q) {
          return questionCard(q, {
            batch: batch, selSet: S.jpSel.set, selAct: 'jp:sel',
            clean: !batch && !S.jpTags,
            extraOps: '<button data-act="jp:cmp" data-id="' + q.id + '">同类对比</button>' +
              '<button class="del" data-act="jp:rm" data-id="' + q.id + '">移出讲评</button>'
          });
        }).join('') +
        (batch
          ? '<div class="bottombar">' +
              '<div class="bb-info">已选<br>' + Object.keys(S.jpSel.set).length + ' 题</div>' +
              '<button class="btn ghost sm" data-act="jp:all">' +
                (qs.length && qs.every(function (q) { return S.jpSel.set[q.id]; }) ? '取消全选' : '全选') + '</button>' +
              '<button class="btn primary sm" data-act="jp:markDone"' + (Object.keys(S.jpSel.set).length ? '' : ' disabled') + '>标为已讲评</button>' +
            '</div>'
          : '<div class="row between wrap" style="margin:16px 4px 0;gap:8px"><span class="muted" style="font-size:12.5px">共 ' + qs.length + ' 道待讲评</span>' +
              '<span class="row" style="gap:10px">' +
                '<button class="small" style="color:var(--ink-3)" data-act="jp:clear">清空讲评单</button>' +
              '</span></div>' + last);
    }
  };

  /* =========================================================
   * 首页
   * ======================================================= */

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
      unitQs.forEach(function (q) { qUnitsOf(q).forEach(function (u) { units[u] = (units[u] || 0) + 1; }); });
      S.cache.home = { stats: stats, recent: recent.slice(0, 4), total: recent.length, units: units };
      // 讲评单数量（首页卡片显示）
      S.cache.jpQs = [];
      for (const id of jpLoad()) {
        const q = await DB.get('questions', id);
        if (q) S.cache.jpQs.push(q);
      }
      // 未完成的导入草稿（确认页没入库就退出的）
      const dr = readDraftStore();
      S.cache.homeDraft = (dr && dr.drafts && dr.drafts.length) ? dr : null;
      // 每日计算（状态由配置 + 今天日期决定，每次进首页重建，代价极小）
      S.cache.dcalc = dcalcBuild();
      if (S.dcalc.tick && !document.getElementById('dcTime')) {
        clearInterval(S.dcalc.tick); S.dcalc.tick = null;
      }
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

        (S.cache.homeDraft
          ? '<section class="card" style="border-left:3px solid var(--brand)">' +
              '<div class="row between"><div>' +
                '<div style="font-weight:700;font-size:14.5px">有未完成的导入草稿 · ' + S.cache.homeDraft.drafts.length + ' 题</div>' +
                '<p class="muted" style="margin-top:2px">保存于 ' + draftTimeStr(S.cache.homeDraft.savedAt) +
                  (S.cache.homeDraft.unit ? ' · ' + esc(S.cache.homeDraft.unit) : '') + '</p>' +
              '</div></div>' +
              '<div class="row mt12" style="gap:8px">' +
                '<button class="btn primary grow sm" data-act="draft:restore">恢复继续入库</button>' +
                '<button class="btn danger-soft grow sm" data-act="draft:discard">丢弃</button>' +
              '</div>' +
            '</section>'
          : '') +

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

        dcalcCardHtml() +

        '<section class="card">' +
          '<div class="card-h"><h3>讲评' + ((S.cache.jpQs || []).length ? ' · ' + S.cache.jpQs.length + ' 题待讲评' : '') + '</h3></div>' +
          ((S.cache.jpQs || []).length
            ? '<p class="muted" style="margin-bottom:8px">课上点开题目「同类对比」，调出同考点 / 同题型的题并排分析。</p>' +
              '<button class="btn primary block" data-act="goto" data-to="jp">去讲评</button>'
            : '<p class="muted" style="margin-bottom:8px">把明天要讲的题加入讲评单，课上直接调出同题型题对比分析。</p>') +
        '</section>' +

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

      // 课时（选填）：先用练习选的章节；没选章节就按题目考点自带的单元列（v1.18.0）
      let lessonChips;
      const guessUnit = s.unit || (function () {
        for (let gi = 0; gi < S.drafts.length; gi++) {
          const u = lessonUnitOfDraft(S.drafts[gi], s);
          if (u) return u;
        }
        return '';
      })();
      if (!guessUnit) {
        lessonChips = '<p class="muted" style="font-size:12px;margin-top:6px">还没选章节，也没有考点带单元：课时可以先在上面框里直接写（如「第2课时」）；题卡的考点选好单元后，这里会自动列出该单元的课时。</p>';
      } else {
        const knownLs = lessonChoices(guessUnit, s.subject, s.grade);
        const fromPoint = !s.unit ? '<p class="muted" style="font-size:12px;margin-top:2px">按考点所属单元「' + esc(guessUnit) + '」列课时</p>' : '';
        lessonChips = fromPoint + (knownLs.length
          ? '<div class="chips mt8">' + knownLs.map(function (L) {
              return '<button class="tag' + (s.lesson === L ? ' active' : '') + '" data-act="confirm:lesson" data-v="' + esc(L) + '">' + esc(L) + '</button>';
            }).join('') + '</div>'
          : '<p class="muted" style="font-size:12px;margin-top:6px">「' + esc(guessUnit) + '」还没配课时——在上面框里直接写课时名即可；也可以在题卡课时标签里点一下新建，或去「我的 → 设置 → 每单元的课时」配好。</p>');
      }

      // 红笔答案检测：红字一般就是这道题的答案，已按位置填到对应题答案框（手写识别仅供参考）
      const redLines = [];
      (s.images || []).forEach(function (im) {
        if (im.redAns && im.redAns.found && im.redAns.text) redLines.push(im.redAns.text);
      });
      const redFilled = S.drafts.filter(function (d) { return d.answerFromRed; }).length;
      const redCard = redLines.length
        ? '<section class="card" style="border-left:3px solid #e5484d;margin-bottom:10px">' +
            '<div class="card-h"><h3>🔍 识别到红笔标记</h3>' +
              '<button class="small" style="color:var(--brand);font-weight:600" data-act="confirm:copyRed">复制</button></div>' +
            '<p class="small muted">' + (redFilled
              ? '已按位置把最可能的红笔答案填到 <b>' + redFilled + ' 道题</b>的答案框（带「✍ 红笔」标记），请逐题核对修改；没填的题就是没识别出来，直接手填即可。'
              : '一般红笔写的是答案，但这次没对上具体题目（手写识别仅供参考），请核对后填到各题的答案框：') + '</p>' +
            '<p style="white-space:pre-wrap;font-size:14px;font-weight:600;color:#b3261e;margin-top:6px">' + esc(redLines.join('\n')) + '</p>' +
          '</section>'
        : '';

      let cards = S.drafts.map(function (d, i) {
        const chipPoint = d.aiPending
          ? '<span class="chip gray">AI 归类中…</span>'
          : '<span class="chip brand tap" data-act="draft:point" data-i="' + i + '">' + esc(d.point || '选择考点') + ' ›</span>';
        const chipWarn = (!d.aiPending && d.needsConfirm)
          ? '<span class="chip warn">待确认</span>' : '';
        const chipRed = d.answerFromRed ? '<span class="chip gray">✍ 红笔</span>' : '';
        // 课时（v1.18.0）：点一下就按这道题（或整批）的单元列课时，没单元就按关键字新建
        const dLesson = d.lesson || s.lesson || '';
        const chipLesson = '<span class="chip gray tap" data-act="draft:lesson" data-i="' + i + '" title="点击选课时">⏱ ' +
          (dLesson ? esc(dLesson) : '<span style="color:var(--warn)">课时待确认</span>') + '</span>';
        const body = [d.text].concat(d.subs || [], d.options || []).join('\n');
        return '<article class="qcard' + (d.needsConfirm && !d.aiPending ? ' needs' : '') + '">' +
          '<div class="qcard-h">' +
            '<span class="qno">' + (d.no || (i + 1)) + '</span>' + chipPoint + chipWarn + chipRed + chipLesson +
            '<span class="chip gray">' + esc(d.type) + '</span>' +
            '<span class="chip gray">难度 ' + d.difficulty + '</span>' +
          '</div>' +
          '<p class="qtext">' + esc(body) + '</p>' +
          '<div class="field mt8" style="margin-bottom:0"><label>答案（选填' + (d.answerFromRed ? ' · 红笔识别，请核对' : '') + '）</label>' +
            '<input class="input" data-draft-ans="' + i + '" value="' + esc(d.answer || '') + '" placeholder="可留空，入库后随时补"></div>' +
          (d.images && d.images.length
            ? '<div class="dimg-list">' + d.images.map(function (src, k) {
                return '<div class="dimg-item"><img src="' + src + '" alt="题目图形">' +
                  '<button class="dimg-x" data-act="draft:rimg" data-i="' + i + '" data-k="' + k + '" aria-label="移除图形">✕</button></div>';
              }).join('') +
              '<p class="muted" style="font-size:12px;margin-top:4px">↑ 题目图形（点 ✕ 移除，点「配图」可换图）</p></div>'
            : '') +
          (d.solution
            ? '<div class="solution-box"><b>解题思路</b>' + esc(d.solution) + '</div>'
            : '') +
          '<div class="qops">' +
            '<button data-act="draft:saveOne" data-i="' + i + '">✓ 保存并入库</button>' +
            '<button data-act="draft:edit" data-i="' + i + '">编辑</button>' +
            ((S.session.imgPool && S.session.imgPool.length)
              ? '<button data-act="draft:imgs" data-i="' + i + '">配图</button>' : '') +
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
        redCard +
        '<section class="card">' +
          '<div class="card-h"><h3>归入章节</h3>' +
            '<span class="row" style="gap:10px">' +
              '<span class="muted" id="unitPicked">' + esc(s.unit || '未选择') + '</span>' +
              '<button class="small" style="color:var(--brand);font-weight:600" data-act="confirm:unitMgr">删除章节</button>' +
            '</span></div>' +
          unitChips +
          '<div class="field mt8"><label>课时（选填，该单元下会按课时归类考点）</label>' +
            '<input class="input" id="batchLesson" placeholder="如：第3课时" value="' + esc(s.lesson || '') + '">' +
          '</div>' +
          lessonChips +
          '<div class="field mt8"><label>作业时间</label>' +
            '<input class="input" id="batchDate" type="date" value="' + esc(s.batchDate || todayStr()) + '">' +
          '</div>' +
          '<div class="field"><label>练习名称</label>' +
            '<input class="input" id="batchName" placeholder="如：数学练习册P23" value="' + esc(s.batchName || '') + '">' +
          '</div>' +
          '<div class="field"><label>练习类型（选填，题库按它筛题）</label><div class="chips wrapv">' +
            CONFIG.practiceTypes.map(function (t) {
              return '<button class="tag' + (s.practiceType === t ? ' active' : '') + '" data-act="confirm:ptype" data-v="' + esc(t) + '">' + esc(t) + '</button>';
            }).join('') +
            '<button class="tag' + (!s.practiceType ? ' active' : '') + '" data-act="confirm:ptype" data-v="">不标注</button>' +
          '</div></div>' +
          '<div class="field"><label>页码（选填，如 P23 就填 23）</label>' +
            '<input class="input" id="batchPage" inputmode="numeric" placeholder="如：23" value="' + esc(s.pageNo || '') + '">' +
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
    },
    after() {
      // 答案填写框（选填）：输入即写回草稿
      document.querySelectorAll('[data-draft-ans]').forEach(function (el) {
        el.addEventListener('input', function () {
          const d = S.drafts[+el.dataset.draftAns];
          if (d) d.answer = el.value;
        });
      });
      // 练习名称 / 作业时间：输入即写回会话，避免弹层操作触发刷新后丢改动
      const bn = document.getElementById('batchName');
      if (bn) {
        bn.addEventListener('focus', function () {
          if (!bn.value && S.session) { bn.value = defaultBatchName(); S.session.batchName = bn.value; }
        });
        bn.addEventListener('input', function () {
          if (S.session) S.session.batchName = bn.value;
        });
      }
      const bd = document.getElementById('batchDate');
      if (bd) {
        bd.addEventListener('change', function () {
          if (S.session) S.session.batchDate = bd.value;
        });
        bd.addEventListener('input', function () {
          if (S.session) S.session.batchDate = bd.value;
        });
      }
      // 课时（选填）：输入即写回会话，弹层操作刷新后不丢
      const bl = document.getElementById('batchLesson');
      if (bl) {
        bl.addEventListener('input', function () {
          if (S.session) S.session.lesson = bl.value.trim();
        });
      }
      // 页码（选填）：输入即写回会话
      const bp = document.getElementById('batchPage');
      if (bp) {
        bp.addEventListener('input', function () {
          if (S.session) S.session.pageNo = bp.value.replace(/^[Pp]\.?\s*/, '').trim();
        });
      }
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
        undoBtnsHtml() +
        '<button class="tb-btn text" data-act="goto" data-to="paper">组卷' + (n ? '·' + n : '') + '</button>' +
        '<button class="tb-btn text" data-act="bank:batch">' + (S.batch.on ? '退出' : '批量') + '</button>' +
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
      // 题库里已经用过的课时自动配对进教材目录（老师可在设置里编辑修改）
      if (b.subject !== '全部' && b.grade !== '全部') {
        try { await syncCatalogLessons(b.subject, b.grade); } catch (e) { /* 配对失败不影响浏览 */ }
      }
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
          '<button class="tag" data-act="goto" data-to="allq">全部题目</button>' +
          '<button class="tag" data-act="goto" data-to="jp">讲评' + (jpLoad().length ? ' · ' + jpLoad().length : '') + '</button>' +
          '<button class="tag" data-act="bank:filter">更多筛选</button>' +
        '</div>' +
        (hasFilter(b)
          ? '<div class="row between" style="margin:2px 4px 8px">' +
              '<span class="row wrap" style="gap:6px">' +
                (b.practice ? '<span class="chip brand">练习：' + esc(b.practice) + '</span>' : '') +
                (b.ptype ? '<span class="chip brand">类型：' + esc(b.ptype) + '</span>' : '') +
                (b.page ? '<span class="chip brand">页码：P' + esc(b.page) + '</span>' : '') +
                (b.unit ? '<span class="chip brand">章节：' + esc(unitLabelOf(b.unit)) + '</span>' : '') +
                (b.lesson ? '<span class="chip brand">课时：' + esc(b.lesson) + '</span>' : '') +
                (b.point ? '<span class="chip brand">考点：' + esc(b.point) + '</span>' : '') +
              '</span>' +
              '<button class="small" style="color:var(--brand);font-weight:600" data-act="bank:clear">清除</button>' +
            '</div>'
          : '') +
        '<div id="bankList">' + bankContentHtml() + '</div>' +
        (S.batch.on ? batchBarHtml() : '');
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
    // 统一走筛选条件（练习名称/类型/页码/单元/课时/考点/题型/难度），每项有选就缩小范围
    qs = filterQuestions(qs, b);
    if (b.multiUnit && b.multiUnit.length) qs = qs.filter(q => qUnitsOf(q).some(u => b.multiUnit.indexOf(u) >= 0));
    if (b.multiPoint && b.multiPoint.length) qs = qs.filter(q => qPointsOf(q).some(p => b.multiPoint.indexOf(p.name) >= 0));
    const browsing = !kw && !hasFilter(b);

    // 1) 搜索 / 筛选 → 题目列表（一题挂多个考点/单元：任一命中即显示）
    if (!browsing) {
      const list = qs;
      S.cache.bankListIds = list.slice(0, 100).map(q => q.id);
      if (!list.length) return '<div class="empty"><b>没有匹配的题目</b>换个条件试试</div>';
      const pickedChips =
        (b.multiUnit && b.multiUnit.length ? b.multiUnit.map(u => '<span class="chip brand">章节：' + esc(u) + '</span>').join('') : '') +
        (b.unit ? '<span class="chip brand">章节：' + esc(unitLabelOf(b.unit)) + '</span>' : '') +
        (b.lesson ? '<span class="chip brand">课时：' + esc(b.lesson) + '</span>' : '') +
        (b.multiPoint && b.multiPoint.length ? b.multiPoint.map(pn => '<span class="chip brand">考点：' + esc(pn) + '</span>').join('') : '') +
        (b.point ? '<span class="chip brand">考点：' + esc(b.point) + '</span>' : '') +
        (b.practice ? '<span class="chip brand">练习：' + esc(b.practice) + '</span>' : '') +
        (b.ptype ? '<span class="chip brand">类型：' + esc(b.ptype) + '</span>' : '') +
        (b.page ? '<span class="chip brand">页码：P' + esc(b.page) + '</span>' : '') +
        (b.type && b.type !== '全部' ? '<span class="chip brand">题型：' + esc(b.type) + '</span>' : '') +
        (b.difficulty ? '<span class="chip brand">难度 ' + esc(b.difficulty) + '</span>' : '');
      const countHtml = '<div class="row between" style="margin:0 4px 8px"><span class="muted">共 ' + list.length + ' 道' +
        (list.length > 100 ? '（显示前 100 道）' : '') + '</span>' +
        (S.batch.on ? '<span class="chip brand">批量模式 · 已选 ' + Object.keys(S.batch.set).length + ' 题</span>' : '') + '</div>' +
        (pickedChips ? '<div class="row wrap" style="gap:6px;margin:0 4px 8px">' + pickedChips + '</div>' : '');
      return countHtml +
        list.slice(0, 100).map(function (q) { return questionCard(q, S.batch.on ? { batch: true } : {}); }).join('');
    }

    // 2) 浏览模式：章节 → 考点（章节顺序按教材目录）；一题挂多个单元时在多个章节下都出现
    const byUnit = {};
    qs.forEach(function (q) {
      qUnitsOf(q).forEach(function (u) { (byUnit[u] = byUnit[u] || []).push(q); });
    });
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
      // 课时（单元下的再分类）：点了某课时只列该课时的考点，不点默认列全部考点
      S.bank.lessonSel = S.bank.lessonSel || {};
      const lessonSel = S.bank.lessonSel[u] || '';
      const lessonOf = function (q) {
        const us = (q.units && q.units.length) ? q.units : (q.unit ? [q.unit] : []);
        const idx = us.indexOf(u);
        if (idx < 0) return '';
        return (q.lessons && q.lessons[idx]) || (idx === 0 && q.lesson) || '';
      };
      const lessonSet = [];
      list.forEach(function (q) {
        const L = lessonOf(q);
        if (L && lessonSet.indexOf(L) < 0) lessonSet.push(L);
      });
      // 目录里给这个单元配好的课时也列出来（还没题的课时点进去是空的，方便对照教学进度）
      Catalog.lessonsOf(S.bank.subject !== '全部' ? S.bank.subject : S.defaults.subject,
        S.bank.grade !== '全部' ? S.bank.grade : S.defaults.grade,
        S.defaults.term, S.defaults.version, u).forEach(function (L) {
        if (L && lessonSet.indexOf(L) < 0) lessonSet.push(L);
      });
      // 排序：数字课时在前（第2 < 第10），「无」排最后
      lessonSet.sort(function (a, b) {
        if (a === '无') return 1;
        if (b === '无') return -1;
        const na = parseInt(String(a).replace(/\D/g, ''), 10), nb = parseInt(String(b).replace(/\D/g, ''), 10);
        if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
        return a.localeCompare(b, 'zh');
      });
      const unassigned = list.filter(function (q) { return unassignedOf(q, u); }).length;
      const effList = lessonSel ? list.filter(function (q) { return lessonOf(q) === lessonSel; }) : list;
      const byPoint = {};
      effList.forEach(function (q) {
        // 一题挂多个考点：在每个考点行下都出现
        qPointsOf(q).forEach(function (p) {
          const key = p.id || 'n:' + p.name;
          const e = byPoint[key] || (byPoint[key] = { id: p.id, name: p.name, count: 0 });
          e.count++;
        });
      });
      const rows = Object.keys(byPoint).map(function (k) {
        const p = byPoint[k];
        return '<div class="list-item" data-act="goto" data-to="point" data-id="' + (p.id || '') + '">' +
          '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div></div>' +
          '<span class="li-n">' + p.count + '</span>' + ARROW + '</div>';
      });
      // 考点多的时候只露 5 行，剩下的上下拖动看（省得把整页撑长、翻单元卡要翻很久）
      const rowsHtml = rows.length > 5
        ? '<div class="unit-points">' + rows.join('') + '</div>' +
          '<p class="muted" style="margin:6px 4px 0;font-size:11.5px">共 ' + rows.length + ' 个考点 · 上下拖动查看全部</p>'
        : rows.join('');
      const lessonChips = lessonSet.length
        ? '<div class="chips" style="margin:8px 0 2px">' +
            '<button class="tag' + (!lessonSel ? ' active' : '') + '" data-act="bank:lesson" data-unit="' + esc(u) + '" data-v="">全部考点</button>' +
            lessonSet.map(function (L) {
              return '<button class="tag' + (lessonSel === L ? ' active' : '') + '" data-act="bank:lesson" data-unit="' + esc(u) + '" data-v="' + esc(L) + '">' + esc(L) + '</button>';
            }).join('') + '</div>'
        : '';
      return '<section class="card">' +
        '<div class="card-h"><h3>' + esc(unitLabelOf(u)) + '</h3>' +
          '<div class="row" style="gap:6px"><span class="muted">' + (lessonSel ? effList.length + ' / ' : '') + list.length + ' 题 · ' +
            Object.keys(byPoint).length + ' 考点' + (lessonSet.length ? ' · ' + lessonSet.length + ' 课时' : '') + '</span>' +
          (unassigned
            ? '<button class="btn ghost sm" data-act="bank:lessonAssign" data-unit="' + esc(u) + '">分配课时 ' + unassigned + '</button>'
            : '<button class="btn ghost sm" data-act="bank:lessonAssign" data-unit="' + esc(u) + '">改课时</button>') +
          '<button class="btn ghost sm" data-act="unit:mergePoints" data-unit="' + esc(u) + '">合并考点</button>' +
          '<button class="btn ghost sm" data-act="unit:paper" data-unit="' + esc(u) + '">组单元卷</button></div></div>' +
        lessonChips +
        (lessonSel && !effList.length
          ? '<div class="empty" style="padding:14px 0">这个课时下还没有题目</div>'
          : rowsHtml) +
      '</section>';
    }).join('');
  }

  /* =========================================================
   * 题库「更多筛选」：一次选完再确认（练习名称 → 类型 / 页码 / 单元 / 课时 / 考点 / 题型 / 难度）
   * 每项都不是必填；选了上级就把下级选项缩小到对应范围。
   * ======================================================= */
  function sheetRedraw(fn) {
    const old = sheetRoot.querySelector('.sheet-b');
    const top = old ? old.scrollTop : 0;
    fn();
    const now = sheetRoot.querySelector('.sheet-b');
    if (now) now.scrollTop = top;
  }

  function distinctVals(qs, fn) {
    const map = {};
    (qs || []).forEach(function (q) {
      [].concat(fn(q) || []).forEach(function (v) {
        if (v === undefined || v === null || v === '') return;
        v = String(v);
        map[v] = (map[v] || 0) + 1;
      });
    });
    return map;
  }

  function practiceLessonsOf(q, unit) {
    if (!unit) return qLessonsOf(q);
    return [qLessonOf(q, unit)].filter(Boolean);
  }

  function sortByCatalog(list) {
    const b = S.bank;
    const sbj = b.subject !== '全部' ? b.subject : S.defaults.subject;
    const gd = b.grade !== '全部' ? b.grade : S.defaults.grade;
    const cat = Catalog.get(sbj, gd, S.defaults.term, S.defaults.version);
    return list.slice().sort(function (x, y) {
      const ix = cat.indexOf(x), iy = cat.indexOf(y);
      if (ix >= 0 && iy >= 0) return ix - iy;
      if (ix >= 0) return -1;
      if (iy >= 0) return 1;
      if (x === '未归类') return 1;
      if (y === '未归类') return -1;
      return x.localeCompare(y, 'zh');
    });
  }

  function sortLessons(list) {
    return list.slice().sort(function (a, b) {
      if (a === '无') return 1;
      if (b === '无') return -1;
      const na = parseInt(String(a).replace(/\D/g, ''), 10), nb = parseInt(String(b).replace(/\D/g, ''), 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return a.localeCompare(b, 'zh');
    });
  }

  function bankFilterDraft() {
    const b = S.bank;
    return {
      practice: b.practice || '', ptype: b.ptype || '', page: b.page || '',
      unit: b.unit || '', lesson: b.lesson || '', point: b.point || '',
      type: b.type || '全部', difficulty: b.difficulty ? String(b.difficulty) : ''
    };
  }

  /** 上级条件变了以后，把已经不存在的下级选择清掉（避免出现「选了课时但那个单元没有这个课时」） */
  function bfClean(f) {
    const all = S.cache.bankQ || [];
    const keep = function (k, keys, fn) {
      if (!f[k]) return;
      const sub = {};
      keys.forEach(function (x) { sub[x] = f[x]; });
      const vals = Object.keys(distinctVals(filterQuestions(all, sub), fn));
      if (vals.indexOf(String(f[k])) < 0) f[k] = '';
    };
    keep('ptype', ['practice'], practiceTypeOf);
    keep('page', ['practice', 'ptype'], pageNoOf);
    keep('unit', ['practice', 'ptype', 'page'], function (q) { return qUnitsOf(q); });
    keep('lesson', ['practice', 'ptype', 'page', 'unit'], function (q) { return practiceLessonsOf(q, f.unit); });
    // 考点列的是全库考点，不做下级清理
  }

  function bankFilterSheet() {
    const f = S._bf || (S._bf = bankFilterDraft());
    bfClean(f);
    const all = S.cache.bankQ || [];
    const sub = function (keys) {
      const o = {};
      keys.forEach(function (k) { o[k] = f[k]; });
      return filterQuestions(all, o);
    };
    const chipRow = function (key, values, labelOf, emptyText) {
      if (!values.length) return '<p class="muted" style="margin:0 2px 6px">' + esc(emptyText || '没有可选项') + '</p>';
      return '<div class="chips wrapv">' +
        '<button class="tag' + (!f[key] ? ' active' : '') + '" data-act="bf:set" data-k="' + key + '" data-v="">不限</button>' +
        values.map(function (v) {
          return '<button class="tag' + (String(f[key]) === String(v) ? ' active' : '') + '" data-act="bf:set" data-k="' + key + '" data-v="' + esc(v) + '">' +
            esc(labelOf ? labelOf(v) : v) + '</button>';
        }).join('') + '</div>';
    };

    const praMap = distinctVals(all, practiceNameOf);
    const practiceVals = Object.keys(praMap).sort(function (a, b) { return praMap[b] - praMap[a]; });
    const typeVals = Object.keys(distinctVals(sub(['practice']), practiceTypeOf));
    const pageVals = Object.keys(distinctVals(sub(['practice', 'ptype']), pageNoOf))
      .sort(function (a, b) { return Number(a) - Number(b); });
    const unitVals = sortByCatalog(Object.keys(distinctVals(sub(['practice', 'ptype', 'page']), function (q) { return qUnitsOf(q); })));
    const lessonVals = sortLessons(Object.keys(distinctVals(sub(['practice', 'ptype', 'page', 'unit']), function (q) {
      return practiceLessonsOf(q, f.unit);
    })));
    // 考点列全部（不受上面条件缩小），保证任何状态下都能选到任意考点
    const pointVals = Object.keys(distinctVals(all, function (q) {
      return qPointsOf(q).map(function (p) { return p.name; });
    })).sort(function (a, b) { return a.localeCompare(b, 'zh'); });

    const kw = S.bank.keyword.trim().toLowerCase();
    const kwList = kw ? all.filter(function (q) {
      return [q.text, q.pointName, q.solution, q.answer, q.type, q.unit].join(' ').toLowerCase().indexOf(kw) >= 0;
    }) : all;
    const hitCount = filterQuestions(kwList, f).length;

    const body =
      '<p class="muted" style="margin:0 2px 10px">每项都可以不选；选了练习名称，练习类型和页码就只列这份练习的；选了单元，课时和考点就只列这个单元的。选好后点下面「确认筛选」一次性生效。</p>' +
      '<div class="field"><label>练习名称</label>' + chipRow('practice', practiceVals, null, '题库里的题还没有练习名称') + '</div>' +
      '<div class="field"><label>练习类型' + (f.practice ? '（' + esc(f.practice) + ' 下）' : '') + '</label>' +
        chipRow('ptype', typeVals, null, '没有练习类型的题（可在题目「编辑」里补）') + '</div>' +
      '<div class="field"><label>页码' + (f.practice ? '（' + esc(f.practice) + ' 下）' : '') + '</label>' +
        chipRow('page', pageVals, function (v) { return 'P' + v; }, '没有页码的题（可在题目「编辑」里补）') + '</div>' +
      '<div class="field"><label>单元</label>' + chipRow('unit', unitVals, function (v) { return unitLabelOf(v); }, '题库里还没有带单元的题') + '</div>' +
      '<div class="field"><label>课时' + (f.unit ? '（' + esc(f.unit) + ' 下）' : '') + '</label>' +
        chipRow('lesson', lessonVals, null, f.unit ? '这个单元的题还没分课时' : '题库里的题还没分课时') + '</div>' +
      '<div class="field"><label>考点（全部考点）<button class="small" style="color:var(--brand);font-weight:600;margin-left:8px" data-act="bf:pointMgr">管理 / 合并 / 删除</button></label>' +
        chipRow('point', pointVals, null, '题库里还没有题目') + '</div>' +
      '<div class="field"><label>题型</label><div class="chips wrapv">' +
        ['全部'].concat(CONFIG.questionTypes).map(function (t) {
          return '<button class="tag' + ((f.type || '全部') === t ? ' active' : '') + '" data-act="bf:set" data-k="type" data-v="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('') + '</div></div>' +
      '<div class="field"><label>难度</label><div class="chips wrapv">' +
        [['', '不限'], ['1', '难度 1'], ['2', '难度 2'], ['3', '难度 3']].map(function (p) {
          return '<button class="tag' + (String(f.difficulty) === p[0] ? ' active' : '') + '" data-act="bf:set" data-k="difficulty" data-v="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div></div>' +
      '<div class="bf-actions">' +
        '<button class="btn ghost" data-act="bf:reset">重置</button>' +
        '<button class="btn primary grow" data-act="bf:apply">确认筛选（' + hitCount + ' 道）</button>' +
      '</div>';
    UI.sheet({ title: '筛选题库', body: body });
  }

  /* ---- 考点管理：全库考点列表，勾选后批量合并 / 批量删除 ---- */
  async function pointMgrSheet() {
    const sbj = S.bank.subject !== '全部' ? S.bank.subject : S.defaults.subject;
    const gd = S.bank.grade !== '全部' ? S.bank.grade : S.defaults.grade;
    const pts = (await DB.all('points')).filter(function (p) { return p.subject === sbj && p.grade === gd; })
      .sort(function (a, b) { return (b.count || 0) - (a.count || 0) || a.name.localeCompare(b.name, 'zh'); });
    S._pm = { pts: pts, sel: {} };
    pointMgrDraw();
  }

  function pointMgrDraw() {
    const st = S._pm;
    if (!st) return;
    const sel = st.sel;
    const n = Object.keys(sel).length;
    const rows = st.pts.map(function (p) {
      const on = !!sel[p.id];
      return '<div class="list-item" data-act="pm:sel" data-id="' + p.id + '">' +
        '<span class="qno" style="' + (on ? 'background:var(--brand);color:#fff' : '') + ';flex-shrink:0">' + (on ? '✓' : '') + '</span>' +
        '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div>' +
        '<div class="li-s">' + (p.count || 0) + ' 题</div></div></div>';
    }).join('');
    const body =
      '<p class="muted" style="margin-bottom:8px">勾选考点后可批量合并（把相近的几个并成一个）或删除（题目一起删，删错不可恢复）。共 ' + st.pts.length + ' 个考点。</p>' +
      '<div style="max-height:46vh;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px">' +
        (rows || '<div class="empty small" style="padding:16px">这个教材还没有考点</div>') + '</div>' +
      '<div class="row" style="gap:8px;margin-top:10px">' +
        '<button class="btn ghost" data-act="pm:all">' + (n && n === st.pts.length ? '清空' : '全选') + '</button>' +
        '<button class="btn soft grow" data-act="pm:merge"' + (n >= 2 ? '' : ' disabled') + '>合并所选（' + n + '）</button>' +
        '<button class="btn danger-soft grow" data-act="pm:del"' + (n ? '' : ' disabled') + '>删除所选（' + n + '）</button>' +
      '</div>';
    UI.sheet({ title: '考点管理', body: body });
  }

  /* =========================================================
   * 全部题目总览页：所有录入题目一页看全，考点/单元/课时标签齐全、配图默认打开
   * ======================================================= */
  PAGES.allq = {
    tab: false,
    topbar() {
      return backBtn() + '<div class="tb-title">全部题目' +
        '<div class="tb-sub">' + ((S.cache.allq || []).length) + ' 道 · 按录入时间倒序</div></div>' +
        undoBtnsHtml();
    },
    async load() {
      const qs = await Store.Questions.list({});
      qs.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      S.cache.allq = qs;
    },
    html() {
      const kw = (S.allqKw || '').trim().toLowerCase();
      let list = S.cache.allq || [];
      if (kw) {
        list = list.filter(function (q) {
          const units = qUnitsOf(q).join(' ');
          const points = qPointsOf(q).map(p => p.name).join(' ');
          const lessons = qLessonsOf(q).join(' ');
          return [q.text, points, units, lessons, q.type, q.answer, q.batchName].join(' ').toLowerCase().indexOf(kw) >= 0;
        });
      }
      const cap = 200;
      const shown = list.slice(0, cap);
      return '' +
        '<div class="search" style="margin:8px 0 10px">' +
          '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
          '<input id="allqSearch" placeholder="搜题干、考点、单元、课时、题型" value="' + esc(S.allqKw || '') + '">' +
        '</div>' +
        '<div class="row between" style="margin:0 4px 8px"><span class="muted">共 ' + list.length + ' 道' +
          (list.length > cap ? '（显示前 ' + cap + ' 道，可搜索缩小范围）' : '') + '</span></div>' +
        '<div id="allqList">' +
          (shown.length
            ? shown.map(function (q) { return questionCard(q); }).join('')
            : '<div class="empty"><b>' + (kw ? '没有匹配的题目' : '题库还是空的') + '</b>' + (kw ? '换个关键词试试' : '去拍一张练习册吧') + '</div>') +
        '</div>';
    },
    after() {
      const input = document.getElementById('allqSearch');
      if (input) {
        input.addEventListener('input', function () {
          S.allqKw = input.value.trim();
          const page = PAGES.allq;
          const list = document.getElementById('allqList');
          if (list) {
            // 与 html() 同一段列表逻辑，就地重渲染
            const kw = S.allqKw.trim().toLowerCase();
            let qs = S.cache.allq || [];
            if (kw) {
              qs = qs.filter(function (q) {
                return [q.text, qPointsOf(q).map(p => p.name).join(' '), qUnitsOf(q).join(' '), qLessonsOf(q).join(' '), q.type, q.answer, q.batchName].join(' ').toLowerCase().indexOf(kw) >= 0;
              });
            }
            const cap = 200;
            list.innerHTML = (qs.slice(0, cap).map(function (q) { return questionCard(q); }).join('')) ||
              '<div class="empty"><b>没有匹配的题目</b>换个关键词试试</div>';
          }
        });
      }
    }
  };

  /** 批量模式底部操作条 */
  function batchBarHtml() {
    const n = Object.keys(S.batch.set).length;
    const ids = S.cache.bankListIds || [];
    const all = ids.length > 0 && ids.every(function (id) { return S.batch.set[id]; });
    return '<div class="bottombar">' +
      '<div class="bb-info">已选<br>' + n + ' 题</div>' +
      '<button class="btn ghost sm" data-act="batch:all">' + (all ? '取消全选' : '全选') + '</button>' +
      '<button class="btn soft sm" data-act="batch:point"' + (n ? '' : ' disabled') + '>改考点</button>' +
      '<button class="btn soft sm" data-act="batch:basket"' + (n ? '' : ' disabled') + '>入组卷</button>' +
      '<button class="btn danger-soft sm" data-act="batch:del"' + (n ? '' : ' disabled') + '>删除</button>' +
      '<button class="btn primary sm" data-act="batch:done">完成</button>' +
    '</div>';
  }

  /** Blob → dataURI（配图添加用） */
  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error('读取图片失败')); };
      r.readAsDataURL(blob);
    });
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
      '<section class="card">' +
        '<div class="card-h"><h3>组卷</h3><span class="muted">按考点 / 单元筛选 · 可锁题型</span></div>' +
        '<button class="btn soft block" data-act="rv:pbuild">🎯 按考点 / 单元组卷</button>' +
        '<p class="muted" style="margin:8px 2px 0">选好考点（或单元）并锁定题型，自动抽题成卷直接打印；也可以先筛出来手动勾题入卷。</p>' +
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
              '</div>'
            : '<button class="btn primary block lg" data-act="review:reveal">显示思路 / 答案</button>') +
          '<button class="btn soft block mt8" data-act="review:gen">举一反三 · 再出几道同类题</button>' +
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

        '<section class="card">' +
          '<div class="card-h"><h3>每单元的课时</h3></div>' +
          '<p class="muted" style="margin-bottom:6px">给单元配上课时后，系统会按考点自动把该单元没课时的题归到对应课时；判断不出的，去题库该单元卡点「分配课时」按考点批量归（可选「无」）。题库里已经用过的课时会自动配对进来。</p>' +
          catList.map(function (u) {
            const ls = Catalog.lessonsOf(S.defaults.subject, S.defaults.grade, S.defaults.term, cv, u);
            return '<div class="row between" style="padding:8px 2px;border-bottom:0.5px solid var(--line);align-items:center;gap:8px">' +
              '<span style="font-size:13.5px;font-weight:600;flex-shrink:0;max-width:40%">' + esc(u) + '</span>' +
              '<span style="flex:1;text-align:right;overflow:hidden">' + (ls.length
                ? '<span class="muted" style="font-size:12.5px">' + esc(ls.join('、')) + '</span>'
                : '<span class="muted" style="font-size:12.5px">未设置课时</span>') + '</span>' +
              '<button class="btn ghost sm" data-act="settings:lessonsEdit" data-unit="' + esc(u) + '">✎ 课时</button></div>';
          }).join('') +
        '</section>' +

        '<div class="sec-title">数据</div>' +
        '<section class="card">' +
          '<div class="card-h"><h3>手机 ↔ 电脑同步</h3></div>' +
          '<button class="btn ghost block" data-act="data:syncUp">备份本机数据到电脑</button>' +
          '<button class="btn ghost block mt8" data-act="data:syncDown">从电脑恢复 / 合并到本机</button>' +
          '<p class="muted mt8">需与电脑连同一 Wi-Fi 且电脑上的服务在运行。恢复采用合并方式：相同题目覆盖为电脑版本，本机新增的题目保留。</p>' +
          '<p class="muted mt8" id="syncSizeLine">数据体积估算中…</p>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-h"><h3>自动同步（只同步文字，不同步配图）</h3></div>' +
          syncStatusHtml() +
          '<button class="btn ghost block" data-act="sync:now">立即同步一次</button>' +
          '<div class="row mt8" style="gap:8px;align-items:center">' +
            '<input class="input" id="syncDevName" value="' + esc((window.CloudSync && window.CloudSync.deviceName()) || '') + '" style="flex:1" placeholder="这台设备叫什么（如 手机 / 办公室电脑）">' +
            '<button class="btn soft" data-act="sync:rename" style="white-space:nowrap">改名</button>' +
          '</div>' +
          '<p class="muted mt8">保存题库后自动把题目文字（含考点、答案、删除记录）写到云端，另一台设备打开就自动并过来；配图体积太大不上云——要看图时，回原来那台设备点「导出数据」，在这台「导入 JSON」把图带过来。</p>' +
        '</section>' +
        '<section class="card">' +
          '<div class="card-h"><h3>数据码同步（不用连同一 Wi-Fi）</h3></div>' +
          '<button class="btn ghost block" data-act="dcode:gen">📤 生成数据码</button>' +
          '<button class="btn ghost block mt8" data-act="dcode:import">📥 粘贴数据码导入</button>' +
          '<p class="muted mt8">手机拍照录的题、电脑导入的题，用一串文字码互相搬：一端生成 → 微信发给自己 → 另一端粘贴导入。适合随时把两端题库合并成一样。同步后的数据都存在各自本机浏览器里，不上云；只有讲评包才上传云端。</p>' +
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
    },
    after() {
      // 同步数据体积预估：帮助判断备份文件大小（题干小，主要是配图 base64）
      Store.exportAll().then(function (data) {
        const el = document.getElementById('syncSizeLine');
        if (!el) return;
        let bytes = 0, imgs = 0;
        try { bytes = JSON.stringify(data).length; } catch (e) { el.textContent = '数据体积估算失败'; return; }
        (data.questions || []).forEach(function (q) { imgs += (q.images || []).length; });
        const mb = bytes / 1048576;
        el.textContent = '当前数据约 ' + (mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB') +
          '（' + (data.questions || []).length + ' 题、' + imgs + ' 张配图）。备份到电脑的容量上限是 500MB，一般远用不满；数据越大备份越慢，属正常现象。';
      });
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

  /* 每日计算一周打印页（复用试卷打印排版：每天一节，可附答案页） */
  function dcPrintHtml(dc, withAnswer) {
    const ansParts = [];
    let body = '';
    dc.days.forEach(function (day, di) {
      let inner = '';
      day.qs.forEach(function (g, i) {
        inner += '<div class="p-q"><span class="p-no">' + (i + 1) + '.</span>' +
          '<span class="p-body">' + Paper.esc(g.q) + ' = ________</span></div>';
        if (withAnswer) {
          ansParts.push('<div class="p-aq"><b>' + day.md + ' ' + day.wd + ' 第' + (i + 1) + '题</b>　答案：' + Paper.esc(g.a) + '</div>');
        }
      });
      body += '<div class="p-sec"><h2>' + Paper.esc(day.md + ' ' + day.wd + ' · 第 ' + day.week + ' 周' + (day.unit ? ' · ' + day.unit : '')) + '</h2>' + inner + '</div>';
    });
    let html = '<div class="paper">' +
      '<h1 class="p-title">' + Paper.esc(dc.title) + '</h1>' +
      '<div class="p-meta">班级：__________　姓名：__________　用时：__________</div>' +
      body + '<div class="p-end">（完）</div>';
    if (withAnswer && ansParts.length) {
      html += '<div class="p-ans-break"></div><div class="p-ans"><h1 class="p-title">参考答案</h1>' + ansParts.join('') + '</div>';
    }
    return html + '</div>';
  }

  PAGES.dcPrint = {
    tab: false,
    topbar() {
      return backBtn() + '<div class="tb-title">每日计算 · 导出</div>' +
        '<button class="tb-btn text noprint" data-act="dcPrint:ans">' + (S._dcPrint && S._dcPrint.ans ? '隐藏答案' : '附答案') + '</button>' +
        '<button class="tb-btn text noprint" data-act="paper:print">打印</button>';
    },
    html() {
      const dc = S._dcPrint || { title: '', days: [] };
      return '<div class="paper-wrap">' + dcPrintHtml(dc, dc.ans) + '</div>' +
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
        unit: '', lesson: '', batchName: '', batchDate: '', stage: 'pick',
        practiceType: '', pageNo: ''
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

  /** 草稿保存时间："11月7日 15:42" */
  function draftTimeStr(ts) {
    const d = new Date(ts || Date.now());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
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

  /** 把文字里的【图N】占位替换掉，并把对应的图收集起来归属到该题
   *  used：按图片序号标记「已被哪道题占用」——同一张图重复出现（Word 里常复制同一个图形）
   *  也各自独立，不会被「去重」判掉（v1.18.0 修的就是这个漏图问题） */
  function stripImageMarkers(it, imgs, used) {
    const foundIdx = [];
    function clean(s) {
      return String(s || '').replace(/【图(\d+)】/g, function (m, n) {
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < imgs.length) {
          if (!used[idx]) { used[idx] = 1; foundIdx.push(idx); }
          return '';
        }
        return m;
      });
    }
    it.text = clean(it.text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    it.subs = (it.subs || []).map(clean);
    it.options = (it.options || []).map(clean);
    // 答案 / 思路里也可能残留占位符（图形印在答案附近时），同样清洗归属
    if (it.answer && it.answer.indexOf('【图') >= 0) it.answer = clean(it.answer).trim();
    if (it.solution && it.solution.indexOf('【图') >= 0) it.solution = clean(it.solution).trim();
    return foundIdx.map(function (i) { return imgs[i]; });
  }

  /** 兜底：没被任何占位符标注的图形，按原文位置配到相邻的题目（防止配图漏掉） */
  function sweepLostImages(rawText, docImgs, drafts, used) {
    if (!drafts.length) return 0;
    let swept = 0;
    docImgs.forEach(function (src, gi) {
      if (used && used[gi]) return;
      const marker = '【图' + (gi + 1) + '】';
      const pos = String(rawText || '').indexOf(marker);
      let target = null;
      if (pos >= 0) {
        // 找占位符前面最近的题号
        const before = String(rawText).slice(0, pos);
        let m, last = null;
        const re = /(?:^|\n)\s*(\d{1,3})\s*[.、．，,]/g;
        while ((m = re.exec(before)) !== null) last = parseInt(m[1], 10);
        if (last != null) target = drafts.find(d => d.no === last) || null;
        if (!target) {
          // 前面没有题号 → 找占位符后面最近的题号
          const after = String(rawText).slice(pos);
          const m2 = after.match(/(?:^|\n)\s*(\d{1,3})\s*[.、．，,]/);
          if (m2) target = drafts.find(d => d.no === parseInt(m2[1], 10)) || null;
        }
      }
      if (!target) target = drafts[0];
      target.images = target.images || [];
      if (target.images.indexOf(src) < 0) { target.images.push(src); swept++; }
      else if (used) used[gi] = 1;
    });
    return swept;
  }

  /** 归一化比较文本（去空格与常见标点），配红笔答案用 */
  function normCmpText(s) {
    return String(s || '').replace(/\s+/g, '').replace(/[，。；：、,.;:！？!?"'“”‘’（）()【】\[\]…—\-_]/g, '').toLowerCase();
  }

  /** 红笔答案 → 每题：红色字一般写在题目附近，按图片里的行位置归到它上面最近的那道题。
   *  返回 { 题目下标: 答案文本 }；没有位置信息时按顺序均分兜底。 */
  function assignRedAnswers(im, items) {
    const reds = (im.redAns && im.redAns.found && (im.redAns.items || []).length)
      ? im.redAns.items.filter(function (x) { return x && x.text; })
      : [];
    if (!reds.length || !items || !items.length) return {};
    const lines = im.lines || [];
    const height = (im.redAns && im.redAns.height) || 0;
    // 1) 每题在图片里的起始 y：按阅读顺序在识别行里找文字匹配
    let li = 0;
    const qy = items.map(function (it) {
      const key = normCmpText(it.text).slice(0, 8);
      if (!key || !lines.length) return null;
      for (let k = li; k < lines.length; k++) {
        const ln = normCmpText(lines[k].text);
        if (ln && (ln.indexOf(key) >= 0 || (ln.length >= 4 && key.indexOf(ln.slice(0, 6)) >= 0))) {
          li = k + 1;
          return lines[k].y;
        }
      }
      return null;
    });
    // 2) 没匹配到位置的题：用已匹配的题线性插值，实在没有就按顺序均分
    const known = [];
    qy.forEach(function (y, i) { if (y != null) known.push(i); });
    qy.forEach(function (y, i) {
      if (y != null) return;
      if (known.length >= 2) {
        const before = known.filter(function (k) { return k < i; }).pop();
        const after = known.filter(function (k) { return k > i; })[0];
        if (before != null && after != null) { qy[i] = qy[before] + (qy[after] - qy[before]) * (i - before) / (after - before); return; }
        if (before != null) { qy[i] = qy[before]; return; }
        if (after != null) { qy[i] = Math.max(0, qy[after] - 1); return; }
      }
      qy[i] = height ? Math.round((i + 0.5) / items.length * height) : i;
    });
    // 3) 每条红字归到「起始位置在它上面且最近」的那道题；同一题多条就拼起来
    const out = {};
    reds.forEach(function (r) {
      let best = 0;
      qy.forEach(function (y, i) { if (y <= r.y) best = i; });
      out[best] = out[best] ? (out[best] + ' ' + r.text) : r.text;
    });
    return out;
  }

  function buildDrafts() {
    const s = S.session;
    const drafts = [];
    // 文档识别出的所有图形汇总成"图形池"，供确认页手动配图 / 删除
    const pool = [];
    s.images.forEach(function (im) {
      (im.docImages || []).forEach(function (src) {
        if (pool.indexOf(src) < 0) pool.push(src);
      });
    });
    s.imgPool = pool;
    const usedImg = {};    // 图片序号 → 已归属（一张图只归一道题；同内容的另一张仍可归别的题）
    s.images.forEach(function (im, idx) {
      if (!im.text) return;
      // 手动粘贴路径没有经过 OCR.tidy，这里统一清洗（幂等，重复调用无副作用）
      const items = Splitter.split(OCR.tidy ? OCR.tidy(im.text) : im.text);
      const docImgs = im.docImages || [];
      // 红笔答案按位置归到对应题（没识别出答案的题留空，等老师填）
      const redAt = assignRedAnswers(im, items);
      items.forEach(function (it, k) {
        const mine = docImgs.length ? stripImageMarkers(it, docImgs, usedImg) : [];
        const redTxt = redAt[k] || '';
        drafts.push({
          key: Util.uid('d'), imgIndex: idx, no: it.no,
          text: it.text, subs: it.subs, options: it.options,
          answer: it.answer || redTxt, solution: it.solution,
          answerFromRed: !it.answer && !!redTxt,
          type: it.type, difficulty: it.difficulty,
          images: mine,
          point: '', pointId: '', confidence: 0, needsConfirm: true, aiPending: true
        });
      });
      // 兜底：被切题流程漏掉的图形按原文位置配到相邻题，确保不漏图
      if (docImgs.length && drafts.length) {
        const swept = sweepLostImages(OCR.tidy ? OCR.tidy(im.text) : im.text, docImgs, drafts, usedImg);
        if (swept) UI.toast(swept + ' 张图形没标到具体题号，已自动配到相邻题目，可在「配图」里调整', 3200);
      }
    });
    // 清理：只有图形没有文字的"空题"，把图形并入相邻题，避免多出空白题
    for (let i = drafts.length - 1; i >= 0; i--) {
      const d = drafts[i];
      const hasText = (d.text || '').trim() || (d.subs || []).join('').trim() ||
        (d.options || []).join('').trim() || (d.answer || '').trim();
      if (!hasText && (d.images || []).length) {
        const to = drafts[i + 1] || drafts[i - 1];
        if (to) {
          d.images.forEach(function (src) {
            if ((to.images || []).indexOf(src) < 0) { to.images = to.images || []; to.images.push(src); }
          });
          drafts.splice(i, 1);
        }
      }
    }
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
        const lay = await OCR.recognizeLayout(im.blob, function (p) {
          im.pct = p;
          updateScanUI();
        });
        im.text = (lay && lay.text) || '';
        im.lines = (lay && lay.lines) || [];   // 行位置：把红笔答案对到具体题目用
        im.status = 'done';
        // 红笔答案识别（tesseract 模式下顺带做）：一般红笔标记的是答案
        if (im.blob && (!CONFIG.ocr.provider || CONFIG.ocr.provider === 'tesseract')) {
          im.redAns = await OCR.redAnswer(im.blob);
          if (im.redAns && im.redAns.found && im.redAns.text) {
            UI.toast('检测到红笔标记，疑似答案（稍后在确认页查看核对）', 2400);
          }
        }
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
    const s = S.session || S.defaults;
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

  /** 单题入库（整批「确认入库」和单题「保存并入库」共用） */
  async function saveDraftOne(d, s, assetId) {
    // 多考点/多单元：一道题可同时挂多个考点、归入多个单元（各考点/单元题库里都能看到）
    const entries = (d.points && d.points.length)
      ? d.points
      : [{ id: d.pointId || '', name: d.point || '未分类', units: d.pointUnit ? [d.pointUnit] : [] }];
    const resolved = [];
    const unitSet = [];
    let primaryUnit = s.unit || '';   // 练习选了章节：这份练习的题默认都归那个单元
    const addUnit = function (u) { if (u && unitSet.indexOf(u) < 0) unitSet.push(u); };
    for (const e of entries) {
      if (e.id) { resolved.push({ id: e.id, name: e.name }); continue; }
      const u0 = (e.units && e.units[0]) || s.unit || '';
      if (!primaryUnit && u0) primaryUnit = u0;
      let pt = { id: '', name: e.name };
      try {
        const r = await resolveUnitPoint(e.name || '未分类', u0, s.subject, s.grade);
        pt = { id: r.point.id, name: r.point.name };
      } catch (err) { /* 解析失败按原名入库 */ }
      resolved.push(pt);
    }
    if (!resolved.length) resolved.push({ id: '', name: '未分类' });
    if (!primaryUnit) primaryUnit = s.unit || '';
    // 没选章节、考点也没带单元信息时，按考点名后缀「·第N单元」把单元补上（课时才有地方落）
    if (!primaryUnit) {
      for (const e of entries) {
        const u0 = (e.units && e.units[0]) || unitSuffixToUnit(e.name, s.subject, s.grade);
        if (u0) { primaryUnit = u0; break; }
      }
    }
    addUnit(primaryUnit);
    addUnit(s.unit);
    entries.forEach(function (e) { (e.units || []).forEach(addUnit); });
    // 课时：确认页填的课时作用于整批练习的主单元；新建考点时选的课时写到对应单元位置
    const batchLesson = (s.lesson || '').trim();
    const lessons = unitSet.map(function (u) { return u === primaryUnit ? batchLesson : ''; });
    entries.forEach(function (e) {
      if (!e.lesson) return;
      (e.units || []).forEach(function (u) {
        const i = unitSet.indexOf(u);
        if (i >= 0 && !lessons[i]) lessons[i] = e.lesson;
      });
    });
    // 单题改过的课时（确认页题卡上的 ⏱ 标签）优先于整批课时
    if (d.lesson) {
      const i0 = unitSet.indexOf(primaryUnit);
      if (i0 >= 0) lessons[i0] = d.lesson;
    }
    await Store.Questions.create({
      subject: s.subject,
      grade: s.grade,
      unit: primaryUnit,
      units: unitSet,
      lesson: lessons.filter(Boolean)[0] || '',
      lessons: lessons,
      batchName: s.batchName || '',
      batchDate: s.batchDate || todayStr(),
      practiceType: s.practiceType || '',
      pageNo: s.pageNo || '',
      pointId: resolved[0].id,
      pointName: resolved[0].name,
      points: resolved,
      type: d.type,
      difficulty: d.difficulty,
      text: d.text,
      options: d.options || [],
      subs: d.subs || [],
      answer: d.answer || '',
      solution: d.solution || '',
      images: (d.images && d.images.length) ? d.images : [],
      assetId: assetId || '',
      confidence: d.confidence,
      needsConfirm: !!d.needsConfirm,
      source: 'ocr'
    });
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
    const pageInput = document.getElementById('batchPage');
    if (pageInput) s.pageNo = pageInput.value.replace(/^[Pp]\.?\s*/, '').trim();
    const lessonInput0 = document.getElementById('batchLesson');
    if (lessonInput0) s.lesson = lessonInput0.value.trim();
    for (const d of S.drafts) {
      await saveDraftOne(d, s, assetIds[d.imgIndex] || '');
      n++;
    }
    await Store.Points.recount();
    S.defaults.subject = s.subject; S.defaults.grade = s.grade; saveDefaults();
    clearSession();
    clearDraftStore();                       // 已入库，草稿作废
    S.cache.homeDraft = null;
    UI.toast('已入库 ' + n + ' 道题');
    await navigate('bank');
  }

  /* =========================================================
   * 考点选择器
   * ======================================================= */
  /** 新建考点时选择归类单元（考点名将带「·第N单元」后缀） */
  function pickUnitForPoint(name, subject, grade) {
    return new Promise(function (resolve) {
      const cat = Catalog.get(subject, grade, S.defaults.term, S.defaults.version);
      const chips = '<div class="chips" style="flex-wrap:wrap;overflow:visible">' +
        '<button class="tag" data-act="pu:pick" data-v="">不归入单元</button>' +
        cat.map(function (u) {
          return '<button class="tag" data-act="pu:pick" data-v="' + esc(u) + '">' + esc(u) + '</button>';
        }).join('') + '</div>';
      UI._resolve = resolve;
      UI.sheet({
        title: '「' + esc(name) + '」归到哪个单元？',
        body: '<p class="muted" style="margin-bottom:10px">选择后考点名会带上「·第N单元」后缀，同单元的题自动归到一起。</p>' + chips
      });
    });
  }

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
            '<input class="input" id="ppNew" placeholder="如：三角形面积求高" style="flex:1" autocomplete="off">' +
            '<button class="btn soft" data-act="pp:polish" style="white-space:nowrap;padding:10px 12px">AI 简短</button>' +
          '</div>' +
          '<div id="ppSug"></div>' +
          '<p class="muted" style="font-size:12px;margin-top:4px">输入随手记的说法，点「AI 简短」自动提炼成简短通顺的考点名</p>' +
        '</div>' +
        '<div class="row" style="gap:8px">' +
          '<button class="btn ghost grow" data-act="pp:cancel">取消</button>' +
          '<button class="btn soft grow" data-act="pp:new">新建并选用</button>' +
        '</div>';

      UI._resolve = function (val) {
        UI._resolve = null;   // 自清理：后续弹层（选单元）会重新赋值
        if (val && !val.id) {
          // 新建考点：先让它选归类单元，再返回（unit 会用于考点名后缀）
          pickUnitForPoint(val.name, subject, grade).then(function (unit) {
            resolve({ name: val.name, id: '', unit: unit || '' });
          });
        } else {
          resolve(val);
        }
      };
      UI.sheet({
        title: '选择考点',
        body: body,
        onMount: function (root) {
          const input = root.querySelector('#ppSearch');
          input.focus();
          input.addEventListener('input', function () {
            const kw = input.value.trim().toLowerCase();
            const filtered = !kw ? points : points.filter(function (p) {
              return (p.name + ' ' + (p.aliases || []).join(' ')).toLowerCase().indexOf(kw) >= 0;
            });
            root.querySelector('#ppList').innerHTML = ppListHtml(filtered, kw);
          });
          // 新建考点输入联想：输入几个字就弹出已有的类似考点，点一下直接选用
          const newInput = root.querySelector('#ppNew');
          const sugBox = root.querySelector('#ppSug');
          newInput.addEventListener('input', function () {
            const kw = newInput.value.trim().toLowerCase();
            if (!kw) { sugBox.innerHTML = ''; return; }
            const hits = points.filter(function (p) {
              const n = p.name.toLowerCase();
              return n !== kw && n.indexOf(kw) >= 0;
            }).slice(0, 8);
            sugBox.innerHTML = hits.length
              ? '<p class="muted" style="margin:8px 2px 4px">已有类似考点（注意所属单元，点一下直接选用）：</p>' +
                '<div class="pp-sug">' + hits.map(function (p) {
                  const pu = (p.units && p.units[0]) || unitSuffixToUnit(p.name, subject, grade);
                  return '<div class="list-item" data-act="pp:pick" data-name="' + esc(p.name) + '" data-id="' + p.id + '">' +
                    '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div>' +
                    '<div class="li-s">' + (p.count || 0) + ' 题' + (pu ? ' · 属于「' + esc(pu) + '」' : '') + '</div></div>' + ARROW + '</div>';
                }).join('') + '</div>'
              : '';
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

  /* ---- 多选考点弹层：输入前几个字联想已有考点，可勾选多个；没得选再新建 ---- */
  /** 核对层拖动排序：按住 ⋮⋮ 上下拖，松手后按新顺序保存（第一位=主分类） */
  function ppmApplyOrder(keys) {
    if (!S._ppm) return;
    const old = S._ppm.sel, nu = {};
    keys.forEach(function (k) { if (old[k]) nu[k] = old[k]; });
    S._ppm.sel = nu;
  }

  function ppmWireDrag(root) {
    if (!root || !S._ppm) return;
    const box = root.querySelector('#ppmPts');
    if (!box) return;
    box.querySelectorAll('.drag-h').forEach(function (h) {
      h.addEventListener('pointerdown', function (ev) {
        if (ev.button != null && ev.button !== 0) return;
        ev.preventDefault();
        const row = h.closest('[data-ptkey]');
        if (!row) return;
        const sb = root.querySelector('.sheet-b');
        const startScroll = sb ? sb.scrollTop : 0;
        row.classList.add('dragging');
        try { h.setPointerCapture(ev.pointerId); } catch (e) { /* 老浏览器忽略 */ }
        const move = function (e) {
          e.preventDefault();
          const rows = Array.prototype.slice.call(box.querySelectorAll('[data-ptkey]')).filter(function (r) { return r !== row; });
          let target = null;
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i].getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) { target = rows[i]; break; }
          }
          if (target) { if (row.nextSibling !== target) box.insertBefore(row, target); }
          else if (box.lastElementChild !== row) box.appendChild(row);
        };
        const up = function () {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          document.removeEventListener('pointercancel', up);
          row.classList.remove('dragging');
          const keys = Array.prototype.slice.call(box.querySelectorAll('[data-ptkey]')).map(function (r) { return r.dataset.ptkey; });
          ppmApplyOrder(keys);
          if (S._ppm) S._ppm.scroll = startScroll;
          if (S._ppm) S._ppm.confirmSheet();
        };
        document.addEventListener('pointermove', move, { passive: false });
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
      });
    });
  }

  function pickPoints(currentNames, subject, grade) {
    return new Promise(async function (resolve) {
      const points = await Store.Points.listBy(subject, grade);
      const sel = {};   // key(id 或 'n:'+name) → {id, name, units:[]}
      (currentNames || []).forEach(function (n) {
        if (!n || n === '未分类') return;
        const hit = points.find(p => p.name === n);
        if (hit) sel[hit.id] = { id: hit.id, name: hit.name, units: (hit.units || []).slice() };
        else sel['n:' + n] = { id: '', name: n, units: [] };
      });
      S._ppm = { sel: sel, subject: subject, grade: grade, resolve: resolve, kw: '', points: points };

      function rowHtml(p) {
        const key = p.id || 'n:' + p.name;
        const on = !!S._ppm.sel[key];
        return '<div class="list-item" data-act="ppm:toggle" data-key="' + esc(key) + '" data-name="' + esc(p.name) + '" data-id="' + (p.id || '') + '"' +
          (on ? ' style="background:var(--brand-soft)"' : '') + '>' +
          '<span class="bcheck' + (on ? ' on' : '') + '"></span>' +
          '<div class="li-main"><div class="li-t">' + esc(p.name) + '</div>' +
          '<div class="li-s">' + (p.count || 0) + ' 题</div></div></div>';
      }
      function listHtml() {
        const kw = (S._ppm.kw || '').trim().toLowerCase();
        // 不输入关键字时不显示已有考点，输入前几个字才联想
        if (!kw) return '<div class="empty small" style="padding:14px">输入考点前几个字联想已有考点；没有匹配的就在下面「＋加入」新建</div>';
        const filtered = S._ppm.points.filter(function (p) {
          return (p.name + ' ' + (p.aliases || []).join(' ')).toLowerCase().indexOf(kw) >= 0;
        });
        let html = filtered.slice(0, 80).map(rowHtml).join('');
        if (!html) html = '<div class="empty small" style="padding:14px">没有匹配的考点，可直接在下面「＋加入」新建</div>';
        return html;
      }
      function footerBtn() {
        const n = Object.keys(S._ppm.sel).length;
        const first = S._ppm.sel[Object.keys(S._ppm.sel)[0]];
        return '<button class="btn primary grow" data-act="ppm:done"' + (n ? '' : ' disabled') + '>✓ 核对并完成（' +
          (n ? '主分类：' + esc(first ? first.name : '') + (n > 1 ? ' 等 ' + n + ' 个考点' : '') : '未选') + '）</button>';
      }
      /* 确认弹层：保存前核对考点（主分类）与单元，可删除错误的项、拖动排序 */
      S._ppm.confirmSheet = function () {
        const keys = Object.keys(S._ppm.sel);
        const unitsSet = [];
        keys.forEach(function (k) {
          (S._ppm.sel[k].units || []).forEach(function (u) { if (u && unitsSet.indexOf(u) < 0) unitsSet.push(u); });
        });
        const ptsHtml = keys.map(function (k, i) {
          const it = S._ppm.sel[k];
          return '<div class="list-item ppm-pt" data-ptkey="' + esc(k) + '"' + (i === 0 ? ' data-first="1"' : '') + '>' +
            '<span class="drag-h" title="按住拖动排序">⋮⋮</span>' +
            '<div class="li-main"><div class="li-t">' + (i === 0 ? '<span class="chip brand" style="margin-right:6px">主分类</span>' : '') + esc(it.name) + '</div>' +
            ((it.units || []).length ? '<div class="li-s">单元：' + esc(it.units.join('、')) + '</div>' : '<div class="li-s">未归入单元</div>') + '</div>' +
            (i > 0 ? '<button class="small" data-act="ppmc:top" data-key="' + esc(k) + '">置顶</button>' : '') +
            '<button class="small del" data-act="ppmc:rm" data-key="' + esc(k) + '">移除</button></div>';
        }).join('');
        const unitsHtml = unitsSet.length
          ? '<div class="chips" style="flex-wrap:wrap;overflow:visible">' + unitsSet.map(function (u) {
              return '<span class="tag active">' + esc(u) + ' <b data-act="ppmc:rmu" data-u="' + esc(u) + '" style="cursor:pointer" title="移除这个单元">✕</b></span>';
            }).join('') + '</div>'
          : '<p class="muted small">不归入单元（题目只按考点归类）</p>';
        UI.sheet({
          title: '确认考点与单元',
          body: '<p class="muted" style="margin-bottom:8px">保存前请核对：<b>第一个考点是主分类</b>（题目卡片显示的就是它）。按住考点左边的 <b>⋮⋮</b> 可以拖动排序，拖到第一位就是主分类；「移除」可删掉不要的考点——<b>新旧考点都在这里，留一个或都留都由你定</b>。</p>' +
            '<div class="field"><label>考点（' + keys.length + ' 个）</label>' +
              '<div id="ppmPts">' + (ptsHtml || '<p class="muted small">还没有考点</p>') + '</div></div>' +
            '<div class="field"><label>归入单元（' + unitsSet.length + ' 个）</label>' + unitsHtml + '</div>' +
            ((S.session && S.session.unit) ? '<p class="muted small">练习章节：' + esc(S.session.unit) + '（这份练习所有题默认都归它，可在页面上修改）</p>' : '') +
            '<div class="row mt12" style="gap:8px">' +
              '<button class="btn ghost grow" data-act="ppmc:back">← 返回修改</button>' +
              '<button class="btn primary grow" data-act="ppmc:save"' + (keys.length ? '' : ' disabled') + '>✓ 完成保存</button>' +
            '</div>',
          onMount: function (root) {
            ppmWireDrag(root);
            if (S._ppm && S._ppm.scroll != null) {
              const b = root.querySelector('.sheet-b');
              if (b) b.scrollTop = S._ppm.scroll;
              S._ppm.scroll = null;
            }
          }
        });
      };
      S._ppm.render = function (keepSearch) {
        UI.sheet({
          title: '选择考点（可多选）',
          body: '<p class="muted" style="margin-bottom:8px">输入考点前几个字联想；点条目勾选，<b>一道题可同时挂多个考点</b>（<b>第一个是主分类</b>，题目卡片上显示的就是它），各考点题库里都能看到它。</p>' +
            '<div class="search" style="margin-bottom:8px">' +
              '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
              '<input id="ppmSearch" placeholder="输入考点前几个字联想" value="' + esc(keepSearch ? S._ppm.kw : '') + '">' +
            '</div>' +
            '<div id="ppmList">' + listHtml() + '</div>' +
            '<div class="field mt12"><label>没有匹配的？直接新建（内容与上方联想框同步）</label>' +
              '<div class="row" style="gap:8px;align-items:center">' +
                '<input class="input" id="ppmNew" placeholder="如：三角形面积求高" style="flex:1" autocomplete="off">' +
                '<button class="btn soft" data-act="ppm:polish" style="white-space:nowrap;padding:10px 12px">AI 简短</button>' +
                '<button class="btn soft" data-act="ppm:addNew" style="white-space:nowrap">＋加入</button>' +
              '</div>' +
            '</div>' +
            '<div class="row mt12" style="gap:8px">' +
              '<button class="btn ghost grow" data-act="ppm:cancel">取消</button>' + footerBtn() +
            '</div>',
          onMount: function (root) {
            const input = root.querySelector('#ppmSearch');
            const newEl = root.querySelector('#ppmNew');
            if (input) {
              if (keepSearch && S._ppm.kw) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
              input.addEventListener('input', function () {
                S._ppm.kw = input.value;
                root.querySelector('#ppmList').innerHTML = listHtml();
                // 联想输入与新建框同步，方便直接续写新建
                if (newEl) newEl.value = input.value;
              });
            }
          }
        });
      };
      S._ppm.render(false);
    });
  }

  /** 新建考点时选择归入单元（可多选）。返回单元数组（可为空数组=不归入）或 null 取消 */
  function pickUnitsForPointMulti(name, subject, grade, presetUnits) {
    return new Promise(function (resolve) {
      const cat = Catalog.get(subject, grade, S.defaults.term, S.defaults.version);
      const picked = {};
      (presetUnits || []).forEach(function (u) { if (cat.indexOf(u) >= 0) picked[u] = 1; });
      const knownLs = knownLessonsOf('');
      const lessonOpts = knownLs.map(function (L) { return '<option value="' + esc(L) + '">'; }).join('');
      function chipsHtml() {
        return '<div class="chips wrapv">' +
          '<button class="tag' + (!Object.keys(picked).length ? ' active' : '') + '" data-act="pu2:none">不归入单元</button>' +
          cat.map(function (u) {
            return '<button class="tag' + (picked[u] ? ' active' : '') + '" data-act="pu2:pick" data-v="' + esc(u) + '">' + esc(u) + '</button>';
          }).join('') + '</div>';
      }
      UI._resolve = resolve;
      function renderSheet() {
        UI.sheet({
          title: '「' + esc(name) + '」归到哪个单元？（可多选）',
          body: '<p class="muted" style="margin-bottom:8px">选择后考点名会带上「·第N单元」后缀（按第一个单元）；勾选多个单元时，题会同时归到这些单元的题库里。</p>' +
            chipsHtml() +
            '<div class="field mt8"><label>课时（选填，单元下按课时归类考点）</label>' +
              '<input class="input" id="puLesson" placeholder="如：第3课时" list="puLessonList">' +
              '<datalist id="puLessonList">' + lessonOpts + '</datalist></div>' +
            '<div class="row mt12" style="gap:8px">' +
              '<button class="btn ghost grow" data-act="pu2:cancel">取消</button>' +
              '<button class="btn primary grow" data-act="pu2:done">✓ 确定</button>' +
            '</div>',
          onMount: function (root) {
            const b = root.querySelector('.sheet-b');   // 绑在每次重建的 body 上，避免监听器累积
            if (!b) return;
            b.addEventListener('click', function (e) {
              const el = e.target.closest('[data-act^="pu2:"]');
              if (!el) return;
              const act = el.dataset.act;
              if (act === 'pu2:pick') {
                const v = el.dataset.v;
                if (picked[v]) delete picked[v]; else picked[v] = 1;
                const box = root.querySelector('.chips.wrapv');
                if (box) box.outerHTML = chipsHtml();
              } else if (act === 'pu2:none') {
                Object.keys(picked).forEach(k => delete picked[k]);
                const box = root.querySelector('.chips.wrapv');
                if (box) box.outerHTML = chipsHtml();
              } else if (act === 'pu2:done') {
                const li = root.querySelector('#puLesson');
                const r = UI._resolve; UI._resolve = null;
                if (r) r({ units: Object.keys(picked), lesson: (li && li.value.trim()) || '' });
              } else if (act === 'pu2:cancel') {
                const r = UI._resolve; UI._resolve = null; if (r) r(null);
              }
            });
          }
        });
      }
      renderSheet();
    });
  }

  /** 确认页图形池弹层：右上角「多选」→ 批量勾选 → 配到本题 / 删除；普通模式单图配到本题 / 删除 */
  function poolOwnerOf(src) {
    let owner = -1;
    S.drafts.forEach(function (dd, di) {
      if (owner < 0 && (dd.images || []).indexOf(src) >= 0) owner = di;
    });
    return owner;
  }

  /** 一个图形只归一道题：先从其他题上摘下来，再配给目标题 */
  function poolAssignSrcs(draftIndex, srcs) {
    const draft = S.drafts[draftIndex];
    if (!draft) return;
    (srcs || []).forEach(function (src) {
      S.drafts.forEach(function (dd) {
        if (dd === draft) return;
        const x = (dd.images || []).indexOf(src);
        if (x >= 0) dd.images.splice(x, 1);
      });
      draft.images = draft.images || [];
      if (draft.images.indexOf(src) < 0) draft.images.push(src);
    });
  }

  function openPoolSheet(i) {
    const s = S.session;
    if (!s) return;
    s.imgPool = s.imgPool || [];
    S.poolSel = S.poolSel || {};
    // 记住当前弹层滚动位置，重渲染后恢复（操作不再跳回顶部）
    const keepScroll = (function () {
      const b = sheetRoot.querySelector('.sheet-b');
      return b ? b.scrollTop : 0;
    })();
    const multi = !!S.poolMulti;
    const n = s.imgPool.length;
    const selCount = Object.keys(S.poolSel).filter(function (k) { return S.poolSel[k]; }).length;
    const tiles = s.imgPool.map(function (src, pi) {
      const owner = poolOwnerOf(src);
      const onThis = owner === i;
      const sel = !!S.poolSel[pi];
      if (multi) {
        // 多选模式：整块可点（命中面积大、不灵敏问题解决），选圈只改样式不重建
        return '<div class="pool-tile selectable' + (sel ? ' sel-on' : '') + (onThis ? ' picked' : '') + '" data-act="dpi:sel" data-i="' + i + '" data-pi="' + pi + '">' +
          '<div class="pool-sel' + (sel ? ' on' : '') + '">' + (sel ? '✓' : '') + '</div>' +
          '<img src="' + src + '" alt="图形' + (pi + 1) + '">' +
          '<span class="pool-tag">' + (onThis ? '✓ 本题' : owner >= 0 ? '第' + (owner + 1) + '题' : '未配置') + '</span>' +
          '</div>';
      }
      return '<div class="pool-tile' + (onThis ? ' picked' : '') + '">' +
        '<img src="' + src + '" alt="图形' + (pi + 1) + '">' +
        '<span class="pool-tag">' + (onThis ? '✓ 本题' : owner >= 0 ? '第' + (owner + 1) + '题' : '未配置') + '</span>' +
        '<div class="pool-ops">' +
          '<button data-act="draft:imgToggle" data-i="' + i + '" data-pi="' + pi + '">' + (onThis ? '取消配图' : '配到本题') + '</button>' +
          '<button class="del" data-act="draft:imgDel" data-pi="' + pi + '">删除</button>' +
        '</div></div>';
    }).join('');
    const head = '<div class="row between" style="margin-bottom:8px;align-items:center">' +
      '<span class="muted">' + (multi ? '多选模式：点图形勾选（再点取消）' : '点右上角「多选」可批量配图 / 批量删除') + '</span>' +
      '<button class="small" style="color:var(--brand);font-weight:600" data-act="dpi:mode" data-i="' + i + '">' +
        (multi ? '✕ 退出多选' : '☑ 多选') + '</button></div>';
    const ops = multi
      ? '<div class="row" style="gap:8px;margin-bottom:10px">' +
          '<button class="btn soft sm" data-act="dpi:all" data-i="' + i + '">' + (n && selCount === n ? '取消全选' : '全选') + '</button>' +
          '<button class="btn primary sm grow" data-act="dpi:assign" data-i="' + i + '"' + (selCount ? '' : ' disabled') + '>配到本题（' + selCount + '）</button>' +
          '<button class="btn danger-soft sm" data-act="dpi:delSel" data-i="' + i + '"' + (selCount ? '' : ' disabled') + '>删除所选</button>' +
        '</div>'
      : '';
    UI.sheet({
      title: '为第 ' + (i + 1) + ' 题配图（池内 ' + n + ' 张）',
      body: head + ops +
        '<div class="pool-grid">' + (tiles || '<div class="empty small" style="padding:14px">图形池是空的，点下面添加本地图片</div>') + '</div>' +
        '<button class="btn ghost block mt12" data-act="dpi:addLocal" data-i="' + i + '">＋ 添加本地图片</button>',
      onMount: function () {
        if (keepScroll) {
          const b = sheetRoot.querySelector('.sheet-b');
          if (b) b.scrollTop = keepScroll;
        }
      }
    });
  }

  /** 多选模式下原地刷新勾选状态（不重建弹层，不丢滚动、不闪烁） */
  function poolSelUIRefresh() {
    const s = S.session;
    const selCount = Object.keys(S.poolSel || {}).filter(function (k) { return S.poolSel[k]; }).length;
    sheetRoot.querySelectorAll('[data-act="dpi:sel"]').forEach(function (el) {
      const on = !!S.poolSel[+el.dataset.pi];
      el.classList.toggle('sel-on', on);
      const c = el.querySelector('.pool-sel');
      if (c) { c.classList.toggle('on', on); c.textContent = on ? '✓' : ''; }
    });
    const ab = sheetRoot.querySelector('[data-act="dpi:assign"]');
    if (ab) { ab.disabled = !selCount; ab.textContent = '配到本题（' + selCount + '）'; }
    const db = sheetRoot.querySelector('[data-act="dpi:delSel"]');
    if (db) db.disabled = !selCount;
    const allBtn = sheetRoot.querySelector('[data-act="dpi:all"]');
    if (allBtn && s) allBtn.textContent = (s.imgPool.length && selCount === s.imgPool.length) ? '取消全选' : '全选';
  }

  /** 已入库题目的配图弹层：点图勾选（可多选批量删）、✕ 单张移除、＋ 添加图片
   *  删图后原地刷新弹层，不回题卡页面。 */
  function qImgsSheet(q) {
    S._qImgId = q.id;
    const imgs = q.images || [];
    const sel = S.imgSel || {};
    const selCount = imgs.filter(function (_, k) { return sel[k]; }).length;
    const list = imgs.map(function (src, k) {
      return '<div class="dimg-item' + (sel[k] ? ' sel-on' : '') + '" data-act="q:imgPick" data-k="' + k + '">' +
        '<span class="dimg-pick' + (sel[k] ? ' on' : '') + '">' + (sel[k] ? '✓' : '') + '</span>' +
        '<img src="' + src + '" alt="题目图形">' +
        '<button class="dimg-x" data-act="q:imgDel" data-id="' + q.id + '" data-k="' + k + '" aria-label="移除图形">✕</button></div>';
    }).join('') || '<div class="empty small" style="padding:14px">这道题还没有图形，点下面按钮添加</div>';
    UI.sheet({
      title: '配图 · ' + (q.pointName || '未分类'),
      body: (q.fromSync && !imgs.length
          ? '<p class="small" style="background:var(--warn-soft,#fff7ed);color:#8a5300;border-radius:8px;padding:8px 10px;line-height:1.7;margin-bottom:8px">这道题是从另一台设备自动同步来的，<b>配图不随自动同步走</b>。要看原图：回原来那台设备点「导出数据」，再到这台设备「导入 JSON」把图带过来。</p>'
          : '') +
        '<p class="muted" data-sheet="imgs" style="margin-bottom:10px">点图片勾选（可多选），再点「删除所选」一次删掉；点右上角 ✕ 只删这一张。删完停在这里，不会跳回题目卡。</p>' +
        '<div>' + list + '</div>' +
        (imgs.length
          ? '<div class="lass-bar">' +
              '<div class="row between" style="margin-bottom:8px">' +
                '<span class="small" style="font-weight:600">已选 ' + selCount + ' 张</span>' +
                '<span class="row" style="gap:8px">' +
                  '<button class="small" style="color:var(--brand);font-weight:600" data-act="q:imgAll" data-v="1">全选</button>' +
                  '<button class="small" style="color:var(--ink-3)" data-act="q:imgAll" data-v="">取消全选</button>' +
                '</span>' +
              '</div>' +
              '<div class="row" style="gap:8px">' +
                '<button class="btn ghost grow" data-act="q:imgAdd" data-id="' + q.id + '">＋ 添加图形</button>' +
                '<button class="btn danger-soft' + (selCount ? ' grow' : '') + '" data-act="q:imgDelSel"' + (selCount ? '' : ' disabled') + '>删除所选' + (selCount ? '（' + selCount + '）' : '') + '</button>' +
              '</div>' +
            '</div>'
          : '<button class="btn ghost block mt12" data-act="q:imgAdd" data-id="' + q.id + '">＋ 添加图形</button>')
    });
  }

  /** 配图弹层原地刷新（保持滚动位置；弹层没开就什么都不做） */
  async function refreshQImgsSheet() {
    const id = S._qImgId;
    if (!id || !sheetRoot.classList.contains('show')) return;
    const fresh = await DB.get('questions', id);
    if (!fresh) return;
    sheetRedraw(function () { qImgsSheet(fresh); });
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

  /** 组卷弹层：按考点/单元多选 + 锁定题型 + 自动抽题 / 手动勾题 */
  function pbuildSheet() {
    const st = S._pbuild;
    if (!st) return;
    const qs = S._pbuildQs || [];
    const unitSet = {}; const pointSet = {};
    qs.forEach(function (q) {
      qUnitsOf(q).forEach(function (u) { if (u !== '未归类') unitSet[u] = 1; });
      qPointsOf(q).forEach(function (p) { if (p.name !== '未分类') pointSet[p.name] = 1; });
    });
    const options = st.mode === 'point' ? Object.keys(pointSet) : Object.keys(unitSet);
    const typeChips = CONFIG.questionTypes.map(function (t) {
      return '<button class="tag' + (st.types[t] ? ' active' : '') + '" data-act="rv:pbT" data-v="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    const selChips = options.map(function (v) {
      return '<button class="tag' + (st.sel[v] ? ' active' : '') + '" data-act="rv:pbSel" data-v="' + esc(v) + '">' + esc(v) + '</button>';
    }).join('');
    UI.sheet({
      title: '组卷 · 按考点 / 单元',
      body: '<div class="field"><label>按什么筛选</label>' +
        '<div class="chips" style="flex-wrap:wrap;overflow:visible">' +
          '<button class="tag' + (st.mode === 'point' ? ' active' : '') + '" data-act="rv:pbMode" data-v="point">按考点</button>' +
          '<button class="tag' + (st.mode === 'unit' ? ' active' : '') + '" data-act="rv:pbMode" data-v="unit">按单元</button>' +
        '</div></div>' +
        '<div class="field"><label>选择' + (st.mode === 'point' ? '考点' : '单元') + '（可多选）</label>' +
          (options.length ? '<div class="chips wrapv">' + selChips + '</div>' : '<p class="muted">题库里还没有可选项目</p>') + '</div>' +
        '<div class="field"><label>锁定题型（可多选，只抽这些题型）</label>' +
          '<div class="chips" style="flex-wrap:wrap;overflow:visible">' + typeChips + '</div></div>' +
        '<div class="field"><label>每种题型抽几道</label>' +
          '<input class="input" type="number" id="rvPer" min="1" max="30" value="' + (st.per || 5) + '"></div>' +
        '<div class="row mt12" style="gap:8px">' +
          '<button class="btn ghost grow" data-act="rv:pbCancel">取消</button>' +
          '<button class="btn soft grow" data-act="rv:pbManual">去手动勾题</button>' +
          '<button class="btn primary grow" data-act="rv:pbAuto">🎯 自动抽题成卷</button>' +
        '</div>'
    });
  }

  /* =========================================================
   * 按单元合并考点（题库浏览模式 · 合并考点按钮）
   * ======================================================= */
  function unitMergeSheet(unit, fresh) {
    const qs = (S.cache.bankQ || []).filter(function (q) { return qUnitsOf(q).indexOf(unit) >= 0; });
    const byPoint = {};
    qs.forEach(function (q) {
      qPointsOf(q).forEach(function (p) {
        if (!p.id) return;   // 没有考点记录的（未分类）不参与合并
        const e = byPoint[p.id] || (byPoint[p.id] = { id: p.id, name: p.name, count: 0 });
        e.count++;
      });
    });
    const list = Object.keys(byPoint).map(function (k) { return byPoint[k]; });
    if (list.length < 2) {
      UI.sheet({ title: '合并考点 · ' + unit, body: '<p class="muted">这个单元里可选的考点少于 2 个，不需要合并。</p>' });
      return;
    }
    // 已选状态只在首次打开时初始化（重渲染时保留勾选）
    if (!S._mergeSel || fresh || S._mergeSel.unit !== unit) {
      S._mergeSel = { unit: unit, picked: {} };
    } else {
      S._mergeSel.unit = unit;
    }
    UI.sheet({
      title: '合并考点 · ' + unit,
      body: '<p class="muted" style="margin-bottom:8px">点选要合并的考点（可多选），下一步选一个作为保留的考点，其余考点的题都会归过去。</p>' +
        '<div class="chips wrapv">' + list.map(function (p) {
          return '<button class="tag' + (S._mergeSel.picked[p.id] ? ' active' : '') + '" data-act="um:sel" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' +
            esc(p.name) + ' · ' + p.count + '</button>';
        }).join('') + '</div>' +
        '<button class="btn primary block mt12" data-act="um:chooseTarget">下一步：选保留的考点</button>'
    });
  }

  function unitMergeTargetSheet() {
    const st = S._mergeSel;
    const ids = Object.keys(st.picked);
    if (ids.length < 2) { UI.toast('至少选 2 个考点才能合并'); return; }
    UI.sheet({
      title: '合并到哪个考点？',
      body: '<p class="muted" style="margin-bottom:8px">选中的考点题目都会归到它名下，其余考点删除（别名保留）。</p>' +
        '<div class="chips wrapv">' + ids.map(function (id) {
          return '<button class="tag" data-act="um:do" data-id="' + esc(id) + '">' + esc(st.picked[id]) + '</button>';
        }).join('') + '</div>' +
        '<button class="btn ghost block mt12" data-act="um:back">← 重选考点</button>'
    });
  }

  /* =========================================================
   * 示例数据：苏教版五年级上册（2026 新教材）配套练习
   * ======================================================= */
  const SEED = [
    /* —— 图形的运动 —— */
    { text: '把一个图形绕某一点旋转 90° 后，什么变了，什么没变？',
      point: '图形的旋转与平移', unit: '图形的运动', batch: '苏教版五上 · P6 练一练',
      solution: '旋转后位置和方向变了，图形的形状、大小都不变。',
      answer: '位置和方向变了，形状、大小不变', type: '应用题', difficulty: 1 },
    { text: '在方格纸上，把三角形向右平移 5 格，再向下平移 3 格。平移后图形的形状和大小改变了吗？',
      point: '图形的旋转与平移', unit: '图形的运动', batch: '苏教版五上 · P8 练习',
      solution: '平移只改变位置，形状、大小不变。',
      answer: '没有改变', type: '应用题', difficulty: 1 },

    /* —— 多边形的面积 —— */
    { text: '一个平行四边形花坛的底是 6 米，高是 4.5 米，它的面积是多少平方米？',
      point: '平行四边形面积', unit: '多边形的面积', batch: '苏教版五上 · P36 练一练',
      solution: 'S=ah，用底×对应的高。',
      answer: '27 平方米', type: '应用题', difficulty: 1 },
    { text: '一块三角形玻璃的面积是 24 平方分米，底是 8 分米，它的高是多少分米？',
      point: '三角形面积求高', unit: '多边形的面积', batch: '苏教版五上 · P40 练一练',
      solution: '由 S=ah÷2 反解 h=2S÷a：先算 24×2=48，再除以 8。',
      answer: '6 分米', type: '应用题', difficulty: 2 },
    { text: '一个梯形上底 3 厘米，下底 7 厘米，高 5 厘米，它的面积是多少平方厘米？',
      point: '梯形面积', unit: '多边形的面积', batch: '苏教版五上 · P42 练一练',
      solution: 'S=(a+b)×h÷2，先算上下底之和，再乘高除以 2。',
      answer: '25 平方厘米', type: '应用题', difficulty: 2 },
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
      answer: '白球的可能性大', type: '应用题', difficulty: 1 },

    /* —— 因数与倍数 —— */
    { text: '在 4、7、12、15、18 这五个数中，哪些数是 3 的倍数？哪些数含有因数 5？',
      point: '因数与倍数', unit: '因数与倍数', batch: '苏教版五上 · P72 练习',
      solution: '用 3、5 逐一试除判断：12、15、18 是 3 的倍数；15 含因数 5。',
      answer: '3 的倍数：12、15、18；含因数 5：15', type: '填空题', difficulty: 1 },
    { text: '两个数的最大公因数是 4，最小公倍数是 24，其中一个数是 8，另一个数是多少？',
      point: '公因数与公倍数', unit: '因数与倍数', batch: '苏教版五上 · 单元测试',
      solution: '两数乘积 = 最大公因数 × 最小公倍数：4×24÷8=12。',
      answer: '12', type: '应用题', difficulty: 3 },

    /* —— 用字母表示数量关系(一) —— */
    { text: '一辆汽车每小时行 v 千米，行了 t 小时。用含有字母的式子表示一共行的千米数；当 v=80、t=3 时，一共行了多少千米？',
      point: '用字母表示数', unit: '用字母表示数量关系(一)', batch: '苏教版五上 · P80 例题',
      solution: '路程=速度×时间，写作 vt；代入 80×3 计算。',
      answer: 'vt；240 千米', type: '填空题', difficulty: 2 },

    /* —— 观察物体(三) —— */
    { text: '用 4 个同样大的正方体摆一个横着的长方体，从正面、上面和侧面看到的分别是什么形状？',
      point: '观察物体', unit: '观察物体(三)', batch: '苏教版五上 · P92 练一练',
      solution: '先摆一摆，再从三个方向逐一观察：正面和上面是长方形，侧面是两个正方形拼成。',
      answer: '正面、上面是长方形，侧面由 2 个正方形拼成（以实际摆法为准）', type: '应用题', difficulty: 1 }
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
  /** 按 cf 分段结果替换第 i 道草稿（draft:split 与编辑保存里的 cf 拆分共用） */
  function splitDraftAt(i, parts) {
    const draft = S.drafts[i];
    if (!draft) return;
    const merged = parts.map(function (p, k) {
      return Object.assign({}, draft, {
        key: Util.uid('d'), no: p.no, text: p.text, subs: p.subs, options: p.options,
        answer: p.answer, solution: p.solution, type: p.type, difficulty: p.difficulty,
        // 配图只留给第一段且各自独立副本：防止拆分后几段共用同一数组，改一段的图影响其他段
        images: k === 0 ? (draft.images || []).slice() : [],
        aiPending: true
      });
    });
    S.drafts.splice.apply(S.drafts, [i, 1].concat(merged));
  }

  const ACTIONS = {
    'goto': function (d) { return navigate(d.to, d.id ? { id: d.id } : {}); },
    'back': back,
    'sheet:close': function () { UI.close(); },
    'dlg:no': function () { UI.close(); const r = UI._resolve; UI._resolve = null; if (r) r(null); },
    'dlg:yes': function () { UI.close(); const r = UI._resolve; UI._resolve = null; if (r) r(true); },
    'dlg:ok': function () {
      const el = document.getElementById('dlgInput');
      const v = el ? el.value : '';
      UI.close();
      const r = UI._resolve; UI._resolve = null; if (r) r(v);
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
        type: '应用题', difficulty: 2, point: '', pointId: '', confidence: 1,
        needsConfirm: true, aiPending: false
      });
      render();
      setTimeout(function () {
        ACTIONS['draft:edit']({ i: String(S.drafts.length - 1) });
      }, 60);
    },
    'draft:lesson': function (d) {
      const i = +d.i;
      const draft = S.drafts[i];
      const s = S.session;
      if (!draft || !s) return;
      const unit = lessonUnitOfDraft(draft, s);
      lessonPickSheet({
        mode: 'draft', i: i, unit: unit,
        unitFrom: (!s.unit && unit) ? (draft.point || '') : '',
        subject: s.subject, grade: s.grade,
        cur: draft.lesson || s.lesson || '',
        text: draft.text
      });
    },
    'draft:edit': function (d) {
      const i = +d.i;
      const draft = S.drafts[i];
      if (!draft) return;
      const body = [draft.text].concat(draft.subs || [], draft.options || []).join('\n');
      const typeOpts = CONFIG.questionTypes.map(function (t) {
        return '<option' + ((draft.type || '') === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('');
      const diffOpts = [1, 2, 3].map(function (n) {
        return '<option value="' + n + '"' + (Number(draft.difficulty) === n ? ' selected' : '') + '>难度 ' + n + '</option>';
      }).join('');
      UI.sheet({
        title: '编辑第 ' + (i + 1) + ' 题',
        body: '<div class="field"><label>题干</label>' +
            '<textarea class="textarea" id="deText" style="min-height:130px">' + esc(body) + '</textarea></div>' +
          '<div class="field"><label>答案（选填）</label>' +
            '<input class="input" id="deAns" value="' + esc(draft.answer || '') + '" placeholder="可留空，入库后随时补"></div>' +
          '<div class="row" style="gap:8px">' +
            '<div class="field" style="flex:1.4;margin:0"><label>题型（可改）</label>' +
              '<select class="select" id="deType">' + typeOpts + '</select></div>' +
            '<div class="field" style="flex:1;margin:0"><label>难度（可改）</label>' +
              '<select class="select" id="deDiff">' + diffOpts + '</select></div>' +
          '</div>' +
          '<div class="field mt8"><div class="row between" style="align-items:center;margin-bottom:2px"><label>解题思路（选填，自动识别的思路可直接清空重写）</label>' +
            '<button class="small muted" data-act="de:clearSol">清空思路</button></div>' +
            '<textarea class="textarea" id="deSol" style="min-height:80px">' + esc(draft.solution || '') + '</textarea></div>' +
          '<div class="row mt12" style="gap:8px">' +
            '<button class="btn ghost grow" data-act="sheet:close">取消</button>' +
            '<button class="btn primary grow" data-act="draft:editSave" data-i="' + i + '">保存修改</button></div>'
      });
    },
    'draft:editSave': async function (d) {
      const i = +d.i;
      const draft = S.drafts[i];
      if (!draft) return;
      const txt = ((document.getElementById('deText') || {}).value || '').trim();
      if (!txt) { UI.toast('题干不能为空'); return; }
      // 编辑里识别到独立一行的 cf → 先问要不要按它拆分；选「取消」就当普通文字保存
      const parts = Splitter.splitByMarker(txt);
      if (parts.length >= 2) {
        const ok = await UI.confirm('识别到独立一行的 cf。要根据它把这道题拆成 ' + parts.length + ' 题吗？\n（取消则把 cf 当普通文字保存）');
        if (ok) {
          UI.close();
          splitDraftAt(i, parts);
          await render();
          await classifyDrafts();
          UI.toast('已拆成 ' + parts.length + ' 题');
          return;
        }
      }
      draft.text = txt;
      draft.subs = []; draft.options = [];
      draft.answer = ((document.getElementById('deAns') || {}).value || '').trim();
      draft.answerFromRed = false;
      const t = (document.getElementById('deType') || {}).value;
      if (t) draft.type = t;
      const df = Number((document.getElementById('deDiff') || {}).value);
      if (df) draft.difficulty = df;
      draft.solution = ((document.getElementById('deSol') || {}).value || '').trim();
      draft.needsConfirm = true;
      UI.close();
      render();
      UI.toast('已保存：' + draft.type + ' · 难度 ' + draft.difficulty);
    },
    'de:clearSol': function () {
      const el = document.getElementById('deSol');
      if (el) { el.value = ''; el.focus(); }
    },
    'qe:clearSol': function () {
      const el = document.getElementById('qeSol');
      if (el) { el.value = ''; el.focus(); }
    },
    'draft:split': async function (d) {
      const i = +d.i;
      const draft = S.drafts[i];
      const body = [draft.text].concat(draft.subs || [], draft.options || []).join('\n');
      const v = await UI.prompt({
        title: '拆分题目', value: body, rows: 8,
        hint: '在需要断开的位置单独输入一行 cf ，保存后按此拆成多题'
      });
      if (!v) return;
      const parts = Splitter.splitByMarker(v);
      if (parts.length < 2) { UI.toast('没有找到 cf 分隔符，未拆分'); return; }
      splitDraftAt(i, parts);
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
      // 被合并题的配图转给上一题（避免图形丢失）
      (cur.images || []).forEach(function (src) {
        prev.images = prev.images || [];
        if (prev.images.indexOf(src) < 0) prev.images.push(src);
      });
      S.drafts.splice(i, 1);
      await render();
    },
    'draft:del': async function (d) {
      S.drafts.splice(+d.i, 1);
      await render();
    },
    /* 单题「保存并入库」：这一题立刻入库并从草稿里移除，其余草稿继续编辑 */
    'draft:saveOne': async function (d) {
      const s = S.session;
      if (!s) return;
      const draft = S.drafts[+d.i];
      if (!draft) return;
      const batchInput = document.getElementById('batchName');
      if (batchInput && batchInput.value.trim()) s.batchName = batchInput.value.trim();
      const dateInput = document.getElementById('batchDate');
      if (dateInput && dateInput.value) s.batchDate = dateInput.value;
      const pageInput = document.getElementById('batchPage');
      if (pageInput) s.pageNo = pageInput.value.replace(/^[Pp]\.?\s*/, '').trim();
      const lessonInput = document.getElementById('batchLesson');
      if (lessonInput) s.lesson = lessonInput.value.trim();
      UI.toast('正在入库…');
      const im = s.images[draft.imgIndex];
      let assetId = '';
      if (im && im.blob) { try { assetId = await Store.Assets.save(im.blob); } catch (e) { /* 存图失败不挡入库 */ } }
      await saveDraftOne(draft, s, assetId);
      const idx = S.drafts.indexOf(draft);
      if (idx >= 0) S.drafts.splice(idx, 1);
      await Store.Points.recount();
      S.defaults.subject = s.subject; S.defaults.grade = s.grade; saveDefaults();
      if (!S.drafts.length) {
        clearSession();
        clearDraftStore();
        S.cache.homeDraft = null;
        UI.toast('已入库，这批题全部完成');
        await navigate('bank');
        return;
      }
      storeDraft();
      UI.toast('已入库 1 道，剩余 ' + S.drafts.length + ' 道继续编辑', 2600);
      await render();
    },

    /* ---- 配图管理（确认页） ---- */
    'draft:imgs': function (d) {
      S.poolMulti = false; S.poolSel = {};
      openPoolSheet(+d.i);
    },
    'dpi:mode': function (d) {
      S.poolMulti = !S.poolMulti;
      if (!S.poolMulti) S.poolSel = {};
      openPoolSheet(+d.i);
    },
    'dpi:sel': function (d) {
      // 多选模式：只切换勾选状态并原地刷新，不重建弹层（不卡顿、不回顶）
      const pi = +d.pi;
      S.poolSel = S.poolSel || {};
      if (S.poolSel[pi]) delete S.poolSel[pi];
      else S.poolSel[pi] = 1;
      poolSelUIRefresh();
    },
    'dpi:all': function (d) {
      const s = S.session;
      if (!s) return;
      S.poolSel = S.poolSel || {};
      const all = s.imgPool.length && s.imgPool.every(function (src, pi) { return S.poolSel[pi]; });
      s.imgPool.forEach(function (src, pi) {
        if (all) delete S.poolSel[pi]; else S.poolSel[pi] = 1;
      });
      poolSelUIRefresh();
    },
    'dpi:assign': async function (d) {
      const i = +d.i;
      const s = S.session;
      const sel = Object.keys(S.poolSel || {}).map(Number).sort(function (a, b) { return a - b; });
      if (!sel.length) { UI.toast('先点图形选中要配的'); return; }
      const srcs = sel.map(function (pi) { return s.imgPool[pi]; }).filter(Boolean);
      poolAssignSrcs(i, srcs);
      S.poolSel = {};
      UI.toast('已把 ' + srcs.length + ' 张图形配给第 ' + (i + 1) + ' 题');
      openPoolSheet(i);
      await render();
    },
    'dpi:delSel': async function (d) {
      const i = +d.i;
      const s = S.session;
      const sel = Object.keys(S.poolSel || {}).map(Number);
      if (!sel.length) { UI.toast('先点图形选中要删除的'); return; }
      const srcs = sel.map(function (pi) { return s.imgPool[pi]; }).filter(Boolean);
      const ok = await UI.confirm('删除选中的 ' + srcs.length + ' 张图形？它们会从所有题和图形列表中移除。');
      if (!ok) return;
      s.imgPool = s.imgPool.filter(function (src) { return srcs.indexOf(src) < 0; });
      S.drafts.forEach(function (dd) {
        dd.images = (dd.images || []).filter(function (src) { return srcs.indexOf(src) < 0; });
      });
      S.poolSel = {};
      if (!s.imgPool.length) { S.poolMulti = false; UI.close(); UI.toast('已删除所选图形'); }
      else openPoolSheet(i);
      await render();
    },
    'dpi:addLocal': function (d) {
      const i = +d.i;
      const s = S.session;
      if (!s) return;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async function () {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        s.imgPool = s.imgPool || [];
        const added = [];
        for (const f of files) {
          try {
            const r = await ImageTool.compress(f);
            const src = await blobToDataURL(r.blob);
            if (s.imgPool.indexOf(src) < 0) s.imgPool.push(src);
            if (added.indexOf(src) < 0) added.push(src);
          } catch (e) {
            UI.toast('有图片处理失败：' + (e.message || e));
          }
        }
        if (added.length) {
          // 新加的图直接配到当前题（独占：先从其他题摘下来）
          poolAssignSrcs(i, added);
        }
        UI.toast('已添加 ' + files.length + ' 张本地图片');
        if (s.imgPool.length) openPoolSheet(i);
        await render();
      };
      input.click();
    },
    'draft:imgToggle': async function (d) {
      const i = +d.i, pi = +d.pi;
      const s = S.session;
      const src = s && s.imgPool ? s.imgPool[pi] : null;
      if (!src || !S.drafts[i]) return;
      const draft = S.drafts[i];
      const k = (draft.images || []).indexOf(src);
      if (k >= 0) {
        draft.images.splice(k, 1);             // 取消配图
      } else {
        poolAssignSrcs(i, [src]);              // 独占配图
      }
      openPoolSheet(i);
      await render();
    },
    'draft:imgDel': async function (d) {
      const pi = +d.pi;
      const s = S.session;
      const src = s && s.imgPool ? s.imgPool[pi] : null;
      if (!src) return;
      const ok = await UI.confirm('删除这个识别出的图形？它会从所有题和图形列表中移除。');
      if (!ok) return;
      s.imgPool.splice(pi, 1);
      S.drafts.forEach(function (dd) {
        const x = (dd.images || []).indexOf(src);
        if (x >= 0) dd.images.splice(x, 1);
      });
      if (!s.imgPool.length) { S.poolMulti = false; UI.close(); }
      else openPoolSheet(+d.i);
      await render();
    },
    'draft:rimg': async function (d) {
      const draft = S.drafts[+d.i];
      if (!draft) return;
      (draft.images || []).splice(+d.k, 1);
      await render();
    },

    /* ---- 每日计算（首页） ---- */
    'dcalc:g': function (d) {
      S.dcalcPick = d.v;
      navigate('home');
    },
    'dcalc:g': function (d) {
      S.dcalcPick = d.v;
      document.querySelectorAll('[data-act="dcalc:g"]').forEach(function (b) {
        b.classList.toggle('active', b.dataset.v === S.dcalcPick);
      });
    },
    'dcalc:k': function (d) {
      const k = d.k;
      const i = S.dcalcKinds.indexOf(k);
      if (i >= 0) S.dcalcKinds.splice(i, 1); else S.dcalcKinds.push(k);
      document.querySelectorAll('[data-act="dcalc:k"]').forEach(function (b) {
        b.classList.toggle('active', S.dcalcKinds.indexOf(b.dataset.k) >= 0);
      });
    },
    'dcalc:allK': function () {
      S.dcalcKinds = DCALC_KINDS.map(function (x) { return x.k; });
      document.querySelectorAll('[data-act="dcalc:k"]').forEach(function (b) { b.classList.add('active'); });
    },
    'dcalc:noneK': function () {
      S.dcalcKinds = [];
      document.querySelectorAll('[data-act="dcalc:k"]').forEach(function (b) { b.classList.remove('active'); });
    },
    'dcalc:diff': function (d) {
      S.dcalcDiff = +d.v || 2;
      document.querySelectorAll('[data-act="dcalc:diff"]').forEach(function (b) {
        b.classList.toggle('active', +b.dataset.v === S.dcalcDiff);
      });
    },
    'dcalc:useBank': function () {
      S.dcalcUseBank = !dcalcUseBankNow();
      navigate('home');
    },
    'dcalc:impCalc': function () {
      const el = document.getElementById('dcCalcFile');
      if (el) el.click(); else UI.toast('请在每日计算设置卡里使用导入按钮');
    },
    /* 拍照识别计算题 → 确认层（可移除）→ 加入我的计算题库 */
    'dcalc:ocrCalc': function () {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async function () {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        let allText = '';
        let fail = 0;
        for (let i = 0; i < files.length; i++) {
          UI.toast('正在识别第 ' + (i + 1) + '/' + files.length + ' 张…', 60000);
          try {
            const r = await ImageTool.compress(files[i]);
            const t = await OCR.recognize(r.blob, null);
            allText += (t || '') + '\n';
          } catch (e) { fail++; }
        }
        const parsed = dcParseCalcText(allText);
        if (!parsed.items.length) {
          UI.toast('没识别出计算式题——需要一步加减乘除或分数式（如 3.6+2.7、1/2+1/4），字迹尽量清晰', 3600);
          return;
        }
        S._dcOcr = { items: parsed.items };
        dcOcrSheet();
        UI.toast('识别完成' + (fail ? '（' + fail + ' 张失败）' : '') + '，请核对后加入', 2600);
      };
      input.click();
    },
    'dcoc:rm': function (d) {
      if (!S._dcOcr) return;
      S._dcOcr.items.splice(+d.i, 1);
      if (!S._dcOcr.items.length) { S._dcOcr = null; UI.close(); UI.toast('已全部移除'); return; }
      dcOcrSheet();
    },
    'dcoc:save': function () {
      if (!S._dcOcr) return;
      const bank = readCalcBank();
      const key = s => String(s || '').replace(/\s/g, '');
      const exists = {}; bank.forEach(it => { exists[key(it.q)] = 1; });
      let added = 0, dup = 0;
      S._dcOcr.items.forEach(function (it) {
        if (exists[key(it.q)]) { dup++; return; }
        bank.push({ q: it.q, a: it.a, at: Date.now() });
        exists[key(it.q)] = 1;
        added++;
      });
      saveCalcBank(bank);
      S._dcOcr = null;
      UI.close();
      UI.toast('已加入 ' + added + ' 道计算题' + (dup ? '，跳过重复 ' + dup + ' 道' : '') + (bank.length >= 300 ? '（题库已达 300 道上限）' : ''), 3000);
      render();
    },
    'dcalc:clearBank': async function () {
      const n = readCalcBank().length;
      if (!n) return;
      const ok = await UI.confirm('清空计算题库', '确定删除已导入的 ' + n + ' 道计算题？此操作不可恢复。');
      if (!ok) return;
      saveCalcBank([]);
      UI.toast('已清空计算题库');
      navigate('home');
    },
    'dcalc:addNote': function () {
      const tEl = document.getElementById('dcNoteText');
      const nEl = document.getElementById('dcNoteN');
      const t = (tEl && tEl.value || '').trim();
      if (!t) { UI.toast('先填写题型备注，再点添加'); return; }
      const n = Math.max(1, Math.min(5, parseInt(nEl && nEl.value, 10) || 1));
      if (!S.dcalcNotes) S.dcalcNotes = [];
      if (S.dcalcNotes.some(function (nt) { return nt.t === t; })) { UI.toast('该备注已存在'); return; }
      S.dcalcNotes.push({ t: t, n: n });
      if (tEl) tEl.value = '';
      const list = document.getElementById('dcNoteList');
      if (list) list.innerHTML = S.dcalcNotes.map(function (nt, i) {
        return '<div class="row between" style="align-items:center;padding:6px 2px;border-bottom:1px dashed var(--line)">' +
          '<span style="font-size:13.5px">📌 ' + esc(nt.t) + ' · <b>每天 ' + nt.n + ' 道</b></span>' +
          '<button class="small" data-act="dcalc:delNote" data-i="' + i + '" style="color:var(--danger)">删除</button></div>';
      }).join('');
    },
    'dcalc:delNote': function (d) {
      if (S.dcalcNotes) S.dcalcNotes.splice(+d.i, 1);
      const list = document.getElementById('dcNoteList');
      if (list) list.innerHTML = S.dcalcNotes.map(function (nt, i) {
        return '<div class="row between" style="align-items:center;padding:6px 2px;border-bottom:1px dashed var(--line)">' +
          '<span style="font-size:13.5px">📌 ' + esc(nt.t) + ' · <b>每天 ' + nt.n + ' 道</b></span>' +
          '<button class="small" data-act="dcalc:delNote" data-i="' + i + '" style="color:var(--danger)">删除</button></div>';
      }).join('');
    },
    'dcalc:preview': async function () {
      // 读当前设置表单 → 采集题库常错计算 → 排出下周一～周五五天 → 预览确认
      const startEl = document.getElementById('dcStart');
      const perEl = document.getElementById('dcPerDay');
      const timerEl = document.getElementById('dcTimerMin');
      const perDay = Math.max(1, Math.min(30, parseInt(perEl && perEl.value, 10) || 5));
      const timerMin = Math.max(1, Math.min(60, parseInt(timerEl && timerEl.value, 10) || 5));
      const kinds = (S.dcalcKinds && S.dcalcKinds.length) ? S.dcalcKinds.slice() : dcDefaultKinds(S.dcalcPick || S.defaults.grade);
      if (!S.dcalcWeak) S.dcalcWeak = await dcCollectWeak();
      S.dcalcDraft = {
        grade: S.dcalcPick || S.defaults.grade,
        startDate: startEl && startEl.value ? startEl.value : '',
        perDay: perDay, timerMin: timerMin, kinds: kinds,
        diff: S.dcalcDiff || 2,
        useBank: dcalcUseBankNow(),
        weak: S.dcalcWeak,
        notes: (S.dcalcNotes || []).slice(),
        planSeed: Date.now()
      };
      S.dcalcPlan = dcBuildPlan(S.dcalcDraft);
      const notes = (S.dcalcWeak.length ? '其中每天第 3 题参考题库<b>常错计算</b>改编。' : '') +
        (dcalcUseBankNow() && readCalcBank().length ? '开启了「我的计算题库」，隔题插入导入的式题。' : '') +
        ((S.dcalcNotes || []).length ? '备注题型<b>' + S.dcalcNotes.map(function (nt) { return esc(nt.t) + '（每天 ' + nt.n + ' 道）'; }).join('、') + '</b>已排在每天最前面。' : '');
      UI.sheet({ title: '一周预览 · 下周一～周五', body: dcalcPlanBody(S.dcalcPlan, 'preview', notes) });
    },
    'dcalc:confirmPlan': async function () {
      const draft = S.dcalcDraft, plan = S.dcalcPlan;
      if (!draft || !plan) return;
      saveDcalcCfg({
        grade: draft.grade, startDate: draft.startDate, semKey: semKeyOf(new Date()),
        kinds: draft.kinds, perDay: draft.perDay, timerMin: draft.timerMin,
        diff: draft.diff || 2, useBank: draft.useBank !== false, weak: draft.weak || [],
        notes: draft.notes || [],
        confirmed: true, planStart: plan.monday, planSeed: draft.planSeed,
        planEdits: plan.edits || {}
      });
      S.dcalcDraft = null; S.dcalcPlan = null;
      S.dcalcKinds = null; S.dcalcWeak = null; S.dcalcDiff = null; S.dcalcUseBank = null; S.dcalcNotes = null;
      S.dcalc.showAns = false;
      if (S.dcalc.tick) { clearInterval(S.dcalc.tick); S.dcalc.tick = null; }
      UI.close();
      UI.toast('已确认！' + plan.mondayMd + '（周一）开始按顺序发布');
      await navigate('home');
    },
    /* 导出 / 打印一周每日计算：预览中的计划优先，否则按已确认配置重排本周 */
    'dcalc:export': async function () {
      let days = null, mondayMd = '';
      if (S.dcalcPlan && S.dcalcPlan.days && S.dcalcPlan.days.length) {
        days = S.dcalcPlan.days; mondayMd = S.dcalcPlan.mondayMd;
      } else {
        const cfg = readDcalcCfg();
        if (!cfg || !cfg.planStart) { UI.toast('还没有可导出的每日计算计划'); return; }
        const base = new Date(cfg.planStart + 'T00:00:00');
        days = [];
        for (let i = 0; i < 5; i++) {
          const d = new Date(base);
          d.setDate(d.getDate() + i);
          const set = dcDaySet(cfg, i, d);
          days.push({ dateKey: dcDateKey(d), wd: '周' + '一二三四五'[i], md: (d.getMonth() + 1) + '月' + d.getDate() + '日', qs: set.qs, week: set.week, unit: set.unit });
        }
        mondayMd = (base.getMonth() + 1) + '月' + base.getDate() + '日';
      }
      S._dcPrint = { title: '每日计算 · ' + mondayMd + '起', days: days, ans: false };
      await navigate('dcPrint');
    },
    'dcPrint:ans': function () {
      if (!S._dcPrint) return;
      S._dcPrint.ans = !S._dcPrint.ans;
      render();
    },
    'dcalc:planView': function () {
      const cfg = readDcalcCfg();
      if (!cfg || !cfg.planStart) return;
      const base = new Date(cfg.planStart + 'T00:00:00');
      const days = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() + i);
        const set = dcDaySet(cfg, i, d);
        days.push({
          dateKey: dcDateKey(d), wd: '周' + '一二三四五'[i],
          md: (d.getMonth() + 1) + '月' + d.getDate() + '日',
          qs: set.qs, week: set.week, unit: set.unit
        });
      }
      UI.sheet({ title: '本周计划 · ' + cfg.grade, body: dcalcPlanBody({ mondayMd: (base.getMonth() + 1) + '月' + base.getDate() + '日', days: days }, 'view') });
    },
    'dcalc:editQ': function (d) {
      const plan = S.dcalcPlan;
      if (!plan) return;
      plan._openDays = dcOpenDays();   // 记下当前展开的天，编辑保存后还停在那里
      dcEditSheet(plan, +d.d, +d.i);
    },
    /* 式子 + 答案 + 题型 + 难度一起保存；答案与式子算出的不一致时先让老师选以哪个为准 */
    'dcalc:editSave': function (d) {
      const plan = S.dcalcPlan;
      if (!plan) return;
      const di = +d.d, i = +d.i;
      const q = (document.getElementById('dcEq').value || '').trim();
      const ansIn = (document.getElementById('dcAnsv').value || '').trim();
      const kindIn = document.getElementById('dcKind').value;
      const diffIn = document.getElementById('dcDiff').value;
      if (!q) { UI.toast('式子不能为空'); return; }
      const computed = dcCalcAnswer(q);
      if (computed === '') { UI.toast('算不出答案：请输入一步加减乘除或分数式（如 3.6+2.7、1/2+1/4）', 2800); return; }
      const norm = function (s) { return String(s).replace(/\s/g, '').replace(/−/g, '-'); };
      if (ansIn && norm(ansIn) !== norm(computed)) {
        // 答案与式子不一致：反推「保留哪个数、系统改另一个数」的精确方案，绝不保存错答案
        dcEditSheet(plan, di, i, {
          warn: '你填的答案是「' + ansIn + '」，原式算出是「' + computed + '」。两边对不上，选一个改法（或改回系统答案）。',
          vals: { q: q, a: ansIn, kindIn: kindIn, diffIn: diffIn, computed: computed },
          fixes: dcSolveFixes(q, ansIn),
          computed: computed
        });
        return;
      }
      dcEditApply(plan, di, i, q, ansIn, kindIn, diffIn);
    },
    /* 选了「保留某个数」：式子换成反推出的新式子（data-q），答案用老师填的。
       保存前再复核一次：新式子必须精确算出所填答案，否则拒绝保存。 */
    'dcalc:editFix': function (d) {
      const plan = S.dcalcPlan;
      if (!plan) return;
      const newQ = String(d.q || '').trim();
      const ansIn = (document.getElementById('dcAnsv').value || '').trim();
      const kindIn = document.getElementById('dcKind').value;
      const diffIn = document.getElementById('dcDiff').value;
      const computed = dcCalcAnswer(newQ);
      if (!newQ || computed === '' || !ansIn || !dcSameNum(computed, ansIn)) {
        UI.toast('这个改法算不出你填的答案，已拦下，请换一个选项', 2800);
        return;
      }
      dcEditApply(plan, +d.d, +d.i, newQ, ansIn, kindIn, diffIn);
    },
    /* 答案与式子不一致时：用系统重算的答案 */
    'dcalc:editSys': function (d) {
      const plan = S.dcalcPlan;
      if (!plan) return;
      dcEditApply(plan, +d.d, +d.i,
        (document.getElementById('dcEq').value || '').trim(),
        '',
        document.getElementById('dcKind').value,
        document.getElementById('dcDiff').value);
    },
    'dcalc:setup': function () {
      S.dcalcKinds = null; S.dcalcWeak = null; S.dcalcDiff = null; S.dcalcUseBank = null; S.dcalcNotes = null;   // 重新打开设置时按已存配置初始化题型
      UI.sheet({ title: '每日计算 · 设置', body: dcalcSetupBody() });
    },
    'dcalc:ans': function () {
      S.dcalc.showAns = !S.dcalc.showAns;
      document.querySelectorAll('.dc-ans').forEach(function (el) {
        el.style.display = S.dcalc.showAns ? '' : 'none';
      });
      const btn = document.querySelector('[data-act="dcalc:ans"]');
      if (btn) btn.textContent = S.dcalc.showAns ? '隐藏答案' : '对答案';
    },
    'dcalc:timer': function () {
      const st = S.dcalc;
      const btn = document.querySelector('[data-act="dcalc:timer"]');
      if (st.tick) {   // 倒计时中 → 停止
        clearInterval(st.tick);
        st.tick = null;
        st.left = Math.max(0, Math.round((st.end - Date.now()) / 1000));
        if (btn) btn.innerHTML = '<span id="dcTime" class="dc-time">' + dcFmtSec(st.left) + '</span> · 倒计时开始';
        UI.toast('已停止，还剩 ' + dcFmtSec(st.left));
        return;
      }
      const cfg = readDcalcCfg() || {};
      st.total = Math.max(1, Math.min(60, cfg.timerMin || 5)) * 60;
      st.end = Date.now() + st.total * 1000;
      st.tick = setInterval(function () {
        const el = document.getElementById('dcTime');
        const left = Math.round((st.end - Date.now()) / 1000);
        if (left <= 0) {
          clearInterval(st.tick); st.tick = null;
          if (el) el.textContent = '00:00';
          UI.toast('⏰ 倒计时结束！');
          const b2 = document.querySelector('[data-act="dcalc:timer"]');
          if (b2) b2.innerHTML = '<span id="dcTime" class="dc-time">' + dcFmtSec(st.total) + '</span> · 倒计时开始';
          return;
        }
        if (el) el.textContent = dcFmtSec(left);
      }, 300);
      if (btn) btn.innerHTML = '<span id="dcTime" class="dc-time">' + dcFmtSec(st.total) + '</span> · 停止';
    },

    /* ---- 草稿：离开确认页的三选 / 首页恢复 ---- */
    'draft:keep': function () { UI.close(); const r = UI._resolve; UI._resolve = null; if (r) r('save'); },
    'draft:drop': function () { UI.close(); const r = UI._resolve; UI._resolve = null; if (r) r('discard'); },
    'draft:stay': function () { UI.close(); const r = UI._resolve; UI._resolve = null; if (r) r(null); },
    'draft:restore': async function () {
      const d = S.cache.homeDraft;
      if (!d || !d.drafts || !d.drafts.length) return;
      S.session = {
        images: [], subject: d.subject || S.defaults.subject, grade: d.grade || S.defaults.grade,
        unit: d.unit || '', batchName: d.batchName || '', batchDate: d.batchDate || '',
        practiceType: d.practiceType || '', pageNo: d.pageNo || '',
        stage: 'confirm', mode: 'photo', imgPool: []
      };
      // 先载入草稿保存的图形池，再合并各题配图（保证后续可重新配图）
      (d.pool || []).forEach(function (src) {
        if (S.session.imgPool.indexOf(src) < 0) S.session.imgPool.push(src);
      });
      // 从草稿图形反推图形池
      d.drafts.forEach(function (x) {
        (x.images || []).forEach(function (src) {
          if (S.session.imgPool.indexOf(src) < 0) S.session.imgPool.push(src);
        });
      });
      S.drafts = d.drafts.map(function (x) {
        return Object.assign({
          key: Util.uid('d'), imgIndex: 0, subs: [], options: [],
          images: [], aiPending: false
        }, x);
      });
      S.aiFallback = '';
      S.cache.homeDraft = null;
      await navigate('confirm');
      await classifyDrafts();
      UI.toast('已恢复草稿（' + S.drafts.length + ' 题）');
    },
    'draft:discard': async function () {
      const ok = await UI.confirm('丢弃这份草稿？丢弃后无法恢复。');
      if (!ok) return;
      clearDraftStore();
      S.cache.homeDraft = null;
      UI.toast('草稿已丢弃');
      await render();
    },
    'draft:point': async function (d) {
      const i = +d.i;
      const s = S.session;
      const draft = S.drafts[i];
      const curNames = (draft.points && draft.points.length)
        ? draft.points.map(p => p.name)
        : (draft.point && draft.point !== '未分类' ? [draft.point] : []);
      const picked = await pickPoints(curNames, s.subject, s.grade);
      if (!picked || !picked.length) return;
      draft.points = picked.map(function (p) { return { id: p.id || '', name: p.name, units: p.units || [] }; });
      draft.point = picked[0].name;
      draft.pointId = picked[0].id || '';
      draft.pointUnit = (picked[0].units && picked[0].units[0]) || '';
      draft.needsConfirm = false;
      await render();
    },
    /* ---- 多选考点弹层 ---- */
    'ppm:toggle': function (d) {
      if (!S._ppm) return;
      if (S._ppm.sel[d.key]) delete S._ppm.sel[d.key];
      else {
        // 勾选已有考点时带上它自己归属的单元（确认层能看到、能核对）
        const hit = (S._ppm.points || []).find(function (p) { return d.id && p.id === d.id; });
        S._ppm.sel[d.key] = { id: d.id || '', name: d.name, units: (hit && hit.units || []).slice() };
      }
      // 原地刷新选中样式与底部计数（不重建弹层、不丢滚动）
      sheetRoot.querySelectorAll('[data-act="ppm:toggle"]').forEach(function (el) {
        const on = !!S._ppm.sel[el.dataset.key];
        el.style.background = on ? 'var(--brand-soft)' : '';
        const c = el.querySelector('.bcheck');
        if (c) c.classList.toggle('on', on);
      });
      const btn = sheetRoot.querySelector('[data-act="ppm:done"]');
      if (btn) {
        const keys = Object.keys(S._ppm.sel);
        const first = S._ppm.sel[keys[0]];
        btn.textContent = '✓ 核对并完成（' + (keys.length
          ? '主分类：' + (first ? first.name : '') + (keys.length > 1 ? ' 等 ' + keys.length + ' 个考点' : '')
          : '未选') + '）';
        btn.disabled = !keys.length;
      }
    },
    'ppm:cancel': function () {
      const r = S._ppm && S._ppm.resolve;
      S._ppm = null;
      UI.close();
      if (r) r(null);
    },
    'ppm:done': function () {
      if (!S._ppm) return;
      if (!Object.keys(S._ppm.sel).length) { UI.toast('先勾选至少一个考点'); return; }
      // 保存前先核对考点与单元（可删除错误的项）
      S._ppm.confirmSheet();
    },
    'ppmc:rm': function (d) {
      if (!S._ppm) return;
      const it = S._ppm.sel[d.key];
      delete S._ppm.sel[d.key];
      if (!Object.keys(S._ppm.sel).length) {
        // 全部移除：回到考点选择层继续勾选
        S._ppm.render(true);
        UI.toast(it ? '已移除：' + it.name + '，请重新勾选考点' : '已全部移除');
        return;
      }
      S._ppm.confirmSheet();
      UI.toast(it ? '已移除：' + it.name : '已移除');
    },
    'ppmc:rmu': function (d) {
      if (!S._ppm) return;
      Object.keys(S._ppm.sel).forEach(function (k) {
        const it = S._ppm.sel[k];
        it.units = (it.units || []).filter(function (u) { return u !== d.u; });
      });
      S._ppm.confirmSheet();
      UI.toast('已从考点单元中移除：' + d.u);
    },
    'ppmc:back': function () {
      if (!S._ppm) return;
      S._ppm.render(true);
    },
    /* 核对层：把某个考点挪到第一位（成为主分类） */
    'ppmc:top': function (d) {
      if (!S._ppm || !S._ppm.sel[d.key]) return;
      const keys = Object.keys(S._ppm.sel).filter(function (k) { return k !== d.key; });
      ppmApplyOrder([d.key].concat(keys));
      S._ppm.confirmSheet();
      const it = S._ppm.sel[d.key];
      UI.toast('已设为主分类：' + (it ? it.name : ''), 2000);
    },
    'ppmc:save': function () {
      if (!S._ppm) return;
      const arr = Object.keys(S._ppm.sel).map(function (k) { return S._ppm.sel[k]; });
      if (!arr.length) { UI.toast('先勾选至少一个考点'); return; }
      const r = S._ppm.resolve;
      S._ppm = null;
      UI.close();
      if (r) r(arr);
    },
    'ppm:polish': async function () {
      const el = document.getElementById('ppmNew');
      const raw = el ? el.value.trim() : '';
      if (!raw) { UI.toast('先输入考点说法，再点「AI 简短」'); return; }
      const btn = document.querySelector('[data-act="ppm:polish"]');
      if (btn) { btn.disabled = true; btn.textContent = '润色中…'; }
      try {
        const out = await AI.polish(raw);
        if (el) el.value = out;
        UI.toast(out ? '已提炼：' + out : '没有提炼出结果', 2200);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'AI 简短'; }
      }
    },
    'ppm:addNew': async function () {
      if (!S._ppm) return;
      const el = document.getElementById('ppmNew');
      const name = el ? el.value.trim() : '';
      if (!name) { UI.toast('请输入考点名'); return; }
      if (S._ppm.sel['n:' + name] || S._ppm.sel[name]) { UI.toast('这个考点已在所选里'); return; }
      // 练习已选章节时默认预选该单元（可再勾选多个，也可保持这一个）；可顺带填课时
      const preset = (S.session && S.session.unit) ? [S.session.unit] : [];
      const r2 = await pickUnitsForPointMulti(name, S._ppm.subject, S._ppm.grade, preset);
      if (r2 === null) return;   // 取消选单元 → 回到考点弹层
      const units = r2.units || [];
      const lesson = r2.lesson || '';
      // 立即创建考点（带单元后缀、走归一化复用已有考点），不等入库
      const u0 = units[0] || '';
      const res = await resolveUnitPoint(name, u0, S._ppm.subject, S._ppm.grade);
      const p = res.point;
      // 插入联想快照：本次弹层内输入前几个字立刻能搜到
      if (!S._ppm.points.some(function (x) { return x.id === p.id; })) S._ppm.points.push(p);
      // 新旧考点都保留：新选的追加在后面，进「核对考点」层后再决定删一个还是都留、拖动调主分类
      S._ppm.sel[p.id] = { id: p.id, name: p.name, units: units, lesson: lesson };
      // 确认页还没选章节时，把这道题默认归入新建考点所选的单元
      if (S.session && !S.session.unit && u0) S.session.unit = u0;
      if (el) el.value = '';
      S._ppm.render(true);
      const n = Object.keys(S._ppm.sel).length;
      UI.toast((res.isNew ? '已新建并选用：' : '已选用：') + p.name + (n > 1 ? '（原有 ' + (n - 1) + ' 个考点保留，核对时可删可留）' : ''), 2800);
    },
    'pp:pick': function (d) {
      const v = { name: d.name, id: d.id };
      UI.close();
      const r = UI._resolve; UI._resolve = null; if (r) r(v);
    },
    'pp:cancel': function () { UI.close(); const r = UI._resolve; UI._resolve = null; if (r) r(null); },
    'pu:pick': function (d) {
      UI.close();
      const r = UI._resolve; UI._resolve = null; if (r) r(d.v);
    },
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
      const r = UI._resolve; UI._resolve = null; if (r) r({ name: name, id: '' });
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
      // 换章节后课时联想跟着变：重建整个确认页（草稿内容已实时写回，不丢）
      render();
    },

    /* 课时（选填）：点联想课时快速填入 */
    'confirm:lesson': function (d) {
      if (!S.session) return;
      S.session.lesson = (S.session.lesson === d.v) ? '' : d.v;
      render();
    },
    'confirm:ptype': function (d) {
      if (!S.session) return;
      S.session.practiceType = (S.session.practiceType === d.v) ? '' : d.v;
      render();
    },

    /* 复制红笔识别出的答案文本 */
    'confirm:copyRed': async function () {
      const s = S.session;
      if (!s) return;
      const lines = [];
      (s.images || []).forEach(function (im) {
        if (im.redAns && im.redAns.found && im.redAns.text) lines.push(im.redAns.text);
      });
      const ok = await copyText(lines.join('\n'));
      UI.toast(ok ? '已复制，可粘贴到各题答案框' : '复制失败，请手动选择文字复制');
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
          points: qPointsOf(q), units: qUnitsOf(q),
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
    'bank:subject': function (d) { S.bank.subject = d.v; S.bank.multiUnit = []; S.bank.multiPoint = []; S.bank.unit = ''; S.bank.lesson = ''; S.bank.point = ''; S._bf = null; render(); },
    'bank:grade': function (d) { S.bank.grade = d.v; S.bank.multiUnit = []; S.bank.multiPoint = []; S.bank.unit = ''; S.bank.lesson = ''; S.bank.point = ''; S._bf = null; render(); },
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
      const qs = (S.cache.bankQ || []).filter(q => qUnitsOf(q).indexOf(d.unit) >= 0);
      if (!qs.length) { UI.toast('这个章节还没有题目'); return; }
      Paper.setIds(qs.map(q => q.id));
      S.paperTitle = d.unit + ' 单元练习';
      UI.toast('已选 ' + qs.length + ' 道题进组卷篮');
      navigate('paper');
    },
    /* ---- 按单元合并考点 ---- */
    'unit:mergePoints': function (d) { unitMergeSheet(d.unit, true); },

    /* 单元卡里的课时切换：点课时只列该课时的考点；再点一次或点「全部考点」恢复 */
    'bank:lesson': function (d) {
      S.bank.lessonSel = S.bank.lessonSel || {};
      if (S.bank.lessonSel[d.unit] === d.v) delete S.bank.lessonSel[d.unit];
      else S.bank.lessonSel[d.unit] = d.v;
      render();
    },

    /* 批量分配课时（按考点）：点课时或「无」，该考点下未分配的题一次归入 */
    'bank:lessonAssign': function (d) { S._lassSel = {}; lessonAssignSheet(d.unit); },
    'bank:lessonEdit': function (d) { lessonEditSheet(d.unit); },

    /* 改课时弹层：切模式 / 勾题 / 全选 / 对所选题目改课时 */
    'bank:lassMode': function (d) { S._lassMode = d.v; sheetRedraw(function () { lessonAssignSheet(d.unit); }); },
    'bank:lassSel': function (d) {
      S._lassSel = S._lassSel || {};
      if (S._lassSel[d.id]) delete S._lassSel[d.id]; else S._lassSel[d.id] = 1;
      sheetRedraw(function () { lessonAssignSheet(S._lassUnit); });
    },
    'bank:lassAll': function (d) {
      const unit = d.unit;
      const qs = (S.cache.bankQ || []).filter(function (q) { return qUnitsOf(q).indexOf(unit) >= 0; });
      S._lassSel = {};
      if (d.v) qs.forEach(function (q) { S._lassSel[q.id] = 1; });
      sheetRedraw(function () { lessonAssignSheet(unit); });
    },
    'bank:lassApply': async function (d) {
      const unit = d.unit, v = d.v;
      const sel = S._lassSel || {};
      const ids = Object.keys(sel).filter(function (id) { return sel[id]; });
      if (!ids.length) { UI.toast('先勾选要改的题（可多选）'); return; }
      const before = await Undo.begin(ids);
      await setLessonForQuestions(ids, unit, v);
      await Undo.end(ids.length + ' 题改课时', before);
      S._lassSel = {};
      UI.toast('已把 ' + ids.length + ' 道题的课时改成「' + (v === '无' ? '无' : v) + '」', 2400);
      try {
        await PAGES.bank.load();
        const fq = (S.cache.bankQ || []).find(function (q) { return qUnitsOf(q).indexOf(unit) >= 0; });
        if (fq && (S.bank.subject === '全部' || S.bank.grade === '全部')) {
          await syncCatalogLessons(fq.subject, fq.grade);
        }
      } catch (e) { /* 保底不阻断 */ }
      sheetRedraw(function () { lessonAssignSheet(unit); });
      await render();
    },

    /* 修改已分配的课时：该考点在这个单元下的题整批改成新课时（覆盖旧的） */
    'bank:reassignLesson': async function (d) {
      const unit = d.unit, v = d.v, pname = d.point;
      const targets = (S.cache.bankQ || []).filter(function (q) {
        return qUnitsOf(q).indexOf(unit) >= 0 &&
          qPointsOf(q).some(function (p) { return p.name === pname; });
      });
      const before = await Undo.begin(targets.map(function (q) { return q.id; }));
      await setLessonForQuestions(targets.map(function (q) { return q.id; }), unit, v);
      await Undo.end(targets.length + ' 题改课时', before);
      UI.toast(targets.length ? '已把 ' + targets.length + ' 道题的课时改成「' + v + '」' : '没有需要处理的题', 2400);
      try {
        await PAGES.bank.load();
        const fq = targets[0];
        if (fq && (S.bank.subject === '全部' || S.bank.grade === '全部')) {
          await syncCatalogLessons(fq.subject, fq.grade);
        }
      } catch (e) { /* 保底不阻断 */ }
      sheetRedraw(function () { lessonAssignSheet(unit); });
      await render();
    },

    'bank:assignLesson': async function (d) {
      const unit = d.unit, v = d.v, pname = d.point;
      const targets = (S.cache.bankQ || []).filter(function (q) {
        return qUnitsOf(q).indexOf(unit) >= 0 && unassignedOf(q, unit) &&
          qPointsOf(q).some(function (p) { return p.name === pname; });
      });
      const before = await Undo.begin(targets.map(function (q) { return q.id; }));
      await setLessonForQuestions(targets.map(function (q) { return q.id; }), unit, v);
      await Undo.end(targets.length + ' 题分配课时', before);
      UI.toast(targets.length ? '已把 ' + targets.length + ' 道题归到「' + v + '」' : '没有需要处理的题', 2400);
      // 刷新题库缓存（顺带把新课时配对进目录）后重开弹层
      try {
        await PAGES.bank.load();
        // 题库筛选是「全部」时 load() 不知道科目，用被分配题目自己的科目/年级补一次配对
        const fq = targets[0];
        if (fq && (S.bank.subject === '全部' || S.bank.grade === '全部')) {
          await syncCatalogLessons(fq.subject, fq.grade);
        }
      } catch (e) { /* 保底不阻断 */ }
      sheetRedraw(function () { lessonAssignSheet(unit); });
      await render();
    },
    'um:sel': function (d) {
      if (!S._mergeSel) return;
      if (S._mergeSel.picked[d.id]) delete S._mergeSel.picked[d.id];
      else S._mergeSel.picked[d.id] = d.name;
      unitMergeSheet(S._mergeSel.unit);
    },
    'um:chooseTarget': function () { unitMergeTargetSheet(); },
    'um:back': function () { unitMergeSheet(S._mergeSel.unit); },
    'um:do': async function (d) {
      const st = S._mergeSel;
      if (!st) return;
      const fromIds = Object.keys(st.picked).filter(function (x) { return x !== d.id; });
      if (!fromIds.length) { UI.toast('请选至少两个不同的考点'); return; }
      const targetName = st.picked[d.id];
      UI.close();
      for (const from of fromIds) {
        try { await Store.Points.merge(from, d.id); }
        catch (e) { UI.toast('合并失败：' + e.message); }
      }
      S._mergeSel = null;
      await Store.Points.recount();
      UI.toast('已合并到「' + targetName + '」（' + fromIds.length + ' 个考点并入）');
      await render();
    },
    'bank:status': function (d) { S.bank.status = d.v; render(); },
    'bank:clear': function () {
      const b = S.bank;
      b.keyword = ''; b.unit = ''; b.point = ''; b.lesson = '';
      b.practice = ''; b.ptype = ''; b.page = '';
      b.type = '全部'; b.difficulty = '';
      b.multiUnit = []; b.multiPoint = [];
      S._bf = null;
      S.batch.on = false; S.batch.set = {};
      render();
    },
    'bank:confirmList': function () {
      if (S.page !== 'bank') { S.bank.status = 'confirm'; navigate('bank'); return; }
      S.bank.status = S.bank.status === 'confirm' ? '全部' : 'confirm'; render();
    },
    /* 筛选弹层：所有条件先存草稿，点「确认筛选」才一次性生效（选完一个不会退出弹层） */
    'bank:filter': function () { S._bf = bankFilterDraft(); bankFilterSheet(); },
    'bf:set': function (d) {
      if (!S._bf) S._bf = bankFilterDraft();
      const k = d.k, v = d.v || '';
      if (k === 'type') S._bf.type = v || '全部';
      else S._bf[k] = (String(S._bf[k] || '') === String(v)) ? '' : v;
      bfClean(S._bf);
      sheetRedraw(function () { bankFilterSheet(); });
    },
    'bf:reset': function () {
      S._bf = { practice: '', ptype: '', page: '', unit: '', lesson: '', point: '', type: '全部', difficulty: '' };
      sheetRedraw(function () { bankFilterSheet(); });
    },
    'bf:apply': function () {
      const f = S._bf || bankFilterDraft();
      const b = S.bank;
      b.practice = f.practice || ''; b.ptype = f.ptype || ''; b.page = f.page || '';
      b.unit = f.unit || ''; b.lesson = f.lesson || ''; b.point = f.point || '';
      b.type = f.type || '全部'; b.difficulty = f.difficulty || '';
      b.multiUnit = []; b.multiPoint = [];
      S._bf = null;
      UI.close();
      render();
    },
    'bf:pointMgr': function () { pointMgrSheet(); },
    'pm:sel': function (d) {
      const st = S._pm;
      if (!st) return;
      if (st.sel[d.id]) delete st.sel[d.id]; else st.sel[d.id] = 1;
      sheetRedraw(function () { pointMgrDraw(); });
    },
    'pm:all': function () {
      const st = S._pm;
      if (!st) return;
      const n = Object.keys(st.sel).length;
      st.sel = {};
      if (n !== st.pts.length) st.pts.forEach(function (p) { st.sel[p.id] = 1; });
      sheetRedraw(function () { pointMgrDraw(); });
    },
    'pm:merge': async function () {
      const st = S._pm;
      if (!st) return;
      const ids = Object.keys(st.sel);
      if (ids.length < 2) { UI.toast('至少勾选 2 个考点'); return; }
      const first = await DB.get('points', ids[0]);
      if (!first) return;
      const picked = await pickPoint('', first.subject, first.grade);
      if (!picked) return;
      if (!picked.id) { UI.toast('请选择一个已存在的考点作为合并目标'); return; }
      let m = 0;
      for (const id of ids) {
        if (id === picked.id) continue;
        await Store.Points.merge(id, picked.id);
        m++;
      }
      await Store.Points.recount();
      UI.toast('已把 ' + m + ' 个考点合并到「' + picked.name + '」', 3000);
      S.cache.bankQ = null;
      await pointMgrSheet();
    },
    'pm:del': async function () {
      const st = S._pm;
      if (!st) return;
      const ids = Object.keys(st.sel);
      if (!ids.length) { UI.toast('先勾选考点'); return; }
      const names = st.pts.filter(function (p) { return st.sel[p.id]; }).map(function (p) { return p.name; }).join('、');
      const ok = await UI.confirm('删除选中的 ' + ids.length + ' 个考点（' + names.slice(0, 40) + (names.length > 40 ? '…' : '') + '）及其下所有题目？不可恢复。');
      if (!ok) return;
      const qs = await DB.all('questions');
      let nq = 0;
      for (const q of qs) {
        if (!qPointsOf(q).some(function (p) { return p.id && st.sel[p.id]; })) continue;
        await Store.Questions.remove(q.id);
        nq++;
      }
      for (const id of ids) await DB.del('points', id);
      UI.toast('已删除 ' + ids.length + ' 个考点、' + nq + ' 道题', 3000);
      S.cache.bankQ = null;
      await pointMgrSheet();
    },
    /* 旧动作保留（兼容旧测试/脚本）：直接设值并生效 */
    'bank:setUnit': function (d) { S.bank.unit = d.v; S.bank.lesson = ''; S.bank.point = ''; S.bank.multiUnit = []; UI.close(); render(); },
    'bank:setPoint': function (d) { S.bank.point = d.v; S.bank.multiPoint = []; UI.close(); render(); },
    'bank:setType': function (d) { S.bank.type = d.v; UI.close(); render(); },
    'bank:setDiff': function (d) { S.bank.difficulty = d.v; UI.close(); render(); },
    'bank:resetFilter': function () { S.bank.type = '全部'; S.bank.difficulty = ''; UI.close(); render(); },

    /* ---- 一键撤销 / 恢复 ---- */
    'undo:do': async function () {
      const st = Undo.state();
      if (!st.canUndo) { UI.toast('还没有可撤销的操作'); return; }
      const label = await Undo.undo();
      UI.toast('已撤销：' + label, 2400);
      S.cache.same = {};
      await render();
      if (sheetRoot.querySelector('[data-sheet="imgs"]')) await refreshQImgsSheet();
    },
    'undo:redo': async function () {
      const st = Undo.state();
      if (!st.canRedo) { UI.toast('还没有可恢复的操作'); return; }
      const label = await Undo.redo();
      UI.toast('已恢复：' + label, 2400);
      S.cache.same = {};
      await render();
      if (sheetRoot.querySelector('[data-sheet="imgs"]')) await refreshQImgsSheet();
    },

    /* ---- 题库批量选择 ---- */
    'bank:batch': function () {
      const b = S.bank;
      const browsing = !b.keyword.trim() && !hasFilter(b);
      if (!S.batch.on && browsing) { UI.toast('先搜索或筛选出题目列表，再批量操作'); return; }
      S.batch.on = !S.batch.on;
      S.batch.set = {};
      render();
    },
    'batch:sel': function (d) {
      if (S.batch.set[d.id]) delete S.batch.set[d.id];
      else S.batch.set[d.id] = 1;
      render();
    },
    'batch:all': function () {
      const ids = S.cache.bankListIds || [];
      const all = ids.length && ids.every(id => S.batch.set[id]);
      if (all) ids.forEach(id => { delete S.batch.set[id]; });
      else ids.forEach(id => { S.batch.set[id] = 1; });
      render();
    },
    'batch:done': function () { S.batch.on = false; S.batch.set = {}; render(); },
    'batch:basket': async function () {
      const ids = Object.keys(S.batch.set);
      if (!ids.length) { UI.toast('先勾选题目'); return; }
      ids.forEach(id => { if (!Paper.has(id)) Paper.toggle(id); });
      UI.toast('已加入组卷篮（' + Paper.count() + ' 题）');
      S.batch.on = false; S.batch.set = {};
      render();
    },
    'batch:del': async function () {
      const ids = Object.keys(S.batch.set);
      if (!ids.length) { UI.toast('先勾选题目'); return; }
      const ok = await UI.confirm('删除选中的 ' + ids.length + ' 道题？删错了可以点顶栏 ↶ 撤销。');
      if (!ok) return;
      const firstCard = document.querySelector('.view [data-id="' + ids[0] + '"]');
      if (firstCard) S._scrollAnchor = Math.max(0, firstCard.getBoundingClientRect().top + window.scrollY);
      const before = await Undo.begin(ids);
      for (const id of ids) await Store.Questions.remove(id);
      await Undo.end('删除 ' + ids.length + ' 道题', before);
      UI.toast('已删除 ' + ids.length + ' 道题（可点 ↶ 撤销）', 2600);
      S.batch.on = false; S.batch.set = {};
      render();
    },
    'batch:point': async function () {
      const ids = Object.keys(S.batch.set);
      if (!ids.length) { UI.toast('先勾选题目'); return; }
      const first = await DB.get('questions', ids[0]);
      if (!first) return;
      const picked = await pickPoints([], first.subject, first.grade);
      if (!picked || !picked.length) return;
      const before = await Undo.begin(ids);
      let n = 0;
      for (const id of ids) {
        const q = await DB.get('questions', id);
        if (!q) continue;
        const pts = [];
        for (const e of picked) {
          if (e.id) { pts.push({ id: e.id, name: e.name }); continue; }
          // 新建考点：按每道题自己的章节带上「·第N单元」后缀
          try {
            const res = await resolveUnitPoint(e.name, (e.units && e.units[0]) || q.unit, q.subject, q.grade);
            pts.push({ id: res.point.id, name: res.point.name });
          } catch (err) {
            pts.push({ id: '', name: e.name });
          }
        }
        await Store.Questions.update(id, {
          points: pts, pointId: pts[0].id, pointName: pts[0].name, needsConfirm: false
        });
        n++;
      }
      await Store.Points.recount();
      await Undo.end(n + ' 题改考点', before);
      UI.toast('已把 ' + n + ' 道题挂上 ' + picked.length + ' 个考点');
      S.batch.on = false; S.batch.set = {};
      render();
    },

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
    /* ---- 讲评 ---- */
    'q:jp': function (d) {
      const ids = jpLoad();
      const i = ids.indexOf(d.id);
      if (i >= 0) { ids.splice(i, 1); UI.toast('已移出讲评'); }
      else { ids.push(d.id); UI.toast('已加入讲评（' + ids.length + ' 题）'); }
      jpSave(ids);
      render();
    },
    'jp:tags': function () {
      S.jpTags = !S.jpTags;
      try { localStorage.setItem('tiku.jp.tags', S.jpTags ? '1' : '0'); } catch (e) {}
      render();
    },
    'jp:batch': function () {
      S.jpSel.on = !S.jpSel.on;
      S.jpSel.set = {};
      render();
    },
    'jp:sel': function (d) {
      if (S.jpSel.set[d.id]) delete S.jpSel.set[d.id];
      else S.jpSel.set[d.id] = 1;
      render();
    },
    'jp:all': function () {
      const ids = (S.cache.jpQs || []).map(function (q) { return q.id; });
      const all = ids.length && ids.every(function (id) { return S.jpSel.set[id]; });
      if (all) ids.forEach(function (id) { delete S.jpSel.set[id]; });
      else ids.forEach(function (id) { S.jpSel.set[id] = 1; });
      render();
    },
    /* 批量标为已讲评：移出讲评单，留一批记录供撤回 */
    'jp:markDone': async function () {
      const ids = Object.keys(S.jpSel.set);
      if (!ids.length) { UI.toast('先勾选题目'); return; }
      jpSave(jpLoad().filter(function (x) { return ids.indexOf(x) < 0; }));
      S.jpLast = { ids: ids, at: Date.now() };
      S.jpSel.on = false; S.jpSel.set = {};
      await PAGES.jp.load();
      UI.toast('已标为已讲评 ' + ids.length + ' 道', 2600);
      render();
    },
    'jp:undone': async function () {
      if (!S.jpLast) { UI.toast('没有可撤回的讲评记录'); return; }
      const ids = jpLoad();
      S.jpLast.ids.forEach(function (id) { if (ids.indexOf(id) < 0) ids.unshift(id); });
      jpSave(ids);
      S.jpLast = null;
      await PAGES.jp.load();
      UI.toast('已撤回，题目回到讲评单');
      render();
    },
    'jp:rm': async function (d) {
      const ids = jpLoad().filter(function (x) { return x !== d.id; });
      jpSave(ids);
      await PAGES.jp.load();
      render();
    },
    /* ---- 讲评包 ---- */
    'pack:open': function () { packSheet(); },
    'pack:keep': function (d) {
      localStorage.setItem(PACK_KEEP_KEY, String(d.v));
      sheetRedraw(function () { packSheet(); });
    },
    'pack:link': async function () {
      const p = S._pack;
      if (!p) { UI.toast('先重新打开「生成讲评包」'); return; }
      const t = document.getElementById('packTitle');
      if (t && t.value.trim()) p.title = t.value.trim();
      p.keepDays = packKeepDays();
      UI.toast('正在打包并上传，稍等（首次会慢一点）…', 4000);
      let j;
      try {
        const r = await fetch(packServiceUrl() + '/api/pack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p)
        });
        j = await r.json();
      } catch (e) {
        throw new Error('连不上电脑上的题库服务：请确认这台电脑上已运行 node server/ocr-proxy.mjs（或直接用下面的「导出单文件」）');
      }
      if (!j || j.error) throw new Error((j && j.error) || '生成失败');
      packResultSheet(j);
    },
    'pack:file': async function () { await packExportFile(); },
    'pack:copy': async function () {
      const el = document.getElementById('packUrl');
      if (!el) return;
      try {
        await navigator.clipboard.writeText(el.value);
        UI.toast('链接已复制');
      } catch (e) {
        el.select();
        UI.toast('已选中，按 Ctrl+C 复制');
      }
    },

    'jp:clear': async function () {
      const ok = await UI.confirm('清空讲评单？只移出讲评列表，题目本身不会删除。');
      if (!ok) return;
      jpSave([]);
      S.jpSel.on = false; S.jpSel.set = {}; S.jpLast = null;
      await PAGES.jp.load();
      render();
    },
    'jp:cmp': function (d) { jpCmpSheet(d.id); },
    'jp:cmpShow': async function (d) {
      const a = await DB.get('questions', S._jpCmpId);
      const b = await DB.get('questions', d.id);
      if (!a || !b) { UI.toast('题目不存在'); return; }
      UI.sheet({ title: '对比分析', body: '<div class="cmp-grid">' + jpCmpBox(a, '讲评题') + jpCmpBox(b, '对比题') + '</div>' +
        '<p class="muted" style="margin-top:10px">并排看两边：考点相同在哪、解法差在哪、易错点在哪，讲给全班听。</p>' });
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
    /* ---- 题目编辑 / 配图（已入库） ---- */
    'q:edit': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      const typeOpts = CONFIG.questionTypes.map(function (t) {
        return '<option' + (q.type === t ? ' selected' : '') + '>' + t + '</option>';
      }).join('');
      // 单元选项（没归过单元也能在这里选定）
      const cat = Catalog.get(q.subject, q.grade, S.defaults.term, S.defaults.version);
      const curUnit = q.unit || '';
      const unitOpts = '<option value=""' + (curUnit ? '' : ' selected') + '>未归类单元</option>' +
        cat.map(function (u) {
          return '<option value="' + esc(u) + '"' + (curUnit === u ? ' selected' : '') + '>' + esc(u) + '</option>';
        }).join('');
      // 考点选项（本学段已有考点 + 当前值，没设考点也能在这里选定）
      const curPoint = q.pointName || '未分类';
      const points = await Store.Points.listBy(q.subject, q.grade);
      const seen = {}; const pnames = [];
      points.forEach(function (p) { if (p.name && !seen[p.name]) { seen[p.name] = 1; pnames.push(p.name); } });
      if (!seen[curPoint]) pnames.unshift(curPoint);
      pnames.sort(function (a, b) { return a === curPoint ? -1 : b === curPoint ? 1 : a.localeCompare(b, 'zh'); });
      const pointOpts = pnames.map(function (p) {
        return '<option' + (p === curPoint ? ' selected' : '') + '>' + esc(p) + '</option>';
      }).join('');
      // 课时（选填）：当前单元下的课时
      const curLesson = qLessonOf(q, curUnit) || '';
      const knownLs = knownLessonsOf(curUnit);
      const lessonOptsHtml = knownLs.map(function (L) { return '<option value="' + esc(L) + '">'; }).join('');
      UI.sheet({
        title: '编辑题目',
        body: '<div class="field"><label>题干</label>' +
            '<textarea class="textarea" id="qeText" style="min-height:120px">' + esc(q.text) + '</textarea></div>' +
          '<div class="field"><label>答案</label>' +
            '<input class="input" id="qeAns" value="' + esc(q.answer || '') + '"></div>' +
          '<div class="field"><div class="row between" style="align-items:center;margin-bottom:2px"><label>解题思路</label>' +
            '<button class="small muted" data-act="qe:clearSol">清空思路</button></div>' +
            '<textarea class="textarea" id="qeSol" style="min-height:90px">' + esc(q.solution || '') + '</textarea></div>' +
          '<div class="row" style="gap:8px">' +
            '<div class="field" style="flex:1.4;margin:0"><label>题型（可改）</label>' +
              '<select class="select" id="qeType">' + typeOpts + '</select></div>' +
            '<div class="field" style="flex:1;margin:0"><label>难度（可改）</label>' +
              '<select class="select" id="qeDiff">' +
                [1, 2, 3].map(function (n) {
                  return '<option value="' + n + '"' + (Number(q.difficulty) === n ? ' selected' : '') + '>难度 ' + n + '</option>';
                }).join('') +
              '</select></div>' +
          '</div>' +
          '<div class="row mt8" style="gap:8px">' +
            '<select class="select" id="qeUnit" style="flex:1">' + unitOpts + '</select>' +
            '<select class="select" id="qePoint" style="flex:1.4">' + pointOpts + '</select>' +
          '</div>' +
          '<div class="field mt8"><label>课时（选填，单元下按课时归类考点）</label>' +
            '<input class="input" id="qeLesson" placeholder="如：第3课时" value="' + esc(curLesson) + '" list="qeLessonList">' +
            '<datalist id="qeLessonList">' + lessonOptsHtml + '</datalist></div>' +
          '<div class="row mt8" style="gap:8px">' +
            '<div class="field" style="flex:1.7;margin:0"><label>练习名称（筛题用）</label>' +
              '<input class="input" id="qeBatch" placeholder="如：数学练习册P23" value="' + esc(q.batchName || '') + '"></div>' +
            '<div class="field" style="flex:.7;margin:0"><label>页码</label>' +
              '<input class="input" id="qePage" inputmode="numeric" placeholder="如 23" value="' + esc(pageNoOf(q)) + '"></div>' +
          '</div>' +
          '<div class="field mt8"><label>练习类型（筛题用）</label>' +
            '<select class="select" id="qePType">' +
              '<option value="">（未标注）</option>' +
              CONFIG.practiceTypes.map(function (t) {
                return '<option value="' + esc(t) + '"' + (practiceTypeOf(q) === t ? ' selected' : '') + '>' + esc(t) + '</option>';
              }).join('') +
            '</select></div>' +
          '<button class="btn primary block mt12" data-act="q:editSave" data-id="' + q.id + '">保存修改</button>'
      });
    },
    'q:editSave': async function (d) {
      const text = document.getElementById('qeText').value.trim();
      if (!text) { UI.toast('题干不能为空'); return; }
      const q = await DB.get('questions', d.id);
      if (!q) return;
      const patch = {
        text: text,
        answer: document.getElementById('qeAns').value.trim(),
        solution: document.getElementById('qeSol').value.trim(),
        type: document.getElementById('qeType').value,
        difficulty: Number(document.getElementById('qeDiff').value)
      };
      // 练习名称 / 类型 / 页码（筛题用；老题目按名称推断，这里可改准）
      const bnEl = document.getElementById('qeBatch');
      const ptEl = document.getElementById('qePType');
      const pgEl = document.getElementById('qePage');
      if (bnEl) patch.batchName = bnEl.value.trim();
      if (ptEl) patch.practiceType = ptEl.value;
      if (pgEl) patch.pageNo = pgEl.value.replace(/^[Pp]\.?\s*/, '').trim();
      // 考点 / 单元：原来没设置也能在这里选定；换单元时自动换对应后缀考点；课时与单元对齐
      const unitSel = document.getElementById('qeUnit');
      const pointSel = document.getElementById('qePoint');
      const lessonEl = document.getElementById('qeLesson');
      if (unitSel && pointSel) {
        const unit = unitSel.value || '';
        let base = pointSel.value || '未分类';
        if (unit && /·第\d+单元$/.test(base)) base = base.replace(/·第\d+单元$/, '');
        try {
          const res = await resolveUnitPoint(base, unit, q.subject, q.grade);
          patch.pointId = res.point.id;
          patch.pointName = res.point.name;
          patch.unit = unit;
        } catch (e) {
          patch.pointName = base;
          patch.unit = unit;
        }
        // units / lessons 数组与所选单元对齐（保留其他次要单元）
        const oldU = qUnitsOf(q).filter(function (x) { return x && x !== '未归类'; });
        const others = oldU.filter(function (x) { return unit && x !== unit && x !== (q.unit || ''); });
        const units = unit ? [unit].concat(others) : oldU;
        const lessonVal = lessonEl ? lessonEl.value.trim() : '';
        patch.units = units;
        patch.lessons = units.map(function (x) { return x === unit ? lessonVal : qLessonOf(q, x); });
        patch.lesson = lessonVal;
      }
      const before = await Undo.begin([d.id]);
      await Store.Questions.update(d.id, patch);
      await Undo.end('编辑题目', before);
      UI.close();
      UI.toast('已保存修改');
      const editCard = document.querySelector('.view [data-id="' + d.id + '"]');
      if (editCard) S._scrollAnchor = Math.max(0, editCard.getBoundingClientRect().top + window.scrollY);
      await render();
    },
    'q:imgs': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      S.imgSel = {};
      qImgsSheet(q);
    },
    'q:imgPick': function (d) {
      const k = +d.k;
      S.imgSel = S.imgSel || {};
      if (S.imgSel[k]) delete S.imgSel[k]; else S.imgSel[k] = 1;
      refreshQImgsSheet();
    },
    'q:imgAll': async function (d) {
      const q = S._qImgId ? await DB.get('questions', S._qImgId) : null;
      const n = q ? (q.images || []).length : 0;
      S.imgSel = {};
      if (d.v) for (let k = 0; k < n; k++) S.imgSel[k] = 1;
      refreshQImgsSheet();
    },
    'q:imgDel': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q || !q.images) return;
      const before = await Undo.begin([q.id]);
      q.images.splice(+d.k, 1);
      await Store.Questions.update(d.id, { images: q.images });
      await Undo.end('移除 1 张配图', before);
      S.imgSel = {};
      UI.toast('已移除 1 张图形（可撤销）');
      await refreshQImgsSheet();
      await render();
    },
    'q:imgDelSel': async function () {
      const id = S._qImgId;
      const q = id ? await DB.get('questions', id) : null;
      if (!q) return;
      const sel = S.imgSel || {};
      const idx = Object.keys(sel).filter(function (k) { return sel[k]; }).map(Number).sort(function (a, b) { return b - a; });
      if (!idx.length) { UI.toast('先点图勾选要删的图形'); return; }
      const ok = await UI.confirm('删除选中的 ' + idx.length + ' 张图形？（可用顶栏 ↶ 撤销）');
      if (!ok) { refreshQImgsSheet(); return; }
      const before = await Undo.begin([q.id]);
      const imgs = (q.images || []).slice();
      idx.forEach(function (k) { imgs.splice(k, 1); });
      await Store.Questions.update(id, { images: imgs });
      await Undo.end('移除 ' + idx.length + ' 张配图', before);
      S.imgSel = {};
      UI.toast('已删除 ' + idx.length + ' 张图形', 2400);
      const fresh = await DB.get('questions', id);
      if (fresh) qImgsSheet(fresh);
      await render();
    },
    'q:imgToggle': function (d) {
      S.openImg[d.id] = S.openImg[d.id] === false ? true : false;
      render();
    },
    'q:imgAdd': function (d) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = async function () {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const q = await DB.get('questions', d.id);
        if (!q) return;
        const before = await Undo.begin([d.id]);
        const imgs = q.images || [];
        for (const f of files) {
          try {
            const r = await ImageTool.compress(f);
            imgs.push(await blobToDataURL(r.blob));
          } catch (e) {
            UI.toast('有图片处理失败：' + (e.message || e));
          }
        }
        await Store.Questions.update(d.id, { images: imgs });
        await Undo.end('添加配图', before);
        UI.toast('已添加 ' + files.length + ' 张图形');
        const fresh = await DB.get('questions', d.id);
        if (fresh && sheetRoot.classList.contains('show')) qImgsSheet(fresh);
        await render();
      };
      input.click();
    },

    /* ---- 卡片标签快捷编辑：课时 / 题型 / 难度（考点复用 q:point） ---- */
    'q:lessonSel': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      const unit = lessonUnitOf(q);
      const unitFrom = !qUnitsOf(q)[0] && unit ? qPointsOf(q)[0].name : '';
      lessonPickSheet({
        mode: 'q', id: q.id, unit: unit, unitFrom: unitFrom,
        subject: q.subject, grade: q.grade,
        cur: qLessonOf(q, unit || qUnitsOf(q)[0] || ''),
        text: q.text
      });
    },
    'lesson:pick': function (d) { return applyLessonChoice(d.v || ''); },
    'lesson:new': async function (d) {
      const st = S._lp;
      if (!st) return;
      const v = String(d.v || '').trim();
      if (!v) return;
      if (st.unit) {
        const sbj = st.subject || S.defaults.subject;
        const gd = st.grade || S.defaults.grade;
        const cur = Catalog.lessonsOf(sbj, gd, S.defaults.term, S.defaults.version, st.unit);
        if (cur.indexOf(v) < 0) {
          cur.push(v);
          Catalog.setLessons(sbj, gd, S.defaults.term, S.defaults.version, st.unit, cur);
        }
      }
      await applyLessonChoice(v);
    },
    'q:lessonSet': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      const us = qUnitsOf(q);
      const unit = us[0] || q.unit || '';
      const idx = us.indexOf(unit);
      const v = (d.v || '').trim();
      const lessons = us.map(function (u, i) { return i === idx ? v : qLessonOf(q, u); });
      const before = await Undo.begin([d.id]);
      await Store.Questions.update(d.id, { lessons: lessons, lesson: idx === 0 ? v : (q.lesson || '') });
      await Undo.end('改课时', before);
      UI.close();
      UI.toast(v ? '课时已改为「' + v + '」（可撤销）' : '已清除课时（可撤销）');
      await render();
    },
    'q:typeSel': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      UI.sheet({
        title: '改题型',
        body: '<p class="muted" style="margin-bottom:8px">当前：' + esc(q.type) + '。点一个就改过去。</p>' +
          '<div class="chips wrapv">' +
          CONFIG.questionTypes.map(function (t) {
            return '<button class="tag' + (q.type === t ? ' active' : '') + '" data-act="q:typeSet" data-id="' + q.id + '" data-v="' + esc(t) + '">' + esc(t) + '</button>';
          }).join('') +
          '</div>'
      });
    },
    'q:typeSet': async function (d) {
      const before = await Undo.begin([d.id]);
      await Store.Questions.update(d.id, { type: d.v });
      await Undo.end('改题型', before);
      UI.close();
      UI.toast('题型已改为「' + d.v + '」');
      await render();
    },
    'q:diffSel': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      UI.sheet({
        title: '改难度',
        body: '<p class="muted" style="margin-bottom:8px">当前：难度 ' + Number(q.difficulty) + '。点一档就改过去。</p>' +
          '<div class="chips wrapv">' +
          [1, 2, 3].map(function (n) {
            return '<button class="tag' + (Number(q.difficulty) === n ? ' active' : '') + '" data-act="q:diffSet" data-id="' + q.id + '" data-v="' + n + '">难度 ' + n + '</button>';
          }).join('') +
          '</div>'
      });
    },
    'q:diffSet': async function (d) {
      const before = await Undo.begin([d.id]);
      await Store.Questions.update(d.id, { difficulty: Number(d.v) });
      await Undo.end('改难度', before);
      UI.close();
      UI.toast('难度已改为 ' + Number(d.v));
      await render();
    },

    'q:point': async function (d) {
      const q = await DB.get('questions', d.id);
      if (!q) return;
      const curNames = qPointsOf(q).map(function (p) { return p.name; })
        .filter(function (n) { return n && n !== '未分类'; });
      const picked = await pickPoints(curNames, q.subject, q.grade);
      if (!picked || !picked.length) return;
      const pts = [];
      for (const e of picked) {
        if (e.id) { pts.push({ id: e.id, name: e.name }); continue; }
        // 按题目所在章节给新考点带上「·第N单元」后缀
        try {
          const res = await resolveUnitPoint(e.name, (e.units && e.units[0]) || q.unit, q.subject, q.grade);
          pts.push({ id: res.point.id, name: res.point.name });
        } catch (err) {
          pts.push({ id: '', name: e.name });
        }
      }
      const patch = {
        points: pts, pointId: pts[0].id, pointName: pts[0].name, needsConfirm: false
      };
      // 新建/勾选考点时所选的单元并入该题的多单元归属（题目同时在各单元题库里可见）
      const unitAdd = [];
      picked.forEach(function (e) { (e.units || []).forEach(function (u) { if (u && unitAdd.indexOf(u) < 0) unitAdd.push(u); }); });
      if (unitAdd.length) {
        const curU = qUnitsOf(q).filter(function (u) { return u && u !== '未归类'; });
        const merged = curU.slice();
        unitAdd.forEach(function (u) { if (merged.indexOf(u) < 0) merged.push(u); });
        patch.units = merged;
        if (!patch.unit && merged.length) patch.unit = merged[0];
        // 新建考点时选了课时：写到对应单元位置（与 units 对齐），已有时课时不覆盖
        const lessonByUnit = {};
        picked.forEach(function (e) { if (e.lesson) (e.units || []).forEach(function (u) { if (u && !lessonByUnit[u]) lessonByUnit[u] = e.lesson; }); });
        if (Object.keys(lessonByUnit).length) {
          const curLessons = qLessonsOf(q);
          patch.lessons = merged.map(function (u, i) {
            return lessonByUnit[u] || curLessons[curU.indexOf(u)] || (i === 0 ? (q.lesson || '') : '');
          });
          patch.lesson = patch.lessons.filter(Boolean)[0] || q.lesson || '';
        }
      }
      const before = await Undo.begin([d.id]);
      await Store.Questions.update(d.id, patch);
      await Store.Points.recount();
      await Undo.end('改考点', before);
      UI.toast('已挂上 ' + pts.length + ' 个考点');
      await render();
    },
    'q:del': async function (d) {
      const ok = await UI.confirm('删除这道题？原图也会一起删除。删错了可以点顶栏 ↶ 撤销。');
      if (!ok) return;
      const card = document.querySelector('.view [data-id="' + d.id + '"]');
      if (card) S._scrollAnchor = Math.max(0, card.getBoundingClientRect().top + window.scrollY);
      const before = await Undo.begin([d.id]);
      await Store.Questions.remove(d.id);
      await Undo.end('删除 1 道题', before);
      delete S.imgUrls[d.id];
      UI.toast('已删除（可点 ↶ 撤销）', 2400);
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

    /* ---- 复习 · 组卷（按考点/单元筛选 + 锁定题型） ---- */
    'rv:pbuild': async function () {
      const qs = await Store.Questions.list({
        subject: S.defaults.subject, grade: S.defaults.grade, status: '全部'
      });
      S._pbuildQs = qs;
      if (!S._pbuild) S._pbuild = { mode: 'point', sel: {}, types: {}, per: 5 };
      pbuildSheet();
    },
    'rv:pbMode': function (d) {
      if (!S._pbuild) return;
      S._pbuild.mode = d.v;
      S._pbuild.sel = {};
      pbuildSheet();
    },
    'rv:pbSel': function (d) {
      if (!S._pbuild) return;
      if (S._pbuild.sel[d.v]) delete S._pbuild.sel[d.v];
      else S._pbuild.sel[d.v] = 1;
      pbuildSheet();
    },
    'rv:pbT': function (d) {
      if (!S._pbuild) return;
      if (S._pbuild.types[d.v]) delete S._pbuild.types[d.v];
      else S._pbuild.types[d.v] = 1;
      pbuildSheet();
    },
    'rv:pbCancel': function () { S._pbuild = null; UI.close(); },
    'rv:pbAuto': function () {
      const st = S._pbuild;
      if (!st) return;
      const perEl = document.getElementById('rvPer');
      st.per = Math.max(1, Math.min(30, parseInt(perEl && perEl.value, 10) || 5));
      const selNames = Object.keys(st.sel);
      if (!selNames.length) { UI.toast('先选' + (st.mode === 'point' ? '考点' : '单元')); return; }
      const types = Object.keys(st.types);
      if (!types.length) { UI.toast('先勾选要锁定的题型'); return; }
      const pool = (S._pbuildQs || []).filter(function (q) {
        return st.mode === 'point'
          ? qPointsOf(q).some(p => st.sel[p.name])
          : qUnitsOf(q).some(u => st.sel[u]);
      });
      const ids = [];
      types.forEach(function (t) {
        const list = pool.filter(q => (q.type || '应用题') === t);
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
        }
        list.slice(0, st.per).forEach(q => ids.push(q.id));
      });
      if (!ids.length) { UI.toast('选的范围里没有匹配题型的题目'); return; }
      Paper.setIds(ids);
      S.paperTitle = selNames.slice(0, 2).join('、') + (selNames.length > 2 ? '等' : '') +
        (st.mode === 'point' ? ' 考点练习' : ' 单元练习');
      S._pbuild = null;
      UI.close();
      UI.toast('已组卷：' + ids.length + ' 题进试卷篮，可调整顺序后保存 / 打印');
      navigate('paper');
    },
    'rv:pbManual': function () {
      const st = S._pbuild;
      if (!st) return;
      const selNames = Object.keys(st.sel);
      if (!selNames.length) { UI.toast('先选' + (st.mode === 'point' ? '考点' : '单元')); return; }
      const b = S.bank;
      b.keyword = ''; b.status = '全部'; b.type = '全部'; b.difficulty = '';
      b.unit = ''; b.point = '';
      if (st.mode === 'point') { b.multiPoint = selNames; b.multiUnit = []; }
      else { b.multiUnit = selNames; b.multiPoint = []; }
      S.batch.on = true; S.batch.set = {};
      S._pbuild = null;
      UI.close();
      navigate('bank');
      UI.toast('已按范围过滤题库并进入批量模式：勾题后点「入组卷」', 3000);
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

    /* ---- 每单元的课时（编辑 + 保存后自动归类） ---- */
    'settings:lessonsEdit': function (d) { lessonEditSheet(d.unit); },
    'settings:lessonsSave': async function (d) {
      const cv2 = S._catVersion || S.defaults.version;
      const t = document.getElementById('unitLessonText');
      Catalog.setLessons(S.defaults.subject, S.defaults.grade, S.defaults.term, cv2, d.unit, Catalog.fromText(t ? t.value : ''));
      UI.close();
      try {
        const r = await autoAssignLessons(S.defaults.subject, S.defaults.grade);
        UI.toast(r.assigned
          ? '已按考点自动归类 ' + r.assigned + ' 道题' + (r.pending ? '，' + r.pending + ' 道判断不出，可去题库「分配课时」' : '')
          : (r.pending ? r.pending + ' 道题判断不出课时，可去题库该单元卡「分配课时」批量归' : '没有需要归类的题'), 3400);
      } catch (e) {
        UI.toast('自动归类失败：' + (e.message || e), 2800);
      }
      render();
    },

    /* ---- 数据 ---- */
    'data:seed': async function () { await seedDemo(); },
    'data:export': async function () { await exportSheet(); },
    'data:doExport': async function (d) {
      const st = S._exp;
      if (!st) { UI.toast('请重新打开导出'); return; }
      let out;
      const now = new Date().toISOString();
      if (d.mode === 'inc' && st.last) {
        const qs = st.data.questions.filter(function (q) { return (q.createdAt || 0) > st.last; });
        const need = {};
        qs.forEach(function (q) {
          (q.points || []).forEach(function (p) { if (p && p.id) need[p.id] = 1; });
          if (q.pointId) need[q.pointId] = 1;
        });
        out = { app: '题点', version: 2, exportedAt: now, exportMode: '新增',
          questions: qs, points: st.data.points.filter(function (p) { return need[p.id]; }), papers: [],
          draft: draftForExport(true) };
      } else {
        out = { app: '题点', version: 2, exportedAt: now, exportMode: '全部',
          questions: st.data.questions, points: st.data.points, papers: st.data.papers,
          draft: draftForExport(false) };
      }
      localStorage.setItem('tiku.lastExportAt', String(Date.now()));
      Util.download('tiku-backup-' + Util.fmtDate(Date.now()) + '-' + out.exportMode + '.json', JSON.stringify(out, null, 2));
      UI.close();
      UI.toast('已导出 ' + out.questions.length + ' 题（' + out.exportMode + '）');
    },
    'data:syncUp': async function () {
      const ok = await UI.confirm('把本机全部数据备份到电脑？（会覆盖电脑上的上次备份）');
      if (!ok) return;
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
          const parsed = JSON.parse(text);
          const res = await Store.importAll(parsed);
          const dn = mergeImportedDraft(parsed.draft);
          UI.toast('导入 ' + res.questions + ' 题' + (dn ? '；草稿并入 ' + dn + ' 道（回首页继续编辑）' : ''), 3000);
          await render();
        } catch (e) {
          UI.toast('导入失败：' + e.message, 2600);
        }
      };
      input.click();
    },
    /* ---- 自动同步（云端文字快照） ---- */
    'sync:now': async function () {
      if (!syncReady()) {
        UI.toast('自动同步要用 WorkBuddy 链接打开题库（见本页提示）', 3200);
        return;
      }
      UI.toast('同步中…');
      await syncPushNow();
      const n = await syncPullNow(true);
      await render();
      UI.toast(n ? '已合并 ' + n + ' 处改动' : '已是最新', 2400);
    },
    'sync:rename': function () {
      const el = document.getElementById('syncDevName');
      if (!el) return;
      if (window.CloudSync) window.CloudSync.setDeviceName(el.value);
      UI.toast('设备名已保存（下次上传生效）');
      render();
    },

    /* ---- 数据码同步 ---- */
    'dcode:gen': function () { dcodeGenSheet(); },
    'dcode:opt': function (d) {
      const st = S._dc;
      if (!st) return;
      if (d.k === 'days') st.days = parseInt(d.v, 10) || 0;
      else st.withImg = d.v === '1';
      st.code = '';
      sheetRedraw(function () { dcodeGenDraw(); });
    },
    'dcode:make': async function () {
      const st = S._dc;
      if (!st) return;
      const all = await DB.all('questions');
      const cut = st.days ? Date.now() - st.days * 86400000 : 0;
      const picked = cut ? all.filter(function (q) { return (q.createdAt || 0) >= cut; }) : all.slice();
      if (!picked.length) { UI.toast('这个范围里没有题目'); return; }
      const need = {};
      picked.forEach(function (q) {
        (q.points || []).forEach(function (p) { if (p && p.id) need[p.id] = 1; });
        if (q.pointId) need[q.pointId] = 1;
      });
      const points = (await DB.all('points')).filter(function (p) { return need[p.id]; });
      let imgs = 0;
      const questions = picked.map(function (q) {
        imgs += (q.images || []).length;
        return st.withImg ? q : Object.assign({}, q, { images: [] });
      });
      const papers = st.days ? [] : (await DB.all('papers'));
      const code = dcodeEncode({ app: '题点', version: 2, exportedAt: new Date().toISOString(), questions: questions, points: points, papers: papers, draft: draftForExport(true) });
      st.code = code;
      st.n = questions.length;
      st.imgs = st.withImg ? imgs : 0;
      dcodeGenDraw();
    },
    'dcode:copy': async function () {
      const el = document.getElementById('dcodeOut');
      if (!el) return;
      await copyText(el.value);
      UI.toast('已复制，去微信发给另一台设备', 3000);
    },
    'dcode:import': function () { dcodeImportSheet(); },
    'dcode:doImport': async function () {
      const ta = document.getElementById('dcodeIn');
      if (!ta) return;
      let data;
      try { data = dcodeDecode(ta.value); }
      catch (e) { UI.toast(e.message, 3200); return; }
      const existed = await DB.all('questions');
      const exIds = {};
      existed.forEach(function (q) { exIds[q.id] = 1; });
      let add = 0, upd = 0, imgs = 0;
      data.questions.forEach(function (q) {
        if (exIds[q.id]) upd++; else add++;
        imgs += (q.images || []).length;
      });
      const ok = await UI.confirm('码里共 ' + data.questions.length + ' 道题：新增 ' + add + '、更新 ' + upd + '，配图 ' + imgs + ' 张。\n合并到本机题库？（相同编号的题会被码里的版本覆盖，本机其他题不动）');
      if (!ok) return;
      try {
        await Store.importAll(data);
      } catch (e) { UI.toast('导入失败：' + (e.message || e), 3000); return; }
      const dn = mergeImportedDraft(data.draft);
      UI.close();
      UI.toast('已合并：新增 ' + add + ' 题、更新 ' + upd + ' 题' + (dn ? '；草稿并入 ' + dn + ' 道（回首页继续编辑）' : ''), 3400);
      await render();
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
      // 文档里的图片也做红笔答案检测（一般红笔标记的是答案）
      if (res.images && res.images.length && (!CONFIG.ocr.provider || CONFIG.ocr.provider === 'tesseract')) {
        const reds = [];
        for (const src of res.images.slice(0, 8)) {
          const r = await OCR.redAnswer(src);
          if (r && r.found && r.text) reds.push(r.text);
        }
        if (reds.length) s.images[0].redAns = { found: true, text: reds.join('\n') };
      }
      if (!s.batchName) s.batchName = file.name.replace(/\.[a-z0-9]+$/i, '');
      buildDrafts();
      const imgN = (res.images || []).length;
      const draftImgN = S.drafts.reduce(function (n, d) { return n + (d.images || []).length; }, 0);
      if (res.warn) UI.toast(res.warn, 6000);
      else if (imgN) UI.toast('文件里有 ' + imgN + ' 张图，已配到题目上 ' + draftImgN + ' 张', 3200);
      else if (/\.pdf$/i.test(file.name) && /看图|如图|下图|上图|图形|阴影|图意/.test(text.slice(0, 4000))) {
        UI.toast('这份 PDF 没读到图片（可能是用线条画的图形，或整页扫描）。这类题的图请用「拍照」补一张', 5200);
      }
      s.stage = 'confirm';
      await navigate('confirm');
      await classifyDrafts();
    } catch (err) {
      UI.toast(err.message || '解析失败', 3200);
    }
  });

  /* 每日计算 · 导入文件生成计算题库（#dcCalcFile 是动态渲染的，用委托监听） */
  document.addEventListener('change', async function (e) {
    if (!e.target || e.target.id !== 'dcCalcFile') return;
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    UI.toast('正在解析 ' + file.name + ' …', 4000);
    try {
      const res = DocParse.extractDoc
        ? await DocParse.extractDoc(file)
        : { text: await DocParse.extract(file), images: [] };
      const text = OCR.tidy ? OCR.tidy(res.text) : res.text;
      const r = dcParseCalcText(text);
      if (!r.items.length) {
        UI.toast('没有识别到计算式题（找形如 3.6 + 2.7 =、1/2 + 1/4 = 的式题，文字应用题会自动跳过）', 4000);
        return;
      }
      const grade = S.dcalcPick || (readDcalcCfg() || {}).grade || '';
      r.items.forEach(function (it) { if (grade) it.g = grade; });
      const bank = readCalcBank();
      const seen = {};
      bank.forEach(function (it) { seen[it.q] = 1; });
      let add = 0;
      r.items.forEach(function (it) { if (!seen[it.q]) { bank.push(it); add++; } });
      saveCalcBank(bank);
      S.dcalcUseBank = true;
      UI.toast('已提取 ' + add + ' 道计算题补充' + (grade || '本') + '学段练习（题库共 ' + bank.length + ' 道）', 3600);
      navigate('home');
    } catch (err) {
      UI.toast(err && err.message ? err.message : '解析失败', 3200);
    }
  });

  /* 离开页面时尽量不要丢 OCR worker */
  window.addEventListener('beforeunload', function () { OCR.destroy(); });

  /* 调试钩子（控制台可用：__tiku.S、__tiku.navigate(...) 等） */
  window.__tiku = { S: S, navigate: navigate, UI: UI, ACTIONS: ACTIONS,
    dcodeEncode: dcodeEncode, dcodeDecode: dcodeDecode,
    ensureSession: ensureSession, buildDrafts: buildDrafts, classifyDrafts: classifyDrafts,
    seedDemo: seedDemo, Store: Store, resolveUnitPoint: resolveUnitPoint, unitSuffixOf: unitSuffixOf,
    dcDaySet: dcDaySet, dcWeightedPool: dcWeightedPool, dcNextMonday: dcNextMonday,
    dcWorkdayIndex: dcWorkdayIndex, dcDateKey: dcDateKey,
    dcCalcAnswer: dcCalcAnswer, dcParseCalcText: dcParseCalcText, calcKindOf: calcKindOf,
    dcOcrSheet: dcOcrSheet, dcalcPlanBody: dcalcPlanBody,
    dcExtractWeak: dcExtractWeak, dcWeakVaried: dcWeakVaried, dcWeakKind: dcWeakKind,
    dcCollectWeak: dcCollectWeak, readCalcBank: readCalcBank, saveCalcBank: saveCalcBank,
    dcNoteGen: dcNoteGen, dcNoteQs: dcNoteQs, dcEditSheet: dcEditSheet, dcEditApply: dcEditApply,
    dcSolveFixes: dcSolveFixes, dcSameNum: dcSameNum,
    autoAssignLessons: autoAssignLessons, syncCatalogLessons: syncCatalogLessons, pointBaseName: pointBaseName,
    lessonAssignSheet: lessonAssignSheet, lessonEditSheet: lessonEditSheet,
    jpLoad: jpLoad, jpSave: jpSave, jpHas: jpHas, jpCmpSheet: jpCmpSheet, jpCmpBox: jpCmpBox,
    dcOpenDays: dcOpenDays, migrateQuestionTypes: migrateQuestionTypes,
    assignRedAnswers: assignRedAnswers, normCmpText: normCmpText, ppmApplyOrder: ppmApplyOrder,
    qUnitsOf: qUnitsOf, qPointsOf: qPointsOf, qLessonOf: qLessonOf, qLessonsOf: qLessonsOf,
    knownLessonsOf: knownLessonsOf, pickPoints: pickPoints,
    lessonUnitOf: lessonUnitOf, lessonUnitOfDraft: lessonUnitOfDraft, lessonChoices: lessonChoices,
    usedLessonsOf: usedLessonsOf, lessonPickSheet: lessonPickSheet, stripImageMarkers: stripImageMarkers,
    lessonChipsHtml: lessonChipsHtml, sweepLostImages: sweepLostImages,
    Undo: Undo, cnNum: cnNum, unitLabelOf: unitLabelOf, practiceNameOf: practiceNameOf,
    practiceTypeOf: practiceTypeOf, pageNoOf: pageNoOf, matchFilter: matchFilter,
    filterQuestions: filterQuestions, hasFilter: hasFilter, bankFilterSheet: bankFilterSheet,
    qImgsSheet: qImgsSheet };

  /* =========================================================
   * 启动
   * ======================================================= */
  /** v1.9.0：把存量「解答题」统一改名「应用题」（幂等，改完即无） */
  async function migrateQuestionTypes() {
    const all = await DB.all('questions');
    const changed = all.filter(function (q) { return q.type === '解答题'; })
      .map(function (q) { q.type = '应用题'; return q; });
    if (changed.length) await DB.bulkPut('questions', changed);
    return changed.length;
  }

  (async function boot() {
    try {
      await DB.open();
      await Store.Points.recount();
      await migrateQuestionTypes();
      // 不再自动生成示例题；需要例子时在首页点「载入示例（苏教版五上新教材练习）」
    } catch (e) {
      console.error(e);
    }
    // 支持 #bank / #review 等 hash 直达
    const initial = (location.hash || '').replace(/^#\/?/, '');
    await navigate(PAGES[initial] ? initial : 'home', {}, true);

    // 任何写库动作（入库/编辑/删除/导入）都在 2.5 秒后自动上传文字快照
    try { Store.onChange(function () { scheduleSyncPush(); }); } catch (e) {}
    // 云端文字同步：打开时拉一次，之后每 60 秒 / 每次切回页面看一次
    if (syncReady()) {
      setTimeout(function () { syncPullNow(true); }, 2500);
      setInterval(function () { if (!document.hidden) syncPullNow(true); }, 60000);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && syncReady()) syncPullNow(true);
      });
    }
  })();
})();
