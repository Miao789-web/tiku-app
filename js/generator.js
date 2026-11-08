/* =========================================================
 * generator.js — 举一反三出题
 * ---------------------------------------------------------
 * 三级策略：
 *   1. 大模型仿写（配置了 Key 时）：按原题 + 考点 + 思路改数字改情境
 *   2. 本地模板：覆盖小学数学高频考点，参数化随机出题并算好答案
 *   3. 数字变体：把原题中的数字替换成相近量级的新数字，答案留空供老师编辑
 * ========================================================= */
const Generator = (function () {

  function ri(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }
  function lcm(a, b) { return a / gcd(a, b) * b; }
  function frac(n, d) {
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(Math.abs(n), d) || 1;
    n /= g; d /= g;
    return d === 1 ? String(n) : n + '/' + d;
  }

  /* ---------------- 各考点模板 ---------------- */
  const TEMPLATES = [
    {
      match: /三角形面积/,
      gen() {
        let a, h;
        do { a = ri(3, 20); h = ri(3, 20); } while ((a * h) % 2);
        const S = a * h / 2;
        const askH = Math.random() < 0.5;
        const lu = pick(['厘米', '分米', '米']);
        const au = '平方' + lu;
        return askH
          ? { text: `一个三角形的面积是 ${S} ${au}，底是 ${a} ${lu}，它的高是多少${lu}？`,
              answer: `${h} ${lu}`, solution: `由 S=ah÷2 得 h=2S÷a=${2 * S}÷${a}=${h}（${lu}）。`, type: '解答题', difficulty: 2 }
          : { text: `一个三角形的面积是 ${S} ${au}，高是 ${h} ${lu}，它的底是多少${lu}？`,
              answer: `${a} ${lu}`, solution: `由 S=ah÷2 得 a=2S÷h=${2 * S}÷${h}=${a}（${lu}）。`, type: '解答题', difficulty: 2 };
      }
    },
    {
      match: /平行四边形/,
      gen() {
        const a = ri(6, 24), h = ri(3, 15);
        const lu = pick(['厘米', '分米', '米']);
        const au = '平方' + lu;
        if (Math.random() < 0.7) {
          return { text: `一个平行四边形的底是 ${a} ${lu}，高是 ${h} ${lu}，面积是多少${au}？`,
            answer: `${a * h} ${au}`, solution: `S=ah=${a}×${h}=${a * h}。`, type: '解答题', difficulty: 1 };
        }
        return { text: `一个平行四边形的面积是 ${a * h} ${au}，底是 ${a} ${lu}，高是多少${lu}？`,
          answer: `${h} ${lu}`, solution: `h=S÷a=${a * h}÷${a}=${h}（${lu}）。`, type: '解答题', difficulty: 2 };
      }
    },
    {
      match: /长方形|正方形/,
      gen() {
        const a = ri(5, 20), b = ri(2, a - 1);
        const S = a * b, C = 2 * (a + b);
        if (Math.random() < 0.5) {
          return { text: `一块长方形菜地长 ${a} 米、宽 ${b} 米，它的面积是多少平方米？周长是多少米？`,
            answer: `${S} 平方米；${C} 米`, solution: `面积=长×宽=${a}×${b}=${S}；周长=(长+宽)×2=(${a}+${b})×2=${C}。`, type: '解答题', difficulty: 1 };
        }
        return { text: `一个长方形的面积是 ${S} 平方厘米，宽是 ${b} 厘米，长是多少厘米？`,
          answer: `${a} 厘米`, solution: `长=面积÷宽=${S}÷${b}=${a}（厘米）。`, type: '解答题', difficulty: 2 };
      }
    },
    {
      match: /圆的|圆|半径|直径/,
      gen() {
        const r = ri(1, 10), C = Math.round(2 * 3.14 * r * 10) / 10, S = Math.round(3.14 * r * r * 100) / 100;
        if (Math.random() < 0.5) {
          return { text: `一个圆的半径是 ${r} 厘米，它的周长是多少厘米？（π 取 3.14）`,
            answer: `${C} 厘米`, solution: `C=2πr=2×3.14×${r}=${C}（厘米）。`, type: '解答题', difficulty: 1 };
        }
        return { text: `一个圆的直径是 ${2 * r} 厘米，它的面积是多少平方厘米？（π 取 3.14）`,
          answer: `${S} 平方厘米`, solution: `r=${2 * r}÷2=${r}，S=πr²=3.14×${r}²=${S}（平方厘米）。`, type: '解答题', difficulty: 2 };
      }
    },
    {
      match: /长方体|正方体/,
      gen() {
        const a = ri(2, 9), b = ri(2, 9), c = ri(2, 9);
        return { text: `一个长方体木箱长 ${a} 分米、宽 ${b} 分米、高 ${c} 分米，它的体积是多少立方分米？`,
          answer: `${a * b * c} 立方分米`, solution: `V=abh=${a}×${b}×${c}=${a * b * c}（立方分米）。`, type: '解答题', difficulty: 1 };
      }
    },
    {
      match: /分数加减|分数加减法/,
      gen() {
        const d1 = pick([2, 3, 4, 5, 6, 8]);
        let d2 = pick([2, 3, 4, 5, 6, 8, 10, 12]);
        if (d2 === d1) d2 = d1 * 2;
        let a = ri(1, d1 - 1), b = ri(1, d2 - 1);
        const L = lcm(d1, d2);
        let op = Math.random() < 0.5 ? '+' : '-';
        // 小学阶段避免出现负数：减法保证被减数大
        if (op === '-' && a * (L / d1) < b * (L / d2)) {
          const t = a; a = b; b = t;
          const td = d1; d1 = d2; d2 = td;
          if (a >= d1) a = d1 - 1;
          if (a * (L / d1) < b * (L / d2)) op = '+';
        }
        const n = op === '+' ? a * (L / d1) + b * (L / d2) : a * (L / d1) - b * (L / d2);
        return { text: `计算：${a}/${d1} ${op} ${b}/${d2}`,
          answer: frac(n, L), solution: `通分到分母 ${L}：${a * (L / d1)}/${L} ${op} ${b * (L / d2)}/${L}=${frac(n, L)}。`, type: '计算题', difficulty: 2 };
      }
    },
    {
      match: /解方程|一元一次方程/,
      gen() {
        const x = ri(2, 12), a = ri(2, 9), b = ri(1, 20);
        const plus = Math.random() < 0.5;
        const y = plus ? a * x + b : a * x - b;
        return { text: `解方程：${a}x ${plus ? '+' : '−'} ${b} = ${y}`,
          answer: `x = ${x}`, solution: `${plus ? '两边先减' : '两边先加'} ${b}，得 ${a}x=${a * x}，再除以 ${a}，x=${x}。`, type: '计算题', difficulty: 1 };
      }
    },
    {
      match: /因数|倍数|公因数|公倍数/,
      gen() {
        const m = ri(4, 18), n = ri(4, 18);
        const g = gcd(m, n), l = lcm(m, n);
        if (Math.random() < 0.5) {
          return { text: `求 ${m} 和 ${n} 的最大公因数。`,
            answer: String(g), solution: `${m}=${factorStr(m)}，${n}=${factorStr(n)}，公共质因数相乘得 ${g}。`, type: '填空题', difficulty: 2 };
        }
        return { text: `求 ${m} 和 ${n} 的最小公倍数。`,
          answer: String(l), solution: `先用短除法求出最大公因数 ${g}，再 ${g}×${m / g}×${n / g}=${l}。`, type: '填空题', difficulty: 2 };
      }
    },
    {
      match: /可能性|概率/,
      gen() {
        const r = ri(1, 5), w = ri(1, 6), y = ri(0, 3);
        const total = r + w + y;
        return { text: `袋子里有 ${r} 个红球、${w} 个白球${y ? `和 ${y} 个黄球` : ''}，任意摸一个，摸到红球的可能性是多少？`,
          answer: frac(r, total), solution: `球共 ${total} 个，红球 ${r} 个，可能性为 ${r}/${total}=${frac(r, total)}。`, type: '填空题', difficulty: 2 };
      }
    },
    {
      match: /行程|相遇|追及|速度/,
      gen() {
        const v1 = ri(6, 14) * 5, v2 = ri(4, 10) * 5, t = ri(2, 5);
        const D = (v1 + v2) * t;
        if (Math.random() < 0.5) {
          return { text: `甲、乙两地相距 ${D} 千米，一辆客车每小时行 ${v1} 千米，一辆货车每小时行 ${v2} 千米，两车同时从两地相向开出，几小时后相遇？`,
            answer: `${t} 小时`, solution: `相遇时间=总路程÷速度和=${D}÷(${v1}+${v2})=${t}（小时）。`, type: '应用题', difficulty: 2 };
        }
        return { text: `两车同时从相距 ${D} 千米的两地相向开出，${t} 小时后相遇。客车每小时行 ${v1} 千米，货车每小时行多少千米？`,
          answer: `${v2} 千米`, solution: `速度和=${D}÷${t}=${v1 + v2}，货车速度=${v1 + v2}−${v1}=${v2}（千米/时）。`, type: '应用题', difficulty: 3 };
      }
    },
    {
      match: /百分数|折扣|打折/,
      gen() {
        const p = ri(4, 30) * 10, d = pick([5, 6, 7, 8, 9]);
        if (Math.random() < 0.5) {
          return { text: `一件衣服原价 ${p} 元，打 ${d} 折出售，现价是多少元？`,
            answer: `${p * d / 10} 元`, solution: `现价=原价×折扣=${p}×${d / 10}=${p * d / 10}（元）。`, type: '应用题', difficulty: 2 };
        }
        return { text: `一台电风扇打 ${d} 折后是 ${p * d / 10} 元，这台电风扇原价是多少元？`,
          answer: `${p} 元`, solution: `原价=现价÷折扣=${p * d / 10}÷${d / 10}=${p}（元）。`, type: '应用题', difficulty: 2 };
      }
    },
    {
      match: /单位换算/,
      gen() {
        const table = [
          ['平方米', '平方分米', 100], ['平方分米', '平方厘米', 100], ['米', '厘米', 100],
          ['千克', '克', 1000], ['升', '毫升', 1000], ['时', '分', 60]
        ];
        const [big, small, rate] = pick(table);
        const n = ri(2, 90) / 10;
        return { text: `${n} ${big} = （　）${small}`,
          answer: `${Math.round(n * rate * 100) / 100} ${small}`, solution: `${big}化${small}乘进率 ${rate}：${n}×${rate}=${Math.round(n * rate * 100) / 100}。`, type: '填空题', difficulty: 1 };
      }
    },
    {
      match: /简便|四则混合|运算定律/,
      gen() {
        const a = ri(3, 30), b = ri(2, 40), c = ri(2, 60);
        if (Math.random() < 0.5) {
          return { text: `简便计算：25 × ${a} × 4`,
            answer: String(100 * a), solution: `25×4=100，再 ×${a}=${100 * a}（乘法交换律）。`, type: '计算题', difficulty: 2 };
        }
        return { text: `简便计算：${b} × ${a} + ${b} × ${c % 20}`,
          answer: String(b * (a + c % 20)), solution: `逆用乘法分配律：${b}×(${a}+${c % 20})=${b}×${a + c % 20}=${b * (a + c % 20)}。`, type: '计算题', difficulty: 3 };
      }
    },
    {
      match: /工程|工作效率/,
      gen() {
        for (let i = 0; i < 200; i++) {
          const a = ri(2, 12), b = ri(2, 12);
          if (a !== b && (a * b) % (a + b) === 0) {
            const t = a * b / (a + b);
            return { text: `一项工程，甲队单独做 ${a} 天完成，乙队单独做 ${b} 天完成。两队合作，多少天完成？`,
              answer: `${t} 天`, solution: `把总量看作 1，效率和=1/${a}+1/${b}，合作天数=1÷(1/${a}+1/${b})=${t}（天）。`, type: '应用题', difficulty: 3 };
          }
        }
        return null;
      }
    }
  ];

  function factorStr(n) {
    const out = [];
    let m = n;
    for (let p = 2; p <= m; p++) {
      while (m % p === 0) { out.push(p); m /= p; }
    }
    return out.join('×') || String(n);
  }

  /* ---------------- 数字变体兜底 ---------------- */
  /** 把题干里的数字换成相近量级的新数字；
   *  日期（如 2025年10月8日）近两年的原样保留——举一反三重点是改数量关系里的数据 */
  function mutateNumbers(text) {
    const cy = new Date().getFullYear();
    const DATE_RE = /(\d{4})\s*年(?:\s*(\d{1,2})\s*月)?(?:\s*(\d{1,2})\s*[日号])?/g;
    const dates = [];
    const withTokens = String(text || '').replace(DATE_RE, function (m, y) {
      dates.push({ m: m, y: parseInt(y, 10), recent: parseInt(y, 10) >= cy - 1 });
      return '\x00' + (dates.length - 1) + '\x01';
    });
    const out = withTokens.replace(/\d+(\.\d+)?/g, function (m) {
      const v = parseFloat(m);
      if (v <= 2) return String(v);
      const delta = Math.max(1, Math.round(v * 0.3));
      const nv = Number.isInteger(v)
        ? Math.max(1, v + ri(-delta, delta))
        : Math.round((v + (Math.random() - 0.5) * delta) * 10) / 10;
      return String(nv === v ? v + 1 : nv);
    });
    return out.replace(/\x00(\d+)\x01/g, function (m, i) {
      const d = dates[+i];
      if (!d) return '';
      if (d.recent) return d.m;                      // 近两年：日期不动
      const ny = Math.max(2015, d.y + ri(-2, 2));    // 更早的日期只换年份，月日不动
      return d.m.replace(String(d.y), String(ny === d.y ? d.y - 1 : ny));
    });
  }

  /* ---------------- 对外接口 ---------------- */
  async function generate(opts) {
    const question = opts.question || {};
    const point = opts.point || '';
    const count = opts.count || 3;

    // 1) 大模型仿写
    if (AI.enabled()) {
      try {
        const items = await AI.similar(question, count, opts);
        if (items && items.length) return { items: items, mode: 'ai' };
      } catch (e) { /* 降级 */ }
    }

    // 2) 本地模板
    const probe = (point || '') + ' ' + (question.text || '');
    const tpl = TEMPLATES.find(t => t.match.test(probe));
    if (tpl) {
      const items = [];
      const seen = {};
      for (let i = 0; i < count * 6 && items.length < count; i++) {
        const g = tpl.gen();
        if (g && !seen[g.text]) { seen[g.text] = 1; items.push(g); }
      }
      if (items.length) return { items: items, mode: 'template' };
    }

    // 3) 数字变体
    const items = [];
    for (let i = 0; i < count; i++) {
      items.push({
        text: mutateNumbers(question.text),
        answer: '',
        solution: question.solution || '（请核对题目后填写思路与答案）',
        type: question.type || '解答题',
        difficulty: question.difficulty || 2
      });
    }
    return { items: items, mode: 'mutate' };
  }

  return { generate };
})();
