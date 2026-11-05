/* =========================================================
 * ai.js — 考点自动归类
 * ---------------------------------------------------------
 * 优先调用大模型（OpenAI 兼容接口），失败或未配置时降级为本地规则。
 * 关键点：把「已有考点列表」一起喂给模型，并要求优先复用，
 * 这样同一思路的题才会落到同一个标签上。
 * ========================================================= */
const AI = (function () {

  function enabled() {
    return !!(CONFIG.llm && CONFIG.llm.enabled && CONFIG.llm.apiKey);
  }

  function buildPrompt(items, ctx) {
    const known = (ctx.knownPoints || []).slice(0, 80).join('、') || '（暂无，可新建）';
    const list = items.map(function (it, i) {
      const body = [it.text].concat(it.subs || [], it.options || []).join('\n');
      return '[' + i + '] ' + body;
    }).join('\n\n');

    return [
      '你是中小学教研老师，请为下面每道题判断考点。',
      '',
      '【考点命名规则】',
      '1. 用"解题关键思路"命名，4-12 字，动宾或名词短语，例如"三角形面积求高""分数乘除混合运算"。',
      '2. 必须优先复用【已有考点】里的名称；确实不同才新建。',
      '3. 同一思路必须同名，禁止出现"可能性大小/可能性的大小"这类同义变体。',
      '',
      '【已有考点】' + known,
      '',
      '【输出字段】',
      '- point：考点名（严格遵守上面规则）',
      '- solution：解题关键思路，一句话说明第一步想到什么，不超过 40 字',
      '- type：选择题 / 填空题 / 判断题 / 计算题 / 解答题 / 应用题 之一',
      '- difficulty：1-3 的整数',
      '- answer：能确定就给出答案，否则空字符串',
      '- confidence：0-1，考点判断把握；不确定就给低分',
      '',
      '【题目】（学科：' + ctx.subject + '，年级：' + ctx.grade + '）',
      list,
      '',
      '只输出 JSON，不要任何解释：',
      '{"items":[{"index":0,"point":"","solution":"","type":"","difficulty":2,"answer":"","confidence":0.9}]}'
    ].join('\n');
  }

  function parseJson(text) {
    if (!text) throw new Error('模型返回为空');
    let s = String(text).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    return JSON.parse(s);
  }

  async function callLLM(items, ctx) {
    const cfg = CONFIG.llm;
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs || 40000);
    try {
      const resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // ⚠️ 这里用的是自己的 Key，仅存本地；生产环境建议走后端代理
          'Authorization': 'Bearer ' + cfg.apiKey
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: cfg.model,
          temperature: cfg.temperature == null ? 0.1 : cfg.temperature,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: '你是严谨的中小学教研老师，只输出 JSON。' },
            { role: 'user', content: buildPrompt(items, ctx) }
          ]
        })
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error('模型接口 ' + resp.status + '：' + t.slice(0, 120));
      }
      const json = await resp.json();
      const content = json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content : '';
      const data = parseJson(content);
      if (!data.items || !data.items.length) throw new Error('模型没有返回 items');
      return data.items;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 本地规则兜底 ---------------- */
  const RULES = [
    { re: /三角形[\s\S]{0,20}(面积|底|高)|面积[\s\S]{0,10}三角形/, point: '三角形面积求高',
      solution: 'S=ah÷2，反解 h=2S÷a：先算 2S 再除以底（或 a=2S÷h）。', type: '解答题' },
    { re: /平行四边形/, point: '平行四边形面积', solution: 'S=ah，底×对应高，注意高要与底垂直。' },
    { re: /(长方形|正方形)[\s\S]{0,20}(面积|周长)|(面积|周长)[\s\S]{0,10}(长方形|正方形)/,
      point: '长方形与正方形的面积周长', solution: '先分清求面积（长×宽）还是周长（(长+宽)×2），再代数据。' },
    { re: /(圆|半径|直径)[\s\S]{0,20}(面积|周长)|(面积|周长)[\s\S]{0,10}圆/, point: '圆的周长与面积',
      solution: '先由半径/直径定 r，再用 C=2πr、S=πr²；注意单位。' },
    { re: /(长方体|正方体)[\s\S]{0,20}(体积|表面积|棱长)/, point: '长方体正方体的体积与表面积',
      solution: '体积=长×宽×高；表面积按 6 个面配对计算，先列式再代入。' },
    { re: /(圆柱|圆锥)/, point: '圆柱与圆锥的体积', solution: 'V柱=πr²h，V锥=⅓πr²h，先统一单位再乘。' },
    { re: /可能性|概率|摸球|转盘/, point: '可能性大小', solution: '先数总数，再看满足条件的份数，用分数比较大小。' },
    { re: /(公因数|公倍数|因数|倍数|质数|合数|整除)/, point: '因数与倍数',
      solution: '先分解质因数或列举因数，再取公共部分判断最大/最小。' },
    { re: /(百分数|折扣|打折|折后|打[0-9一二三四五六七八九]{1,2}折|利率|利息|税率|成数|浓度)/, point: '百分数应用',
      solution: '先找单位"1"，判断是求部分、求总量还是求百分率，再列式。' },
    { re: /(分数)[\s\S]{0,12}(加|减)/, point: '分数加减法', solution: '异分母先通分，同分母分子相加减，结果要约分。' },
    { re: /(分数)[\s\S]{0,12}(乘|除)/, point: '分数乘除法', solution: '乘法分子乘分子；除法转成乘倒数，先约分再计算。' },
    { re: /(比|比例|按比例|正比例|反比例)/, point: '比与比例', solution: '先统一成比，再按总份数求一份的量，最后分配。' },
    { re: /(解方程|方程|设x|设 x)/i, point: '一元一次方程', solution: '设未知数→找等量关系列方程→移项合并→系数化 1。' },
    { re: /(相遇|追及|速度|路程|平均速度|相向|同向)/, point: '行程问题', solution: '抓"路程=速度×时间"，相遇看速度和，追及看速度差。' },
    { re: /(工程|工作效率|单独做|合作)/, point: '工程问题', solution: '把总量看作 1，效率=1÷时间，合作相加。' },
    { re: /(条形|折线|扇形|统计图|平均数)/, point: '统计图', solution: '先读图例与刻度，再按"总数×百分比"或差值计算。' },
    { re: /(单位换算|千米|厘米|毫升|平方米|公顷|吨)/, point: '单位换算', solution: '先写进率，大化小乘、小化大除，注意面积/体积是平方立方进率。' },
    { re: /(简算|简便|脱式|递等式|运算定律)/, point: '四则混合运算', solution: '先看能否用运算定律凑整，再按先乘除后加减的顺序算。' },
    { re: /(阴影|组合图形)/, point: '组合图形面积', solution: '割补/平移，把阴影转成规则图形的和或差。' },
    { re: /(古诗|默写|诗句|文言文)/, point: '语文·古诗文默写', solution: '先想诗题与作者，按上下句触发回忆，注意易错字。' },
    { re: /(修辞|比喻|拟人|排比|夸张)/, point: '语文·修辞手法', solution: '找标志词判断手法，再答"生动形象地写出……"。' },
    { re: /(字音|字形|错别字|词语|成语)/, point: '语文·字词辨析', solution: '按形近/音近分组比较，结合词义定字。' },
    { re: /(阅读|概括|中心思想|段意)/, point: '语文·阅读理解', solution: '先定位原文区间，再用"谁+做什么+结果"概括。' },
    { re: /(一般现在时|第三人称单数|every day|usually)/i, point: '英语·一般现在时', solution: '看主语：三单动词加 s/es，其余用原形。' },
    { re: /(一般过去时|yesterday|last|ago|过去式)/i, point: '英语·一般过去时', solution: '找过去时间标志，动词改过去式，注意不规则变化。' }
  ];

  function localClassify(items, ctx) {
    return items.map(function (it) {
      const text = ([it.text].concat(it.subs || [], it.options || [])).join(' ');
      for (const r of RULES) {
        if (r.re.test(text)) {
          return {
            point: r.point,
            solution: r.solution,
            type: r.type || it.type || '解答题',
            difficulty: it.difficulty || 2,
            answer: it.answer || '',
            confidence: 0.74
          };
        }
      }
      return {
        point: '未分类',
        solution: '暂未识别出解题思路，请手动指定考点。',
        type: it.type || '解答题',
        difficulty: it.difficulty || 2,
        answer: it.answer || '',
        confidence: 0.3
      };
    });
  }

  /**
   * @param {Array} items [{text, subs, options, type, difficulty, answer}]
   * @param {{subject, grade, knownPoints}} ctx
   * @returns {Promise<Array>} 与 items 等长
   */
  async function classify(items, ctx) {
    if (!items.length) return [];
    if (!enabled()) return localClassify(items, ctx || {});
    try {
      const out = await callLLM(items, ctx || {});
      const byIndex = {};
      out.forEach(function (o) { byIndex[o.index] = o; });
      return items.map(function (it, i) {
        const o = byIndex[i] || {};
        return {
          point: (o.point || '未分类').trim(),
          solution: (o.solution || '').trim(),
          type: o.type || it.type || '解答题',
          difficulty: Util.clamp(Number(o.difficulty) || it.difficulty || 2, 1, 3),
          answer: o.answer || '',
          confidence: typeof o.confidence === 'number' ? o.confidence : 0.75
        };
      });
    } catch (e) {
      console.warn('[AI] 模型调用失败，降级为本地规则：', e.message);
      const local = localClassify(items, ctx || {});
      local._fallback = true;
      local._error = e.message;
      return local;
    }
  }

  /** 举一反三：让模型仿写 n 道同类型题 */
  async function similar(question, n, ctx) {
    const cfg = CONFIG.llm;
    const body = [question.text].concat(question.subs || [], question.options || []).join('\n');
    const prompt = [
      '你是小学' + (ctx.subject || '数学') + '老师。请仿照原题出 ' + n + ' 道同类型题。',
      '',
      '【原题】', body,
      '【考点】' + (ctx.point || question.pointName || ''),
      '【解题思路】' + (question.solution || '(无)'),
      '',
      '要求：',
      '1. 只换数字和情境（人物、物品、场景），考点和解题步骤与原题一致；',
      '2. 数据自洽，答案是整数或简单分数，不要出现除不尽的数；',
      '3. 每题给 answer（答案）和 solution（一句话思路）。',
      '只输出 JSON：{"items":[{"text":"","answer":"","solution":""}]}'
    ].join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, cfg.timeoutMs || 40000);
    try {
      const resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: cfg.model, temperature: 0.8,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!resp.ok) throw new Error('模型接口 ' + resp.status);
      const json = await resp.json();
      const data = parseJson(json.choices[0].message.content);
      return (data.items || []).map(function (it) {
        return {
          text: String(it.text || '').trim(),
          answer: String(it.answer || '').trim(),
          solution: String(it.solution || '').trim(),
          type: question.type || '解答题',
          difficulty: question.difficulty || 2
        };
      }).filter(it => it.text);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 设置页里的连通性自测 */
  async function testConnect() {
    const cfg = CONFIG.llm;
    if (!cfg.apiKey) throw new Error('还没填 API Key');
    const resp = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '只回复两个字母：OK' }],
        max_tokens: 8
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + '：' + (await resp.text()).slice(0, 100));
    const j = await resp.json();
    return (j.choices && j.choices[0].message.content) || '连通';
  }

  return { classify, similar, enabled, testConnect, localClassify };
})();
