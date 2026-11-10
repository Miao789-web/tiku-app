/* =========================================================
 * ocr.js — OCR 服务适配层
 * ---------------------------------------------------------
 * provider:
 *   tesseract  纯前端，免 Key，首次需下载中文模型（约 15MB）
 *   baidu      百度通用文字识别，需 Key + 代理（server/ocr-proxy.mjs）
 *   tencent    腾讯云通用印刷体识别，需 Key + 代理
 *   manual     跳过识别，手动粘贴文字
 * ========================================================= */
const OCR = (function () {
  let worker = null;
  let loading = null;

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('图片读取失败')); };
      fr.readAsDataURL(blob);
    });
  }

  /* ---------------- Tesseract.js ---------------- */
  async function getWorker(onProgress) {
    const cfg = CONFIG.ocr.tesseract;
    if (worker) return worker;
    if (!loading) {
      loading = (async function () {
        try {
          await Util.loadScript(cfg.cdn);
        } catch (e) {
          // 主 CDN 被墙/失败时自动换备用源
          await Util.loadScript('https://unpkg.com/tesseract.js@5.1.0/dist/tesseract.min.js');
        }
        if (!window.Tesseract) throw new Error('OCR 引擎加载失败，请检查网络');
        const w = await window.Tesseract.createWorker(cfg.langs, 1, {
          workerPath: cfg.workerPath,
          corePath: cfg.corePath,
          langPath: cfg.langPath,
          logger: function (m) {
            if (typeof loading.onProgress === 'function' && m && m.progress != null) {
              loading.onProgress(m.status === 'recognizing text' ? m.progress : m.progress * 0.4, m.status);
            }
          }
        });
        await w.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: '6',   // 按整块文字识别，练习册照片比自动分割准
          user_defined_dpi: '300'
        });
        worker = w;
        return w;
      })();
      loading.onProgress = onProgress;
    } else if (onProgress) {
      loading.onProgress = onProgress;
    }
    return loading;
  }

  /** 把 tesseract 结果里的行（含 bbox）拍平：用于把红笔答案对到具体题目 */
  function flatLines(data) {
    const out = [];
    try {
      (data.blocks || []).forEach(function (b) {
        (b.paragraphs || []).forEach(function (p) {
          (p.lines || []).forEach(function (l) {
            const txt = String(l.text || '').trim();
            if (txt) {
              const bb = l.bbox || {};
              out.push({ text: txt, y: bb.y0 || 0, h: Math.max(0, (bb.y1 || 0) - (bb.y0 || 0)) });
            }
          });
        });
      });
    } catch (e) { /* blocks 结构缺失时返回空数组 */ }
    return out;
  }

  /** 带版面的识别：返回 { text, lines:[{text,y,h}] }；云 OCR / 异常时 lines 为空 */
  async function recognizeLayout(blob, onProgress) {
    const p = CONFIG.ocr.provider;
    if (p === 'baidu' || p === 'tencent') return { text: await callProxy(p, blob), lines: [] };
    if (p === 'manual') throw new Error('当前为手动录入模式');
    const w = await getWorker(onProgress);
    if (onProgress) onProgress(0.5, '正在识别文字');
    const enhanced = await ImageTool.enhanceForOCR(blob);
    const res = await w.recognize(enhanced, {}, { text: true, blocks: true });
    const data = (res && res.data) || {};
    return { text: tidy(data.text || ''), lines: flatLines(data) };
  }

  async function recognizeTesseract(blob, onProgress) {
    const lay = await recognizeLayout(blob, onProgress);
    return lay.text;
  }

  /* 中文 OCR 常见问题：汉字之间被插入空格、全角数字字母、控制类乱码字符 */
  function tidy(text) {
    return String(text || '')
      .replace(/\r/g, '')
      // 全角数字/字母转半角（０-９ Ａ-Ｚ ａ-ｚ）
      .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      // 去掉制表符/控制符/制表框线等典型乱码字符
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u2500-\u257F\uFFF0-\uFFFF]/g, '')
      .replace(/[ \t]+/g, ' ')
      // 数学符号常见误读修正：小数点→逗号、× →X、÷ →工
      .replace(/(\d)\s*[，,]\s*(\d)/g, '$1.$2')
      .replace(/(\d)\s*[Xx×✕]\s*(\d)/g, '$1×$2')
      .replace(/(\d)\s*工\s*(\d)/g, '$1÷$2')
      // 逐行处理：题号"2. "后的空格保留，行内小数"2. 3"合并为"2.3"；
      // 题号丢点（行首数字直接接"一/两/一个"）补回". "
      .split('\n').map(function (line) {
        const m = line.match(/^(\d{1,2})[.．]\s*/);
        let head = '', rest = line;
        if (m) { head = m[1] + '. '; rest = line.slice(m[0].length); }
        else {
          const lost = line.match(/^(\d)(一|两)/);
          if (lost) { head = lost[1] + '. '; rest = line.slice(1); }
        }
        rest = rest.replace(/(\d)\.\s+(\d)/g, '$1.$2');
        return head + rest;
      }).join('\n')
      // 中文及常用标点之间的空格合并
      .replace(/([\u4e00-\u9fa5，。；：、！？“”‘’（）《》—…])\s+(?=[\u4e00-\u9fa5，。；：、！？“”‘’（）《》—…])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ---------------- 云 OCR（经代理） ---------------- */
  async function callProxy(provider, blob) {
    const base = (CONFIG.ocr.proxyUrl || '').replace(/\/$/, '');
    if (!base) throw new Error('未配置 proxyUrl，无法调用云 OCR');
    const dataUrl = await blobToDataURL(blob);
    const resp = await fetch(base + '/' + provider, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ⚠️ Key 由代理服务读取环境变量，前端不接触密钥
      body: JSON.stringify({ image: dataUrl.split(',')[1], contentType: 'image/jpeg' })
    });
    if (!resp.ok) throw new Error('OCR 接口返回 ' + resp.status);
    const json = await resp.json();
    if (json.error) throw new Error(json.error);
    return tidy(json.text || (json.lines || []).join('\n'));
  }

  async function recognize(blob, onProgress) {
    const p = CONFIG.ocr.provider;
    if (p === 'manual') throw new Error('当前为手动录入模式');
    if (p === 'baidu') return callProxy('baidu', blob);
    if (p === 'tencent') return callProxy('tencent', blob);
    return recognizeTesseract(blob, onProgress);
  }

  /* ---------------- 红笔答案识别 ----------------
   * 练习册上一般用红笔写答案：先把红色像素按颜色抠出来，
   * 再把红色区域单独交给 OCR（数字白名单）识别。
   * 手写体识别不一定完全准确，结果只作为参考，老师需核对。 */

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('图片加载失败')); };
      img.src = src;
    });
  }

  function imageToCanvas(img, maxSide) {
    const scale = Math.min(1, (maxSide || 1600) / Math.max(img.width || 1, img.height || 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round((img.width || 1) * scale));
    c.height = Math.max(1, Math.round((img.height || 1) * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  /** 纯函数（便于自测）：在 canvas 里找红色像素 → { ratio, mask, box }；mask 是红笔黑白的二值图 */
  function redMaskOf(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const od = octx.createImageData(w, h);
    let red = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        // 红笔判定：红通道明显高于绿蓝（排除黑字、灰底、蓝笔）
        const isRed = r > 95 && r - g > 45 && r - b > 45;
        if (isRed) {
          red++;
          od.data[i] = 0; od.data[i + 1] = 0; od.data[i + 2] = 0; od.data[i + 3] = 255;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        } else {
          od.data[i] = 255; od.data[i + 1] = 255; od.data[i + 2] = 255; od.data[i + 3] = 255;
        }
      }
    }
    octx.putImageData(od, 0, 0);
    return { ratio: red / (w * h), mask: out, box: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } };
  }

  /**
   * 识别图里的红笔内容。src 可以是 Blob 或 dataURL。
   * 返回 { found, text?, ratio?, items?: [{text, y, h}], height? }
   * items 是红色字按「行的位置」拆开的结果（y 为原图坐标），用来把答案对到具体题目附近。
   * 异常一律返回 found:false，不打断主流程。
   */
  async function redAnswer(src) {
    try {
      const url = (src && src instanceof Blob) ? await blobToDataURL(src) : src;
      if (!url) return { found: false };
      const img = await loadImage(url);
      const canvas = imageToCanvas(img, 1600);
      const m = redMaskOf(canvas);
      if (!m.box || m.ratio < 0.0015) return { found: false, ratio: m.ratio };
      const pad = 10;
      const bx = Math.max(0, m.box.x - pad), by = Math.max(0, m.box.y - pad);
      const bw = Math.min(canvas.width - bx, m.box.w + pad * 2);
      const bh = Math.min(canvas.height - by, m.box.h + pad * 2);
      const crop = document.createElement('canvas');
      crop.width = bw; crop.height = bh;
      crop.getContext('2d').drawImage(m.mask, bx, by, bw, bh, 0, 0, bw, bh);
      // 红色区域单独识别：数字/分数/运算符白名单（只在 tesseract 引擎下做）
      const p = CONFIG.ocr.provider;
      if (p === 'baidu' || p === 'tencent' || p === 'manual') return { found: true, text: '', ratio: m.ratio, needManual: true };
      const w = await getWorker(null);
      await w.setParameters({ tessedit_char_whitelist: '0123456789./=+−×÷():：' });
      let text = '';
      let lines = [];
      try {
        const res = await w.recognize(crop, {}, { text: true, blocks: true });
        text = (res && res.data && res.data.text) || '';
        // 行的 bbox 加上裁剪偏移 → 换算回整页坐标
        lines = flatLines((res && res.data) || {}).map(function (l) {
          return { text: l.text, y: by + l.y, h: l.h };
        });
      } finally {
        try { await w.setParameters({ tessedit_char_whitelist: '' }); } catch (e) { /* 恢复失败不影响 */ }
      }
      text = String(text).replace(/[\s\u3000]+/g, ' ').replace(/^[^\d(（]+/, '').trim();
      if (!/\d/.test(text)) return { found: true, text: '', ratio: m.ratio, height: canvas.height };
      // 把挨得很近的红字行并成一条答案（同一个答案可能被拆成两行）
      const items = [];
      lines
        .filter(function (l) { return /\d/.test(l.text); })
        .sort(function (a, b) { return a.y - b.y; })
        .forEach(function (l) {
          const last = items[items.length - 1];
          const clean = String(l.text).replace(/[\s\u3000]+/g, ' ').trim();
          if (last && l.y - (last.y + (last.h || 0)) < 42) {
            last.text = (last.text + ' ' + clean).trim();
            last.h = Math.max(last.h || 0, l.y + (l.h || 0) - last.y);
          } else {
            items.push({ text: clean, y: l.y, h: l.h || 0 });
          }
        });
      // 拿不到行位置时：按识别文本里的片段均匀铺到整页，尽量还能对上题
      if (!items.length) {
        const parts = text.split(/\s+/).filter(function (x) { return /\d/.test(x); });
        parts.forEach(function (tx, i) {
          items.push({ text: tx, y: Math.round((i + 0.5) / Math.max(1, parts.length) * canvas.height), h: 0 });
        });
      }
      return { found: true, text: text, ratio: m.ratio, items: items, height: canvas.height };
    } catch (e) {
      return { found: false, error: e && e.message };
    }
  }

  function destroy() {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null; loading = null;
  }

  return { recognize, recognizeLayout, redAnswer, redMaskOf, flatLines, destroy, tidy };
})();
