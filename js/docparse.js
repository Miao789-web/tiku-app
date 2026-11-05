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

  async function fromPdf(file, onProgress) {
    const pdfjs = await loadPdfjs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const pages = [];
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
          if (line.trim()) lines.push(line.trim());
          line = '';
        }
        line += it.str;
        if (it.hasEOL) {
          if (line.trim()) lines.push(line.trim());
          line = '';
          lastY = null;
          return;
        }
        lastY = y;
      });
      if (line.trim()) lines.push(line.trim());
      pages.push(lines.join('\n'));
    }
    return pages.join('\n');
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
      return htmlToDoc(res && res.value ? res.value : '');
    }
    if (e === 'doc') throw new Error('旧版 .doc 请先用 Word/WPS 另存为 .docx 再导入');
    if (e === 'pdf') {
      const text = await fromPdf(file, onProgress);
      return { text: text, images: [] };
    }
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
