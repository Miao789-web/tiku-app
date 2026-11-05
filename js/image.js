/* =========================================================
 * image.js — 图片压缩 / 旋转 / 裁剪（全部在浏览器本地完成）
 * ========================================================= */
const ImageTool = (function () {

  function loadBitmap(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob).catch(function () { return loadByImg(blob); });
    }
    return loadByImg(blob);
  }

  function loadByImg(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight, _img: img });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  function toBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality || 0.86);
      else resolve(dataURLToBlob(canvas.toDataURL('image/jpeg', quality || 0.86)));
    });
  }

  function dataURLToBlob(d) {
    const parts = d.split(',');
    const mime = /:(.*?);/.exec(parts[0])[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /** 压缩：长边不超过 maxSide，输出 jpeg */
  async function compress(file, maxSide, quality) {
    maxSide = maxSide || (CONFIG.image && CONFIG.image.maxSide) || 2000;
    quality = quality || (CONFIG.image && CONFIG.image.quality) || 0.86;
    const bmp = await loadBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp._img || bmp, 0, 0, w, h);
    const blob = await toBlob(c, quality);
    return { blob: blob, width: w, height: h };
  }

  /** 旋转 90° 的整数倍 */
  async function rotate(blob, deg) {
    const bmp = await loadBitmap(blob);
    const src = bmp._img || bmp;
    const rad = (deg * Math.PI) / 180;
    const swap = Math.abs(deg / 90) % 2 === 1;
    const w = swap ? bmp.height : bmp.width;
    const h = swap ? bmp.width : bmp.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.translate(w / 2, h / 2);
    ctx.rotate(rad);
    ctx.drawImage(src, -bmp.width / 2, -bmp.height / 2);
    return toBlob(c, 0.9);
  }

  /** 裁剪：rect 使用原图像素坐标 {x,y,w,h} */
  async function crop(blob, rect) {
    const bmp = await loadBitmap(blob);
    const src = bmp._img || bmp;
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    const w = Math.max(1, Math.min(bmp.width - x, Math.round(rect.w)));
    const h = Math.max(1, Math.min(bmp.height - y, Math.round(rect.h)));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
    return toBlob(c, 0.9);
  }

  /** 供 OCR 用：小图放大 + 灰度 + Otsu 自适应二值化，对抗阴影和光照不均 */
  async function enhanceForOCR(blob) {
    let bmp;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
      bmp = await loadBitmap(blob);
    }
    const src = bmp._img || bmp;
    // 整页拍照字很小：长边放大到 2600px 左右（约 300dpi），小字才识别得动
    const long = Math.max(bmp.width, bmp.height);
    const scale = long < 2600 ? Math.min(3, 2600 / long) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    try {
      const img = ctx.getImageData(0, 0, w, h);
      const d = img.data;
      const n = w * h;
      // 1) 转灰度并统计直方图
      const hist = new Uint32Array(256);
      for (let i = 0, p = 0; p < n; p++, i += 4) {
        const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        d[i] = d[i + 1] = d[i + 2] = g;
        hist[g]++;
      }
      // 2) Otsu 大津法自动找黑白阈值
      let sum = 0;
      for (let t = 0; t < 256; t++) sum += t * hist[t];
      let sumB = 0, wB = 0, best = 0, th = 128;
      for (let t = 0; t < 256; t++) {
        wB += hist[t]; if (!wB) continue;
        const wF = n - wB; if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) { best = between; th = t; }
      }
      // 3) 二值化成纯黑白
      for (let i = 0, p = 0; p < n; p++, i += 4) {
        const v = d[i] > th ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* 跨域图片会抛错，忽略 */ }
    return toBlob(c, 0.92);
  }

  return { compress, rotate, crop, enhanceForOCR, toBlob, loadBitmap };
})();
