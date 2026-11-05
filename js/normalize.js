/* =========================================================
 * normalize.js — 考点名称归一化（解决同义标签分裂）
 * ---------------------------------------------------------
 * 三道关卡，依次尝试：
 *   1. 别名表 ALIAS_GROUPS：人工维护的同义词组，命中即用组内第一个名字
 *   2. 已有考点精确匹配（去空格/标点/“的”后比较）
 *   3. 相似度匹配（编辑距离 ≥ 0.86 且长度接近）→ 归并，并把旧名记入 aliases
 * 只有三关都过不了才新建考点，从源头减少“可能性大小 / 可能性的大小”这类分裂。
 * ========================================================= */
const Normalize = (function () {

  /* ---------- 1. 同义词组（可自行扩充，越靠前越优先） ---------- */
  const ALIAS_GROUPS = [
    ['三角形面积求高', '已知面积和底求高', '已知三角形面积求高', '三角形面积公式求高', '由面积求高', '三角形面积求底', '三角形面积求高或底'],
    ['平行四边形面积', '平行四边形面积计算', '平行四边形面积公式', '求平行四边形面积'],
    ['长方形与正方形的面积周长', '长方形面积', '正方形面积', '长方形周长', '正方形周长', '长方形和正方形的面积', '长方形正方形面积计算'],
    ['圆的周长与面积', '圆的面积', '圆的周长', '圆的面积计算', '圆环面积'],
    ['长方体正方体的体积与表面积', '长方体体积', '正方体体积', '长方体表面积', '正方体表面积', '长方体正方体体积'],
    ['圆柱与圆锥的体积', '圆柱体积', '圆锥体积', '圆柱的表面积', '圆柱侧面积'],
    ['分数加减法', '异分母分数加减法', '同分母分数加减法', '分数加减', '分数加减混合运算', '分数加法', '分数减法', '分数加减运算'],
    ['分数乘除法', '分数乘法', '分数除法', '分数乘除混合运算', '分数乘除法应用'],
    ['百分数应用', '百分数解决问题', '折扣问题', '折扣', '打折问题', '利息问题', '税率问题', '百分数', '成数问题', '浓度问题', '优惠问题'],
    ['比与比例', '按比例分配', '比例的应用', '化简比', '比的应用', '正比例与反比例'],
    ['一元一次方程', '解方程', '列方程解应用题', '一元一次方程应用', '方程的应用'],
    ['因数与倍数', '最大公因数', '最小公倍数', '质数与合数', '公因数与公倍数', '因数倍数'],
    ['可能性大小', '可能性的大小', '可能性比较', '可能性', '简单概率'],
    ['行程问题', '相遇问题', '追及问题', '速度时间路程', '平均速度', '流水行船'],
    ['工程问题', '工作效率问题', '合作完成工程', '水管进出水问题'],
    ['统计图', '条形统计图', '折线统计图', '扇形统计图', '统计图表的认识', '平均数与统计图'],
    ['单位换算', '长度单位换算', '面积单位换算', '质量单位换算', '体积单位换算', '时间单位换算'],
    ['四则混合运算', '脱式计算', '简便运算', '运算定律', '整数四则运算'],
    ['组合图形面积', '组合图形的面积', '阴影部分面积', '求阴影面积'],
    ['用字母表示数', '代数式', '化简求值', '整式加减'],
    ['平面图形的认识', '三角形三边关系', '图形的旋转与平移', '轴对称图形'],
    ['语文·字词辨析', '字音字形', '词语辨析', '错别字辨析', '字词积累'],
    ['语文·古诗文默写', '古诗默写', '文言文默写', '诗句填空'],
    ['语文·阅读理解', '现代文阅读', '记叙文阅读', '说明文阅读', '概括文章内容'],
    ['语文·修辞手法', '修辞手法辨析', '比喻拟人', '句子赏析'],
    ['英语·一般现在时', '一般现在时', '第三人称单数'],
    ['英语·一般过去时', '一般过去时', '过去式'],
    ['英语·词汇辨析', '词义辨析', '词汇运用', '单词拼写']
  ];

  /* ---------- 文本清洗 ---------- */
  const FILLERS = ['的计算方法', '的计算', '计算方法', '的求法', '求法', '的应用题', '的应用',
    '解决问题', '知识点', '考点', '题型', '问题', '练习'];

  function clean(s) {
    let t = String(s == null ? '' : s).trim();
    t = t.replace(/[\s\u3000]+/g, '');
    t = t.replace(/[，。、；：""''《》〈〉（）()【】\[\]!！?？,.;:·\-—_/\\|~]/g, '');
    t = t.replace(/的/g, '');
    return t.toLowerCase();
  }

  function simplify(s) {
    let t = clean(s);
    FILLERS.forEach(function (f) { t = t.split(clean(f)).join(''); });
    return t;
  }

  function norm(s) { return simplify(s); }

  /* ---------- 编辑距离相似度 ---------- */
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const d = lev(a, b);
    return 1 - d / Math.max(a.length, b.length);
  }

  /* ---------- 别名表索引 ---------- */
  const aliasIndex = (function () {
    const map = {};
    ALIAS_GROUPS.forEach(function (group) {
      const canonical = group[0];
      group.forEach(function (alias) { map[clean(alias)] = canonical; });
    });
    return map;
  })();

  /** 返回别名表里的规范名，没有则返回 null */
  function canonicalOf(name) {
    const c = clean(name);
    if (aliasIndex[c]) return aliasIndex[c];
    // 模糊命中别名（容忍 OCR 少字/多字）
    for (const key in aliasIndex) {
      if (Math.abs(key.length - c.length) <= 2 && similarity(key, c) >= 0.88) return aliasIndex[key];
    }
    return null;
  }

  function pretty(name) {
    let t = String(name || '').trim().replace(/\s+/g, '');
    t = t.replace(/^[0-9]+[.、．)）]/, '');
    t = t.replace(/[，。、；：]$/, '');
    return t.slice(0, 16);
  }

  /**
   * 归一化入口
   * @param {string} rawName AI/用户给出的考点名
   * @param {{subject:string, grade:string}} ctx
   * @returns {Promise<{point:object, isNew:boolean, matched:string, score:number}>}
   */
  async function resolve(rawName, ctx) {
    const subject = (ctx && ctx.subject) || '数学';
    const grade = (ctx && ctx.grade) || '五年级';

    const fixedName = canonicalOf(rawName);
    const target = pretty(fixedName || rawName || '未分类');
    const targetNorm = norm(target);

    const points = (await DB.all('points')).filter(function (p) {
      return p.subject === subject && p.grade === grade;
    });

    // 关卡 2：精确匹配（含别名列表）
    for (const p of points) {
      if (p.norm === targetNorm) {
        return { point: p, isNew: false, matched: 'exact', score: 1 };
      }
      const aliases = (p.aliases || []).map(clean);
      if (aliases.indexOf(targetNorm) >= 0 || aliases.indexOf(clean(rawName)) >= 0) {
        return { point: p, isNew: false, matched: 'alias', score: 0.96 };
      }
    }

    // 关卡 3：相似度匹配
    let best = null, bestScore = 0;
    points.forEach(function (p) {
      if (Math.abs((p.norm || '').length - targetNorm.length) > 3) return;
      const s = similarity(p.name, target);
      if (s > bestScore) { bestScore = s; best = p; }
    });
    if (best && bestScore >= 0.86) {
      const aliases = Array.from(new Set([].concat(best.aliases || [], [pretty(rawName)])));
      best.aliases = aliases;
      await DB.put('points', best);
      return { point: best, isNew: false, matched: 'fuzzy', score: bestScore };
    }

    // 兜底：包含关系（“三角形面积” ≈ “三角形面积求高”）
    for (const p of points) {
      const a = p.norm || '', b = targetNorm;
      const shorter = a.length < b.length ? a : b;
      const longer = a.length < b.length ? b : a;
      if (shorter.length >= 4 && longer.indexOf(shorter) >= 0 && longer.length - shorter.length <= 4) {
        const aliases = Array.from(new Set([].concat(p.aliases || [], [pretty(rawName)])));
        p.aliases = aliases;
        await DB.put('points', p);
        return { point: p, isNew: false, matched: 'contains', score: 0.8 };
      }
    }

    // 新建
    const point = {
      id: Util.uid('p'),
      name: target,
      norm: targetNorm,
      subject: subject,
      grade: grade,
      aliases: fixedName && pretty(rawName) !== target ? [pretty(rawName)] : [],
      count: 0,
      createdAt: Date.now()
    };
    await DB.put('points', point);
    return { point: point, isNew: true, matched: 'new', score: 1 };
  }

  return { resolve, similarity, canonicalOf, clean, norm, pretty, ALIAS_GROUPS };
})();
