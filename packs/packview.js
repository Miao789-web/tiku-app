/* =========================================================
 * 讲评包只读视图（PackView）
 * 一份代码两处用：
 *   1) 线上只读页 pack.html（部署到 GitHub Pages，供教室电脑/手机打开）
 *   2) 「导出单文件 HTML」时把本文件源码内联进去，双击即可离线看
 * 依赖：无（自绘 DOM、自带样式）
 * ======================================================= */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function css() {
    return [
      ':root{--ink:#111827;--ink2:#4b5563;--ink3:#6b7280;--line:#e5e7eb;--brand:#2f6fed;--soft:#eef4ff;--bg:#f6f7fb;--warn:#b45309;--warnbg:#fff7ed}',
      '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
      'html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);',
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;',
      '-webkit-text-size-adjust:100%}',
      '.pv-wrap{max-width:880px;margin:0 auto;padding:14px 14px 60px}',
      '.pv-head{background:#fff;border-radius:14px;padding:14px 16px;box-shadow:0 1px 3px rgba(17,24,39,.06)}',
      '.pv-head h1{margin:0;font-size:19px;line-height:1.4}',
      '.pv-meta{margin-top:6px;font-size:12.5px;color:var(--ink3);line-height:1.8}',
      '.pv-bar{position:sticky;top:0;z-index:20;display:flex;gap:8px;align-items:center;',
      'margin:12px 0 10px;padding:8px;background:rgba(246,247,251,.94);backdrop-filter:blur(6px);border-radius:12px}',
      '.pv-bar button{flex:1;border:1px solid var(--line);background:#fff;color:var(--ink2);',
      'border-radius:10px;padding:9px 10px;font-size:13px;font-weight:600}',
      '.pv-bar button.on{background:var(--brand);border-color:var(--brand);color:#fff}',
      '.pv-sec{font-size:13px;font-weight:700;color:var(--ink2);margin:16px 4px 8px}',
      '.pv-card{background:#fff;border-radius:14px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(17,24,39,.06)}',
      '.pv-top{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}',
      '.pv-no{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;',
      'padding:0 7px;border-radius:8px;background:var(--brand);color:#fff;font-size:12.5px;font-weight:700}',
      '.pv-no.same{background:#7c8aa5}',
      '.pv-tag{font-size:11.5px;color:var(--ink2);background:#f3f4f6;border-radius:6px;padding:3px 7px}',
      '.pv-tag.b{background:var(--soft);color:#1f57c3}',
      '.pv-text{font-size:15.5px;line-height:1.72;white-space:pre-wrap;word-break:break-word}',
      '.pv-opt{margin:6px 0 0;font-size:14.5px;line-height:1.8;color:var(--ink2);white-space:pre-wrap}',
      '.pv-imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:10px}',
      '.pv-imgs img{width:100%;height:auto;display:block;border-radius:10px;border:1px solid var(--line);cursor:zoom-in;background:#fff}',
      '.pv-ans{margin-top:10px;padding:8px 10px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:0 8px 8px 0;',
      'font-size:14px;line-height:1.7;white-space:pre-wrap}',
      '.pv-sol{margin-top:8px;padding:10px;background:#f8fafc;border-radius:10px;font-size:14px;line-height:1.75;',
      'white-space:pre-wrap;color:var(--ink2)}',
      '.pv-sol b{display:block;font-size:12px;color:var(--ink3);margin-bottom:4px}',
      '.pv-foot{text-align:center;font-size:12px;color:var(--ink3);line-height:1.9;margin-top:18px}',
      '.pv-note{margin-top:10px;padding:10px 12px;border-radius:10px;background:var(--warnbg);color:var(--warn);',
      'font-size:12.5px;line-height:1.7}',
      '.pv-zoom{position:fixed;inset:0;z-index:99;background:rgba(17,24,39,.94);display:none;',
      'align-items:center;justify-content:center;padding:10px}',
      '.pv-zoom.show{display:flex}',
      '.pv-zoom img{max-width:100%;max-height:100%;object-fit:contain}',
      '.pv-fs{flex:none;display:flex;align-items:center;gap:2px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:2px}',
      '.pv-fs button{flex:none;width:30px;height:28px;padding:0;border:0;background:transparent;color:var(--ink2);',
      'border-radius:7px;font-size:14px;font-weight:700}',
      '.pv-fs button:active{background:var(--soft)}',
      '.pv-fs button.off{opacity:.35}',
      '.pv-fs span{min-width:30px;text-align:center;font-size:11px;color:var(--ink3);font-weight:600}',
      /* 字号 0-5 档：文字、选项、答案、思路一起放大 */
      'body.fs1 .pv-text{font-size:17px}',
      'body.fs2 .pv-text{font-size:18.5px}',
      'body.fs3 .pv-text{font-size:20px}',
      'body.fs4 .pv-text{font-size:22px}',
      'body.fs5 .pv-text{font-size:24px}',
      'body.fs1 .pv-opt{font-size:15.5px}',
      'body.fs2 .pv-opt{font-size:17px}',
      'body.fs3 .pv-opt{font-size:18.5px}',
      'body.fs4 .pv-opt{font-size:20px}',
      'body.fs5 .pv-opt{font-size:22px}',
      'body.fs1 .pv-ans,body.fs1 .pv-sol{font-size:15px}',
      'body.fs2 .pv-ans,body.fs2 .pv-sol{font-size:16px}',
      'body.fs3 .pv-ans,body.fs3 .pv-sol{font-size:17.5px}',
      'body.fs4 .pv-ans,body.fs4 .pv-sol{font-size:19px}',
      'body.fs5 .pv-ans,body.fs5 .pv-sol{font-size:21px}',
      'body.fs1 .pv-text,body.fs2 .pv-text,body.fs3 .pv-text,body.fs4 .pv-text,body.fs5 .pv-text{line-height:1.85}',
      'body.hide-ans .pv-ans,body.hide-ans .pv-sol{display:none}',
      'body.hide-tags .pv-tag{display:none}',
      '@media print{.pv-bar{display:none}.pv-card{break-inside:avoid;box-shadow:none;border:1px solid var(--line)}}'
    ].join('');
  }

  function tagsOf(it) {
    var out = [];
    (it.points || []).slice(0, 2).forEach(function (p) { if (p) out.push('<span class="pv-tag b">' + esc(p) + '</span>'); });
    if (it.unit) out.push('<span class="pv-tag">📖 ' + esc(it.unit) + '</span>');
    if (it.lesson) out.push('<span class="pv-tag">⏱ ' + esc(it.lesson) + '</span>');
    if (it.type) out.push('<span class="pv-tag">' + esc(it.type) + '</span>');
    if (it.difficulty) out.push('<span class="pv-tag">难度 ' + esc(it.difficulty) + '</span>');
    return out.join('');
  }

  function cardHtml(it, no) {
    var same = it.role === 'same';
    var imgs = (it.images || []).length
      ? '<div class="pv-imgs">' + it.images.map(function (src) {
          return '<img src="' + esc(src) + '" alt="题目图形" loading="lazy">';
        }).join('') + '</div>'
      : '';
    return '<article class="pv-card">' +
      '<div class="pv-top">' +
        '<span class="pv-no' + (same ? ' same' : '') + '">' + (same ? '同类' : no) + '</span>' +
        tagsOf(it) +
      '</div>' +
      '<div class="pv-text">' + esc(it.text) + '</div>' +
      ((it.options && it.options.length) ? '<p class="pv-opt">' + it.options.map(esc).join('<br>') + '</p>' : '') +
      imgs +
      (it.answer ? '<div class="pv-ans"><b>答案：</b>' + esc(it.answer) + '</div>' : '') +
      (it.solution ? '<div class="pv-sol"><b>解题思路</b>' + esc(it.solution) + '</div>' : '') +
    '</article>';
  }

  function ensureStyle() {
    if (document.getElementById('pvStyle')) return;
    var st = document.createElement('style');
    st.id = 'pvStyle';
    st.textContent = css();
    document.head.appendChild(st);
  }

  function mount(root, pack) {
    ensureStyle();
    var items = (pack && pack.items) || [];
    var main = items.filter(function (x) { return x.role !== 'same'; });
    var same = items.filter(function (x) { return x.role === 'same'; });
    var expired = pack && pack.expiresAt && Date.now() > pack.expiresAt;
    var sub = [pack.subject, pack.grade, main.length + ' 道讲评题' + (same.length ? ' · ' + same.length + ' 道同类题' : '')]
      .filter(Boolean).join(' · ');

    var html = '' +
      '<div class="pv-wrap">' +
        '<header class="pv-head">' +
          '<h1>' + esc(pack.title || '讲评包') + '</h1>' +
          '<div class="pv-meta">' + esc(sub) + '<br>' +
            (pack.unit ? '单元：' + esc(pack.unit) + ' · ' : '') +
            '生成于 ' + esc(fmt(pack.createdAt)) +
            (pack.expiresAt ? ' · 有效期至 ' + esc(fmt(pack.expiresAt)) : '') +
          '</div>' +
          (expired ? '<div class="pv-note">这个包已过有效期（' + esc(fmt(pack.expiresAt)) + '）。内容仍可查看，但可能已被清理，建议重新生成。</div>' : '') +
        '</header>' +
        '<div class="pv-bar">' +
          '<button data-pv="ans" class="on">显示答案</button>' +
          '<button data-pv="tags">标签</button>' +
          '<div class="pv-fs">' +
            '<button data-pv="minus" aria-label="缩小字号">A−</button>' +
            '<span id="pvFs">1/6</span>' +
            '<button data-pv="plus" aria-label="放大字号">A＋</button>' +
          '</div>' +
          '<button data-pv="print">打印</button>' +
        '</div>' +
        (main.length ? '<div class="pv-sec">讲评题 ' + main.length + ' 道</div>' + main.map(function (it, i) { return cardHtml(it, i + 1); }).join('') : '<div class="pv-sec">讲评题</div><article class="pv-card">这个包里没有题目</article>') +
        (same.length ? '<div class="pv-sec">同类题（对比用）' + same.length + ' 道</div>' + same.map(function (it) { return cardHtml(it, 0); }).join('') : '') +
        '<div class="pv-foot">' +
          '题点题库 · 讲评包<br>本页打开过一次即可断网使用（浏览器已缓存）' +
        '</div>' +
      '</div>' +
      '<div class="pv-zoom" id="pvZoom"><img alt="放大查看"></div>';

    root.innerHTML = html;

    var zoom = root.querySelector('#pvZoom');
    var zoomImg = zoom.querySelector('img');

    // 字号：6 档（1/6 ~ 6/6），记在本机，下次打开保持
    var FS_MAX = 5;
    var fsLv = 0;
    try { fsLv = Math.max(0, Math.min(FS_MAX, parseInt(localStorage.getItem('pv.fs'), 10) || 0)); } catch (e) { fsLv = 0; }
    var fsLabel = root.querySelector('#pvFs');
    var minusBtn = root.querySelector('[data-pv="minus"]');
    var plusBtn = root.querySelector('[data-pv="plus"]');
    function applyFs() {
      for (var i = 1; i <= FS_MAX; i++) document.body.classList.remove('fs' + i);
      if (fsLv > 0) document.body.classList.add('fs' + fsLv);
      if (fsLabel) fsLabel.textContent = (fsLv + 1) + '/' + (FS_MAX + 1);
      if (minusBtn) minusBtn.classList.toggle('off', fsLv === 0);
      if (plusBtn) plusBtn.classList.toggle('off', fsLv === FS_MAX);
      try { localStorage.setItem('pv.fs', String(fsLv)); } catch (e) {}
    }
    applyFs();

    // 标签开关：默认隐藏（观课简洁模式），记在本机，下次打开保持
    var tagsBtn = root.querySelector('[data-pv="tags"]');
    var showTags = false;
    try { showTags = localStorage.getItem('pv.tags') === '1'; } catch (e) { showTags = false; }
    function applyTags() {
      document.body.classList.toggle('hide-tags', !showTags);
      if (tagsBtn) tagsBtn.classList.toggle('on', showTags);
      try { localStorage.setItem('pv.tags', showTags ? '1' : '0'); } catch (e) {}
    }
    applyTags();

    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pv]');
      if (btn) {
        var k = btn.getAttribute('data-pv');
        if (k === 'ans') {
          document.body.classList.toggle('hide-ans');
          btn.classList.toggle('on', !document.body.classList.contains('hide-ans'));
          btn.textContent = document.body.classList.contains('hide-ans') ? '显示答案' : '隐藏答案';
        } else if (k === 'tags') {
          showTags = !showTags;
          applyTags();
        } else if (k === 'plus') {
          if (fsLv < FS_MAX) { fsLv++; applyFs(); }
        } else if (k === 'minus') {
          if (fsLv > 0) { fsLv--; applyFs(); }
        } else if (k === 'print') {
          window.print();
        }
        return;
      }
      var img = e.target.closest('.pv-imgs img');
      if (img) {
        zoomImg.src = img.src;
        zoom.classList.add('show');
        return;
      }
      if (e.target === zoom || e.target === zoomImg) zoom.classList.remove('show');
    });
  }

  /** 生成可直接双击打开的单文件 HTML（src 传本文件源码，用于内联） */
  function standalone(pack, src) {
    return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(pack.title || '讲评包') + '</title><style>' + css() + '</style></head>' +
      '<body><div id="pvRoot"></div>' +
      '<script>' + (src || '') + '<\/script>' +
      '<script>var PACK=' + JSON.stringify(pack) + ';PackView.mount(document.getElementById("pvRoot"),PACK);<\/script>' +
      '</body></html>';
  }

  window.PackView = { css: css, mount: mount, standalone: standalone, fmt: fmt };
})();
