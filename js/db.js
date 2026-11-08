/* =========================================================
 * db.js — IndexedDB 数据层
 * ---------------------------------------------------------
 * 三张表：
 *   questions  题目（核心表）
 *   points     考点（名称已归一化，同一考点只有一条）
 *   assets     原图（Blob，与题目一对一/一对多）
 *   meta       杂项键值
 * ========================================================= */
const DB = (function () {
  const NAME = 'tiku-db';
  const VERSION = 2;   // v2 新增 papers（组卷）
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('questions')) {
          const s = db.createObjectStore('questions', { keyPath: 'id' });
          s.createIndex('pointId', 'pointId');
          s.createIndex('subject', 'subject');
          s.createIndex('status', 'status');
          s.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('points')) {
          const s = db.createObjectStore('points', { keyPath: 'id' });
          s.createIndex('subject', 'subject');
          s.createIndex('norm', 'norm');
          s.createIndex('subjectGrade', ['subject', 'grade']);
        }
        if (!db.objectStoreNames.contains('assets')) {
          db.createObjectStore('assets', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'k' });
        }
        if (!db.objectStoreNames.contains('papers')) {
          db.createObjectStore('papers', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }

  async function put(store, val) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    await done(tx);
    return val;
  }

  async function bulkPut(store, list) {
    if (!list || !list.length) return [];
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    list.forEach(function (v) { s.put(v); });
    await done(tx);
    return list;
  }

  async function get(store, key) {
    const db = await open();
    const tx = db.transaction(store, 'readonly');
    return new Promise(function (resolve, reject) {
      const r = tx.objectStore(store).get(key);
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  async function all(store) {
    const db = await open();
    const tx = db.transaction(store, 'readonly');
    return new Promise(function (resolve, reject) {
      const r = tx.objectStore(store).getAll();
      r.onsuccess = function () { resolve(r.result || []); };
      r.onerror = function () { reject(r.error); };
    });
  }

  async function del(store, key) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    return done(tx);
  }

  async function clear(store) {
    const db = await open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    return done(tx);
  }

  return { open, put, bulkPut, get, all, del, clear };
})();

/* =========================================================
 * Store — 业务语义层（题目 / 考点 / 图片）
 * ========================================================= */
const Store = (function () {

  /* ---------- 图片 ---------- */
  const urlCache = new Map();

  const Assets = {
    async save(blob) {
      const id = Util.uid('a');
      await DB.put('assets', { id: id, blob: blob, createdAt: Date.now() });
      return id;
    },
    async url(id) {
      if (!id) return '';
      if (urlCache.has(id)) return urlCache.get(id);
      const a = await DB.get('assets', id);
      if (!a || !a.blob) return '';
      const u = URL.createObjectURL(a.blob);
      urlCache.set(id, u);
      return u;
    },
    async remove(id) {
      if (!id) return;
      if (urlCache.has(id)) { URL.revokeObjectURL(urlCache.get(id)); urlCache.delete(id); }
      await DB.del('assets', id);
    }
  };

  /* ---------- 题目 ---------- */
  const Questions = {
    async create(data) {
      const now = Date.now();
      const q = Object.assign({
        id: Util.uid('q'),
        subject: '数学',
        grade: '五年级',
        unit: '',                 // 教材章节（目录单元名）
        pointId: '',
        pointName: '',
        type: '解答题',
        difficulty: 2,
        text: '',
        options: [],
        subs: [],
        rawText: '',
        answer: '',
        solution: '',
        images: [],               // 文档导入的题目图形（dataURI 数组）
        batchName: '',            // 来源练习名，如“数学练习册P23”
        batchDate: '',            // 作业时间（YYYY-MM-DD），同类题关联展示用
        status: 'todo',           // todo | mastered
        box: 0,
        reviewCount: 0,
        wrongCount: 0,
        lastReviewedAt: null,
        nextReviewAt: now,
        assetId: '',
        confidence: 1,
        needsConfirm: false,
        source: 'ocr',
        createdAt: now,
        updatedAt: now
      }, data);
      await DB.put('questions', q);
      return q;
    },

    async update(id, patch) {
      const q = await DB.get('questions', id);
      if (!q) return null;
      const next = Object.assign(q, patch, { updatedAt: Date.now() });
      await DB.put('questions', next);
      return next;
    },

    async remove(id) {
      const q = await DB.get('questions', id);
      await DB.del('questions', id);
      if (q && q.assetId) {
        // 同一张原图可能被多道题引用，确认没别的题再用才删
        const rest = await DB.all('questions');
        if (!rest.some(x => x.assetId === q.assetId)) await Assets.remove(q.assetId);
      }
      await Points.recount();
    },

    async list(filter) {
      filter = filter || {};
      let list = await DB.all('questions');
      if (filter.subject && filter.subject !== '全部') list = list.filter(q => q.subject === filter.subject);
      if (filter.grade && filter.grade !== '全部') list = list.filter(q => q.grade === filter.grade);
      // 一题可挂多个考点（q.points 数组），任一命中即算
      if (filter.pointId) list = list.filter(q =>
        q.pointId === filter.pointId || (q.points || []).some(p => p.id === filter.pointId));
      if (filter.type && filter.type !== '全部') list = list.filter(q => q.type === filter.type);
      if (filter.difficulty) list = list.filter(q => Number(q.difficulty) === Number(filter.difficulty));
      if (filter.status && filter.status !== '全部') list = list.filter(q => q.status === filter.status);
      if (filter.needsConfirm) list = list.filter(q => q.needsConfirm);
      if (filter.keyword) {
        const kw = String(filter.keyword).trim().toLowerCase();
        if (kw) {
          list = list.filter(function (q) {
            const hay = [q.text, q.pointName, (q.options || []).join(' '), (q.subs || []).join(' '),
              q.solution, q.answer, q.type].join(' ').toLowerCase();
            return hay.indexOf(kw) >= 0;
          });
        }
      }
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return list;
    },

    /** 复习抽题：按考点/状态筛选后洗牌 */
    async draw(opts) {
      opts = opts || {};
      let pool = await this.list({
        subject: opts.subject || '全部',
        grade: opts.grade || '全部',
        status: opts.status || '全部',
        pointId: opts.pointId || ''
      });
      if (opts.onlyWrong) pool = pool.filter(q => q.wrongCount > 0 || q.status !== 'mastered');
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      return pool.slice(0, opts.limit || 10);
    }
  };

  /* ---------- 考点 ---------- */
  const Points = {
    async listBy(subject, grade) {
      const all = await DB.all('points');
      return all.filter(function (p) {
        if (subject && subject !== '全部' && p.subject !== subject) return false;
        if (grade && grade !== '全部' && p.grade !== grade) return false;
        return true;
      }).sort((a, b) => (b.count || 0) - (a.count || 0));
    },

    async tree() {
      const [points, questions] = await Promise.all([DB.all('points'), DB.all('questions')]);
      const counts = {};
      questions.forEach(q => { counts[q.pointId] = (counts[q.pointId] || 0) + 1; });
      const tree = {};   // { subject: { grade: [point] } }
      points.forEach(function (p) {
        const n = counts[p.id] || 0;
        if (!n) return;
        tree[p.subject] = tree[p.subject] || {};
        tree[p.subject][p.grade] = tree[p.subject][p.grade] || [];
        tree[p.subject][p.grade].push(Object.assign({}, p, { count: n }));
      });
      Object.keys(tree).forEach(function (s) {
        Object.keys(tree[s]).forEach(function (g) {
          tree[s][g].sort((a, b) => b.count - a.count);
        });
      });
      return tree;
    },

    async ensure(name, subject, grade) {
      const res = await Normalize.resolve(name, { subject: subject, grade: grade });
      return res.point;
    },

    async recount() {
      const [points, questions] = await Promise.all([DB.all('points'), DB.all('questions')]);
      const counts = {};
      questions.forEach(q => {
        // 一题挂多个考点：主考点与 q.points 里每个都计数
        if (q.pointId) counts[q.pointId] = (counts[q.pointId] || 0) + 1;
        (q.points || []).forEach(p => { if (p && p.id) counts[p.id] = (counts[p.id] || 0) + 1; });
      });
      const changed = [];
      points.forEach(function (p) {
        const n = counts[p.id] || 0;
        if (p.count !== n) { p.count = n; changed.push(p); }
      });
      if (changed.length) await DB.bulkPut('points', changed);
    },

    /** 合并两个考点（解决同义标签分裂）；一题多考点时同步替换 q.points 里的条目 */
    async merge(fromId, toId) {
      const qs = (await DB.all('questions')).filter(q =>
        q.pointId === fromId || (q.points || []).some(p => p.id === fromId));
      const to = await DB.get('points', toId);
      const from = await DB.get('points', fromId);
      if (!to || !from) throw new Error('考点不存在');
      const aliases = Array.from(new Set([].concat(to.aliases || [], from.aliases || [], [from.name])));
      await DB.bulkPut('questions', qs.map(function (q) {
        if (q.pointId === fromId) { q.pointId = toId; q.pointName = to.name; }
        if (q.points && q.points.length) {
          const merged = [];
          q.points.forEach(function (p) {
            const np = p.id === fromId ? { id: toId, name: to.name } : p;
            if (!merged.some(x => x.id === np.id)) merged.push(np);
          });
          q.points = merged;
        }
        return q;
      }));
      to.aliases = aliases;
      await DB.put('points', to);
      await DB.del('points', fromId);
      await this.recount();
      return to;
    },

    async removeEmpty() {
      const [points, questions] = await Promise.all([DB.all('points'), DB.all('questions')]);
      const used = new Set();
      questions.forEach(q => {
        if (q.pointId) used.add(q.pointId);
        (q.points || []).forEach(p => { if (p && p.id) used.add(p.id); });
      });
      const dead = points.filter(p => !used.has(p.id));
      for (const p of dead) await DB.del('points', p.id);
      return dead.length;
    }
  };

  /* ---------- 组卷 ---------- */
  const Papers = {
    async save(data) {
      const p = Object.assign({ id: Util.uid('pp'), title: '单元练习', questionIds: [], createdAt: Date.now() }, data);
      await DB.put('papers', p);
      return p;
    },
    async list() {
      const all = await DB.all('papers');
      return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
    async get(id) { return DB.get('papers', id); },
    async remove(id) { return DB.del('papers', id); }
  };

  /* ---------- 考点掌握情况 ---------- */
  const Mastery = {
    LEVELS: [['good', '掌握较好'], ['part', '部分掌握'], ['bad', '未掌握']],
    async set(pointId, level, note) {
      const p = await DB.get('points', pointId);
      if (!p) return null;
      p.mastery = { level: level, note: note != null ? note : (p.mastery && p.mastery.note) || '', updatedAt: Date.now() };
      await DB.put('points', p);
      return p;
    },
    levelOf(point) {
      return (point && point.mastery && point.mastery.level) || '';
    }
  };

  /* ---------- 统计 ---------- */
  async function stats() {
    const qs = await DB.all('questions');
    const points = await DB.all('points');
    const now = Date.now();
    return {
      questions: qs.length,
      points: points.filter(p => (p.count || 0) > 0).length,
      mastered: qs.filter(q => q.status === 'mastered').length,
      todo: qs.filter(q => q.status !== 'mastered').length,
      due: qs.filter(q => q.status !== 'mastered' && (q.nextReviewAt || 0) <= now).length,
      needsConfirm: qs.filter(q => q.needsConfirm).length,
      wrong: qs.filter(q => q.wrongCount > 0).length,
      subjects: Array.from(new Set(qs.map(q => q.subject)))
    };
  }

  /* ---------- 导出 / 导入 ---------- */
  async function exportAll() {
    const [questions, points, papers] = await Promise.all([
      DB.all('questions'), DB.all('points'), DB.all('papers')]);
    return {
      app: '题点', version: 2, exportedAt: new Date().toISOString(),
      questions: questions, points: points, papers: papers
    };
  }

  async function importAll(data) {
    if (!data || !Array.isArray(data.questions)) throw new Error('文件格式不正确');
    const points = Array.isArray(data.points) ? data.points : [];
    // 简单去重：同 id 覆盖，同 norm+subject+grade 复用已有考点
    const existed = await DB.all('points');
    const byNorm = {};
    existed.forEach(p => { byNorm[p.subject + '|' + p.grade + '|' + p.norm] = p; });
    const remap = {};
    const toAdd = [];
    points.forEach(function (p) {
      const key = p.subject + '|' + p.grade + '|' + (p.norm || p.name);
      if (byNorm[key]) { remap[p.id] = byNorm[key].id; }
      else { byNorm[key] = p; toAdd.push(p); }
    });
    if (toAdd.length) await DB.bulkPut('points', toAdd);
    const qs = data.questions.map(function (q) {
      if (remap[q.pointId]) q.pointId = remap[q.pointId];
      if (!q.id) q.id = Util.uid('q');
      return q;
    });
    await DB.bulkPut('questions', qs);
    if (Array.isArray(data.papers) && data.papers.length) await DB.bulkPut('papers', data.papers);
    await Points.recount();
    return { questions: qs.length, points: toAdd.length };
  }

  return { Assets, Questions, Points, Papers, Mastery, stats, exportAll, importAll };
})();
