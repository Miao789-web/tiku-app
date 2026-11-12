/* =========================================================
 * docparse.js — PDF / Word(.docx) / TXT 文字提取（浏览器本地）
 * ---------------------------------------------------------
 * 解析库按需从 cdnjs 懒加载（国内可直连）：
 *   PDF  → pdf.js 3.11（逐页提取文字坐标并按行重组）
 *   docx → mammoth（提取正文纯文本）
 * 扫描版 PDF（图片型）提不出文字，会给出明确提示走拍照录入。
 * ========================================================= */
const DocParse = (function () {

  const PDFJS_VER = '3.11.174';
  const MAMMOTH_VER = '1.8.0';

  function ext(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  async function loadMammoth() {
    if (window.mammoth) return window.mammoth;
    await Util.loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/' + MAMMOTH_VER + '/mammoth.browser.min.js');
    if (!window.mammoth) throw new Error('Word 解析组件加载失败，请检查网络');
    return window.mammoth;
  }

  async function loadPdfjs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    await Util.loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.min.js');
    if (!window.pdfjsLib) throw new Error('PDF 解析组件加载失败，请检查网络');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER + '/pdf.worker.min.js';
    return window.pdfjsLib;
  }

  async function fromDocx(file) {
    const mammoth = await loadMammoth();
    const buf = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer: buf });
    return res && res.value ? res.value : '';
  }

  /* ---------- PDF：文字行 + 内嵌位图（按纵坐标插【图N】占位） ---------- */
  /** 矩阵乘法：[a,b,c,d,e,f]（与 pdf.js 一致） */
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  /** 当前变换矩阵里图形占的矩形（PDF 用户坐标：单位正方形经 ctm 变换） */
  function rectOf(m) {
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    return {
      x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
      y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys)
    };
  }

  /**
   * 一页里的位图 → [{src, y}]（y 用 PDF 坐标，越大越靠上）
   * 思路：先扫绘图指令拿到每张图的矩形，再把整页渲染成画布按矩形裁下来——
   * 这样蒙版/透明/CMYK 等奇奇怪怪的图都能按原样取到，不用自己解码像素。
   */
  async function pageImages(pdfjs, page) {
    const OPS = pdfjs.OPS;
    if (!OPS) return [];
    let list;
    try { list = await page.getOperatorList(); } catch (e) { return []; }
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const rects = [];
    const seen = {};
    for (let i = 0; i < list.fnArray.length; i++) {
      const fn = list.fnArray[i], args = list.argsArray[i];
      if (fn === OPS.transform) { ctm = mul(ctm, args); continue; }
      if (fn === OPS.save) { stack.push(ctm); continue; }
      if (fn === OPS.restore) { ctm = stack.pop() || ctm; continue; }
      if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject) {
        const key = fn === OPS.paintInlineImageXObject ? 'inline' : String(args[0]);
        const r = rectOf(ctm);
        const sig = key + '@' + [r.x0, r.y0, r.x1, r.y1].map(function (v) { return Math.round(v); }).join(',');
        if (seen[sig]) continue;          // 同一张图同一位置重复绘制（页眉 logo 之类）只取一次
        seen[sig] = 1;
        rects.push(r);
      }
    }
    if (!rects.length) return [];

    const scale = 2;
    const viewport = page.getViewport({ scale: scale });
    const cv = document.createElement('canvas');
    cv.width = Math.floor(viewport.width);
    cv.height = Math.floor(viewport.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    try { await page.render({ canvasContext: ctx, viewport: viewport }).promise; } catch (e) { return []; }

    const pageArea = cv.width * cv.height;
    const out = [];
    rects.forEach(function (r) {
      let rv;
      try { rv = viewport.convertToViewportRectangle([r.x0, r.y0, r.x1, r.y1]); } catch (e) { return; }
      const x = Math.max(0, Math.min(rv[0], rv[2]));
      const y = Math.max(0, Math.min(rv[1], rv[3]));
      const w = Math.min(cv.width - x, Math.abs(rv[2] - rv[0]));
      const h = Math.min(cv.height - y, Math.abs(rv[3] - rv[1]));
      if (w < 36 || h < 22) return;                 // 太小：小图标、装饰线
      if (w * h > pageArea * 0.72) return;          // 太大：整页底图（扫描件）
      const k = Math.min(1, 1300 / w);
      const c2 = document.createElement('canvas');
      c2.width = Math.max(1, Math.round(w * k));
      c2.height = Math.max(1, Math.round(h * k));
      const cx = c2.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, c2.width, c2.height);
      cx.drawImage(cv, x, y, w, h, 0, 0, c2.width, c2.height);
      out.push({ src: c2.toDataURL('image/jpeg', 0.86), y: r.y1 });
    });
    return out;
  }

  /** PDF → {text, images}，text 里已经按位置插好【图N】占位 */
  async function fromPdfDoc(file, onProgress) {
    const pdfjs = await loadPdfjs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const out = [];
    const images = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(p / doc.numPages, '解析 PDF 第 ' + p + '/' + doc.numPages + ' 页');
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = [];
      let lastY = null, line = '';
      tc.items.forEach(function (it) {
        if (!it.str) return;
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 3) {
          if (line.trim()) lines.push({ y: lastY, t: line.trim() });
          line = '';
        }
        line += it.str;
        if (it.hasEOL) {
          if (line.trim()) lines.push({ y: y, t: line.trim() });
          line = '';
          lastY = null;
          return;
        }
        lastY = y;
      });
      if (line.trim()) lines.push({ y: lastY || 0, t: line.trim() });

      let imgs = [];
      try { imgs = await pageImages(pdfjs, page); } catch (e) { imgs = []; }

      // 文字行和图片按纵坐标从上到下合并，图在哪个位置就插在哪一行
      const seq = lines.map(function (l) { return { y: l.y, t: l.t }; });
      imgs.forEach(function (im) { seq.push({ y: im.y, img: im.src }); });
      seq.sort(function (a, b) { return b.y - a.y; });
      seq.forEach(function (it) {
        if (it.img) {
          images.push(it.img);
          out.push('【图' + images.length + '】');
        } else {
          out.push(it.t);
        }
      });
    }
    return { text: out.join('\n'), images: images };
  }

  /**
   * 提取文件文字
   * @param {File} file
   * @param {Function} [onProgress] (ratio, label)
   * @returns {Promise<string>}
   */
  async function extract(file, onProgress) {
    const r = await extractDoc(file, onProgress);
    return r.text;
  }

  /**
   * 提取文字 + 图形（Word 里的插图转为 dataURI，正文用【图N】占位）
   * @returns {Promise<{text:string, images:string[]}>}
   */
  async function extractDoc(file, onProgress) {
    const e = ext(file && file.name);
    if (e === 'docx') {
      const mammoth = await loadMammoth();
      const buf = await file.arrayBuffer();
      // 默认图片处理器会把内嵌图片转成 <img src="data:image/...;base64,...">
      const res = await mammoth.convertToHtml({ arrayBuffer: buf });
      const r = htmlToDoc(res && res.value ? res.value : '');
      // mammoth 读不出来的图（WMF/EMF 老格式、文本框/画布里）会静默丢掉 —— 收集提示告诉老师
      const msgs = (res && res.messages) || [];
      const bad = msgs.filter(function (m) { return /Unrecognized image type|image/i.test(String(m && m.message || '')); });
      const types = {};
      bad.forEach(function (m) {
        const mm = /image\/([a-z0-9.+-]+)/i.exec(String(m.message || ''));
        const t = mm ? mm[1].toLowerCase() : '未知格式';
        types[t] = (types[t] || 0) + 1;
      });
      const lost = bad.length;
      if (lost) {
        r.warn = '这份 Word 里有 ' + lost + ' 张图浏览器读不出来（' +
          Object.keys(types).map(function (t) { return t + ' ×' + types[t]; }).join('、') +
          '），这些图没法自动带进来。可以用手机拍一下这几张图，或把 Word 另存为 PDF 再导入。';
      }
      r.imageCount = r.images.length;
      return r;
    }
    if (e === 'doc') throw new Error('旧版 .doc 请先用 Word/WPS 另存为 .docx 再导入');
    if (e === 'pdf') return await fromPdfDoc(file, onProgress);
    if (e === 'txt') return { text: await file.text(), images: [] };
    throw new Error('暂不支持 .' + (e || '?') + ' 文件，请用 PDF / Word(.docx) / TXT');
  }

  /** 把 mammoth 输出的 HTML 还原为"一行文字/一图一行"的纯文本 + 图片列表 */
  function htmlToDoc(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = [];
    const images = [];

    function pushText(t) {
      String(t || '').split(/\r?\n/).forEach(function (seg) {
        if (seg.trim()) lines.push(seg.trim());
      });
    }

    function walk(node) {
      Array.from(node.childNodes).forEach(function (ch) {
        if (ch.nodeType === 3) { pushText(ch.nodeValue); return; }
        if (ch.nodeType !== 1) return;
        const tag = ch.tagName.toLowerCase();
        if (tag === 'img') {
          const src = ch.getAttribute('src') || '';
          if (src.indexOf('data:image') === 0) {
            images.push(src);
            lines.push('【图' + images.length + '】');
          }
        } else if (tag === 'br') {
          lines.push('');
        } else if (tag === 'p' || tag === 'li' || tag === 'tr' || /^h[1-6]$/.test(tag)) {
          walk(ch);
          lines.push('');
        } else {
          walk(ch);
        }
      });
    }

    walk(doc.body);
    const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: text, images: images };
  }

  return { extract, extractDoc };
})();
