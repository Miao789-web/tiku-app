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

  async function recognizeTesseract(blob, onProgress) {
    const w = await getWorker(onProgress);
    if (onProgress) onProgress(0.5, '正在识别文字');
    const enhanced = await ImageTool.enhanceForOCR(blob);
    const res = await w.recognize(enhanced);
    const text = (res && res.data && res.data.text) || '';
    return tidy(text);
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

  function destroy() {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null; loading = null;
  }

  return { recognize, destroy, tidy };
})();
