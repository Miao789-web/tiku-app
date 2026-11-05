/* =========================================================
 * paper.js — 组卷
 * ---------------------------------------------------------
 * 试卷篮（跨页面收集题目）+ 按题型分节排版：
 *   一、填空题  1. …… （1）… ①…
 *   二、选择题  1. …… A. B. C. D.
 * 输出适合 A4 打印的 HTML（含可选答案页）。
 * ========================================================= */
const Paper = (function () {

  const KEY = 'tiku.basket';
  const TYPE_ORDER = ['计算题', '填空题', '判断题', '选择题', '应用题', '解答题'];
  const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

  /* ---------- 试卷篮（localStorage 持久化） ---------- */
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  let basket = load();

  function persist() { localStorage.setItem(KEY, JSON.stringify(basket)); }

  function has(id) { return basket.indexOf(id) >= 0; }

  /** @returns {boolean} 操作后是否在篮中 */
  function toggle(id) {
    const i = basket.indexOf(id);
    if (i >= 0) basket.splice(i, 1); else basket.push(id);
    persist();
    return i < 0;
  }

  function clear() { basket = []; persist(); }
  function count() { return basket.length; }
  function ids() { return basket.slice(); }

  function setIds(arr) { basket = (arr || []).slice(); persist(); }

  async function questions() {
    const out = [];
    for (const id of basket) {
      const q = await DB.get('questions', id);
      if (q) out.push(q);
    }
    return out;
  }

  /* ---------- 排版 ---------- */
  function qText(q) {
    const lines = [];
    if (q.text) lines.push(String(q.text).trim());
    (q.subs || []).forEach(function (s) { lines.push(String(s).trim()); });
    return lines.map(esc).join('<br>');
  }

  function optionsInline(q) {
    if (!q.options || !q.options.length) return '';
    const opts = q.options.map(function (o) {
      return esc(String(o)).replace(/([A-D])[.、．)）]\s*/, '$1.');
    });
    // 选项少且短就排一行，否则每行一个
    const joined = opts.join('　　');
    return joined.length <= 40 ? '<div class="p-opts">' + joined + '</div>'
      : '<div class="p-opts">' + opts.join('<br>') + '</div>';
  }

  function dateStr(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /**
   * 生成试卷 HTML
   * @param {Array} qs 题目数组（保持顺序）
   * @param {object} opts {title, withAnswer}
   */
  function render(qs, opts) {
    opts = opts || {};
    const title = opts.title || '单元练习';
    const sections = [];
    const answerParts = [];

    TYPE_ORDER.forEach(function (type) {
      const list = qs.filter(q => (q.type || '解答题') === type);
      if (!list.length) return;
      const label = CN_NUM[sections.length] || String(sections.length + 1);
      let inner = '';
      list.forEach(function (q, i) {
        inner += '<div class="p-q"><span class="p-no">' + (i + 1) + '.</span>' +
          '<span class="p-body">' + qText(q) + optionsInline(q) + '</span></div>';
        if (opts.withAnswer) {
          answerParts.push('<div class="p-aq"><b>' + label + '、' + type + ' 第' + (i + 1) + '题</b>' +
            '　答案：' + Paper.esc(q.answer || '（略）') +
            (q.solution ? '<br><span class="p-asol">思路：' + Paper.esc(q.solution) + '</span>' : '') +
            '</div>');
        }
      });
      sections.push('<div class="p-sec"><h2>' + label + '、' + type + '</h2>' + inner + '</div>');
    });

    // 未归入常规题型的兜底
    const rest = qs.filter(q => TYPE_ORDER.indexOf(q.type || '解答题') < 0);
    if (rest.length) {
      let inner = '';
      rest.forEach(function (q, i) {
        inner += '<div class="p-q"><span class="p-no">' + (i + 1) + '.</span><span class="p-body">' + qText(q) + optionsInline(q) + '</span></div>';
      });
      sections.push('<div class="p-sec"><h2>' + (CN_NUM[sections.length] || '九') + '、其他</h2>' + inner + '</div>');
    }

    let html = '<div class="paper">' +
      '<h1 class="p-title">' + Paper.esc(title) + '</h1>' +
      '<div class="p-meta">班级：__________　姓名：__________　得分：__________</div>' +
      sections.join('') +
      '<div class="p-end">（完）</div>';

    if (opts.withAnswer && answerParts.length) {
      html += '<div class="p-ans-break"></div>' +
        '<div class="p-ans"><h1 class="p-title">参考答案</h1>' + answerParts.join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  return { has, toggle, clear, count, ids, setIds, questions, render, esc, dateStr, TYPE_ORDER };
})();
