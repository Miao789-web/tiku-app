/* =========================================================
 * catalog.js — 教材目录
 * ---------------------------------------------------------
 * 按学科 + 年级 + 学期 + 版本自动生成目录；目录数据以人教版
 * 小学数学为参考，教师可在「设置 → 教材目录」里自行增删，
 * 自定义结果保存在本机（localStorage）。
 * ========================================================= */
const Catalog = (function () {

  /* ---------- 人教版小学数学目录（参考，可编辑） ---------- */
  const RJ = {
    '一年级': {
      '上册': ['准备课', '位置', '1~5的认识和加减法', '认识图形（一）', '6~10的认识和加减法', '11~20各数的认识', '认识钟表', '20以内的进位加法'],
      '下册': ['认识图形（二）', '20以内的退位减法', '分类与整理', '100以内数的认识', '认识人民币', '100以内的加法和减法（一）', '找规律']
    },
    '二年级': {
      '上册': ['长度单位', '100以内的加法和减法（二）', '角的初步认识', '表内乘法（一）', '观察物体（一）', '表内乘法（二）', '认识时间', '数学广角——搭配（一）'],
      '下册': ['数据收集整理', '表内除法（一）', '图形的运动（一）', '表内除法（二）', '混合运算', '有余数的除法', '万以内数的认识', '克和千克', '数学广角——推理']
    },
    '三年级': {
      '上册': ['时、分、秒', '万以内的加法和减法（一）', '测量', '万以内的加法和减法（二）', '倍的认识', '多位数乘一位数', '长方形和正方形', '分数的初步认识', '数学广角——集合'],
      '下册': ['位置与方向（一）', '除数是一位数的除法', '复式统计表', '两位数乘两位数', '面积', '年、月、日', '小数的初步认识', '数学广角——搭配（二）']
    },
    '四年级': {
      '上册': ['大数的认识', '公顷和平方千米', '角的度量', '三位数乘两位数', '平行四边形和梯形', '除数是两位数的除法', '条形统计图', '数学广角——优化'],
      '下册': ['四则运算', '观察物体（二）', '运算定律', '小数的意义和性质', '三角形', '小数的加法和减法', '图形的运动（二）', '平均数与条形统计图', '数学广角——鸡兔同笼']
    },
    '五年级': {
      '上册': ['小数乘法', '位置', '小数除法', '可能性', '简易方程', '多边形的面积', '数学广角——植树问题'],
      '下册': ['观察物体（三）', '因数与倍数', '长方体和正方体', '分数的意义和性质', '图形的运动（三）', '分数的加法和减法', '折线统计图', '数学广角——找次品']
    },
    '六年级': {
      '上册': ['分数乘法', '位置与方向（二）', '分数除法', '比', '圆', '百分数（一）', '扇形统计图', '数学广角——数与形'],
      '下册': ['负数', '百分数（二）', '圆柱与圆锥', '比例', '数学广角——鸽巢问题', '整理与复习']
    }
  };

  /* ---------- 苏教版（2026 秋版新教材）---------- */
  const SJ = {
    '五年级': {
      '上册': ['图形的运动', '统计表和条形统计图(二)', '多边形的面积', '小数乘法和除法(一)',
        '可能性', '因数与倍数', '用字母表示数量关系(一)', '观察物体(三)', '期末复习'],
      '下册': []   // 新教材未收录，走通用目录，可在设置中编辑
    }
  };

  /* ---------- 其他版本的通用兜底目录 ---------- */
  const GENERIC = ['数与代数', '图形与几何', '统计与概率', '综合与实践', '计算练习', '解决问题'];

  const VERSIONS = ['人教版', '北师大版', '苏教版', '青岛版', '自定义'];

  const LS_KEY = 'tiku.catalog.custom';

  function loadCustom() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }

  function saveCustom(map) {
    localStorage.setItem(LS_KEY, JSON.stringify(map || {}));
  }

  /** 自定义目录的键：学科|年级|学期|版本 */
  function ckey(subject, grade, term, version) {
    return [subject || '', grade || '', term || '', version || ''].join('|');
  }

  /**
   * 取目录：自定义 > 内置版本数据 > 通用兜底
   * @returns {string[]} 章节名数组
   */
  function get(subject, grade, term, version) {
    const custom = loadCustom();
    const c = custom[ckey(subject, grade, term, version)];
    if (c && c.length) return c.slice();

    if (subject === '数学' && version === '人教版' && RJ[grade]) {
      const arr = RJ[grade][term] || RJ[grade]['上册'];
      if (arr) return arr.slice();
    }
    if (subject === '数学' && version === '苏教版' && SJ[grade]) {
      const arr = SJ[grade][term] || [];
      if (arr.length) return arr.slice();
    }
    return GENERIC.slice();
  }

  /** 编辑（覆盖）某教材的目录；传空数组则清除自定义 */
  function setCustom(subject, grade, term, version, list) {
    const custom = loadCustom();
    const k = ckey(subject, grade, term, version);
    if (list && list.length) custom[k] = list;
    else delete custom[k];
    saveCustom(custom);
  }

  function hasCustom(subject, grade, term, version) {
    const c = loadCustom()[ckey(subject, grade, term, version)];
    return !!(c && c.length);
  }

  /** 目录文本 <-> 数组（设置页编辑用，每行一个单元） */
  function toText(list) { return (list || []).join('\n'); }
  function fromText(text) {
    return String(text || '').split('\n')
      .map(s => s.replace(/^\s*\d{1,2}\s*[.、．]\s*/, '').trim())
      .filter(Boolean);
  }

  /** 录题页快捷操作：给当前教材追加一个自定义章节（已存在则忽略） */
  function addUnit(subject, grade, term, version, name) {
    name = String(name || '').trim();
    if (!name) return get(subject, grade, term, version);
    const list = get(subject, grade, term, version);
    if (list.indexOf(name) >= 0) return list;
    list.push(name);
    setCustom(subject, grade, term, version, list);
    return list;
  }

  /** 录题页快捷操作：从当前教材目录中删除一个章节 */
  function removeUnit(subject, grade, term, version, name) {
    const list = get(subject, grade, term, version);
    const i = list.indexOf(name);
    if (i < 0) return list;
    list.splice(i, 1);
    setCustom(subject, grade, term, version, list);
    return list;
  }

  return { get, setCustom, hasCustom, addUnit, removeUnit, versions: VERSIONS, toText, fromText, DATA: RJ };
})();
