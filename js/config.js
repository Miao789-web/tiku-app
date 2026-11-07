/* =========================================================
 * config.js — 【需要你自己填的地方都在这个文件】
 * ---------------------------------------------------------
 * 1) OCR：默认用 Tesseract.js（纯前端，无需 Key，中文模型首次约 15MB）
 *    想更准 → 改成百度/腾讯云 OCR，需要把 Key 填在下面，
 *    并且启动 server/ocr-proxy.mjs 代理（浏览器直连会跨域且泄露密钥）。
 * 2) 大模型：任意 OpenAI 兼容接口（DeepSeek / 通义 / 智谱 / OpenAI / Kimi）。
 *    不填也能用：会自动降级为「本地规则归类」，只是准确率一般。
 * 3) 这些值会被「我的 → 设置」里保存的配置覆盖（存在 localStorage）。
 * ========================================================= */
window.CONFIG = {
  app: {
    name: '题点',
    version: '1.3.0'
  },

  // 上传前压缩：长边不超过 2600px（整页小字也要够 OCR 用的分辨率）
  image: {
    maxSide: 2600,
    quality: 0.86
  },

  ocr: {
    // 'tesseract' | 'baidu' | 'tencent' | 'manual'
    provider: 'tesseract',

    // ⚠️ 云 OCR 必须走代理：由 server/ocr-proxy.mjs 转发（默认端口 8787）
    // 部署后把地址改成你的域名，例如 https://api.yourdomain.com/api/ocr
    proxyUrl: 'http://localhost:8787/api/ocr',

    // —— 百度 OCR（通用文字识别·标准版）——
    // 控制台：https://console.bce.baidu.com/ai/#/ai/ocr/overview/index
    baidu: {
      apiKey: '',      // 填入你的 API Key
      secretKey: ''    // 填入你的 Secret Key
    },

    // —— 腾讯云 OCR（通用印刷体识别）——
    // 控制台：https://console.cloud.tencent.com/ocr
    tencent: {
      secretId: '',    // 填入你的 SecretId
      secretKey: '',   // 填入你的 SecretKey
      region: 'ap-guangzhou'
    },

    tesseract: {
      langs: 'chi_sim+eng',
      // ⚠️ 国内网络实测：jsdelivr 被墙会连接重置，改用 cdnjs + unpkg（均已验证可直连）
      cdn: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.0/tesseract.min.js',
      workerPath: 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.0/worker.min.js',
      corePath: 'https://unpkg.com/tesseract.js-core@5.0.0',
      langPath: 'https://tessdata.projectnaptha.com/4.0.0'
    }
  },

  llm: {
    enabled: false,                                  // 填好 Key 后改成 true
    baseUrl: 'https://api.deepseek.com/v1',          // 可换成阿里/智谱/OpenAI 兼容地址
    apiKey: '',                                      // 填入你的 Key，如 'sk-xxxx'
    model: 'deepseek-chat',                          // 如 'qwen-plus' / 'glm-4-flash'
    temperature: 0.1,
    timeoutMs: 40000
  },

  // 题库目录的学科 / 学段（小学 1~6 年级）
  subjects: ['数学', '语文', '英语', '物理', '化学'],
  grades: ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'],

  questionTypes: ['选择题', '填空题', '判断题', '计算题', '解答题', '应用题'],
  reviewIntervals: [1, 2, 4, 7, 15, 30]  // 掌握后的复习间隔（天），Leitner 盒子
};

/* 读取用户在「设置」里的覆盖配置 */
(function () {
  try {
    const saved = JSON.parse(localStorage.getItem('tiku.config') || '{}');
    if (saved && typeof saved === 'object') {
      window.CONFIG.ocr = Object.assign({}, window.CONFIG.ocr, saved.ocr || {});
      window.CONFIG.llm = Object.assign({}, window.CONFIG.llm, saved.llm || {});
      if (saved.defaults) window.CONFIG.defaults = saved.defaults;
    }
  } catch (e) { /* 忽略损坏的本地配置 */ }
})();
