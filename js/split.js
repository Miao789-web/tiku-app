/* =========================================================
 * split.js — 题目切分
 * ---------------------------------------------------------
 * 处理三类题号：
 *   1. 2. 3.           → 新题
 *   （1）(2) ①②③     → 附属于当前题的小问
 *   一、二、三、        → 章节标题（丢弃，只作为边界）
 * 另外识别 A. B. C. D. 选项行，以及同一行里出现的多道题。
 * ========================================================= */
const Splitter = (function () {

  const RE_Q = /^(\d{1,3})\s*[.、．,，)）]\s*/;
  const RE_SUB = /^[（(]\s*(\d{1,2})\s*[)）]\s*/;
  const RE_CIRCLE = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/;
  const RE_OPT = /^([A-Da-d])\s*[.、．)）]\s*/;
  const RE_SECTION = /^[（(]?\s*[一二三四五六七八九十]{1,3}\s*[)）]?\s*[、.．]/;

  /* ---------- 同一行内的题号（"1. xxx 2. yyy"） ---------- */
  function findStarts(line) {
    const re = /(?:^|[\s，。；;、）)】\]])(\d{1,2})[.、．,，]\s*(?=[\u4e00-\u9fa5A-Za-z（(“"【])/g;
    const out = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      const idx = m.index + m[0].indexOf(m[1]);
      out.push({ index: idx, no: parseInt(m[1], 10) });
    }
    return out;
  }

  /* ---------- 同一行内的多个选项 ---------- */
  function splitOptions(line) {
    const re = /(?:^|\s)([A-D])\s*[.、．)）]\s*/g;
    const hits = [];
    let m;
    while ((m = re.exec(line)) !== null) {
      hits.push({ index: m.index + (m[0].length - m[0].replace(/^\s/, '').length), label: m[1] });
    }
    if (hits.length < 2) return null;
    return hits.map(function (h, i) {
      const end = i + 1 < hits.length ? hits[i + 1].index : line.length;
      return line.slice(h.index, end).trim();
    });
  }

  /* ---------- 先按“逻辑行”重组 ---------- */
  function logicalLines(text) {
    const raw = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    raw.forEach(function (line) {
      const l = line.replace(/[\t\u00a0]/g, ' ').replace(/ {2,}/g, ' ').trim();
      if (!l) return;
      const starts = findStarts(l);
      if (starts.length >= 2) {
        starts.forEach(function (s, i) {
          const end = i + 1 < starts.length ? starts[i + 1].index : l.length;
          const seg = l.slice(s.index, end).trim();
          if (seg) out.push(seg);
        });
      } else {
        out.push(l);
      }
    });
    return out;
  }

  function newQuestion(no, text) {
    return { no: no, text: String(text || '').trim(), subs: [], options: [], raw: '' };
  }

  /* ---------- 主切分 ---------- */
  function split(text) {
    const lines = logicalLines(text);
    const items = [];
    let cur = null;

    function flush() {
      if (cur && (cur.text.trim() || cur.options.length)) {
        cur.raw = [cur.text].concat(cur.subs, cur.options).join('\n').trim();
        items.push(cur);
      }
      cur = null;
    }

    lines.forEach(function (line) {

      // 章节标题：作为分界，不保留
      if (RE_SECTION.test(line) && line.length <= 20) { flush(); return; }

      // 选项行（必须在题号之前判断，避免 "A. " 被当成正文）
      if (cur && RE_OPT.test(line)) {
        const opts = splitOptions(line);
        if (opts) cur.options = cur.options.concat(opts);
        else cur.options.push(line.replace(/\s+/g, ' '));
        return;
      }

      // 小问 （1）①
      if (RE_SUB.test(line) || RE_CIRCLE.test(line)) {
        if (!cur) { cur = newQuestion(null, line); return; }
        // 小问里也可能出现选项
        cur.subs.push(line);
        return;
      }

      // 新题
      const mq = line.match(RE_Q);
      if (mq) {
        flush();
        cur = newQuestion(parseInt(mq[1], 10), line.slice(mq[0].length));
        return;
      }

      // 普通正文
      if (!cur) { cur = newQuestion(null, line); return; }
      // 上一行是单行选项，这里可能是选项的续行
      if (cur.options.length && !RE_OPT.test(line) && line.length < 30) {
        cur.options[cur.options.length - 1] += ' ' + line;
        return;
      }
      cur.text += '\n' + line;
    });
    flush();

    // 没有任何题号时，整段作为一题
    if (!items.length) {
      const t = String(text || '').trim();
      if (t) { const q = newQuestion(null, t); q.raw = t; items.push(q); }
    }

    return items.map(postProcess);
  }

  /* ---------- 后处理：题型 / 难度 / 答案 ---------- */
  function fullText(q) {
    return [q.text].concat(q.subs || [], q.options || []).join('\n');
  }

  function detectType(q) {
    const t = fullText(q);
    if ((q.options || []).length >= 2) return '选择题';
    if (/判断|对的画|错的画|打“?√|打“?×/.test(t)) return '判断题';
    if (/[（(]\s*[)）]|_{2,}|＿{2,}|____/.test(t)) return '填空题';
    if (/计算|口算|竖式|脱式|解方程|直接写出得数|简便方法/.test(t)) return '计算题';
    if (/[=＝]/.test(t) && /[×÷]/.test(t)) return '计算题';
    if (/应用|多少|一共|还剩|平均|解决问题/.test(t)) return '应用题';
    return '解答题';
  }

  function detectDifficulty(q) {
    const t = fullText(q);
    let d = t.length > 140 ? 3 : t.length > 60 ? 2 : 1;
    if ((q.subs || []).length >= 2) d = Math.min(3, d + 1);
    return d;
  }

  function extractAnswer(text) {
    let answer = '', solution = '', body = text;
    const mAns = body.match(/(?:【答案】|答案[:：]|参考答案[:：])\s*([\s\S]*?)(?=【解析】|解析[:：]|【分析】|$)/);
    if (mAns) { answer = mAns[1].trim(); body = body.replace(mAns[0], ''); }
    const mSol = body.match(/(?:【解析】|解析[:：]|【分析】|分析[:：])\s*([\s\S]*)$/);
    if (mSol) { solution = mSol[1].trim(); body = body.replace(mSol[0], ''); }
    return { answer: answer, solution: solution, body: body.trim() };
  }

  function postProcess(q) {
    const joined = [q.text].concat(q.subs).join('\n');
    const ex = extractAnswer(joined);
    q.text = ex.body;
    q.answer = ex.answer;
    q.solution = ex.solution;
    q.type = detectType(q);
    q.difficulty = detectDifficulty(q);
    return q;
  }

  /* ---------- 手动拆分：按 cf（或 ---）分隔 ---------- */
  function splitByMarker(text) {
    return String(text || '')
      .split(/\n[ \t]*(?:-{3,}|cf)[ \t]*\n/i)
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
      .map(function (s, i) {
        const q = newQuestion(i + 1, s);
        q.raw = s;
        return postProcess(q);
      });
  }

  return { split, splitByMarker, fullText, detectType, detectDifficulty, splitOptions };
})();
