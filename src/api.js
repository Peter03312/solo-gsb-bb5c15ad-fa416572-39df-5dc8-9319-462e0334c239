'use strict';
/**
 * API 路由与业务逻辑。
 * 错误约定：返回 { error: 消息, ... } ，状态码语义：
 *   400 参数/前置条件错误（含无已发布版本、版本未发布、跳过/撤回缺原因或缺操作人）
 *   404 资源不存在
 *   409 冲突（提示已有有效结果、版本已发布不可改、撤回对象非已触发）
 *   422 校验未通过（缺失引用/循环依赖）、前置未触发（受阻）、撤回被后续已触发提示阻塞
 */
const { db, withTx } = require('./db');
const { validateCues, CUE_TYPES } = require('./validate');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

/* ---------------- 工具 ---------------- */

const ACTION_TEXT = { fired: '已触发', skipped: '已跳过' };

function sanitizeCue(raw) {
  const deps = Array.isArray(raw && raw.deps) ? raw.deps : [];
  return {
    label: String((raw && raw.label) != null ? raw.label : '').trim().slice(0, 50),
    type: CUE_TYPES.includes(raw && raw.type) ? raw.type : 'other',
    description: String((raw && raw.description) != null ? raw.description : '').trim().slice(0, 500),
    deps: [...new Set(deps.map((d) => String(d).trim()).filter(Boolean))].slice(0, 50),
  };
}

function getShow(id) {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(id);
  if (!show) throw new HttpError(404, '场次不存在');
  return show;
}

function getVersion(id) {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
  if (!v) throw new HttpError(404, '版本不存在');
  return v;
}

function getVersionCues(versionId) {
  return db
    .prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq')
    .all(versionId)
    .map((c) => ({ ...c, deps: JSON.parse(c.deps) }));
}

function conflictError(existing) {
  if (!existing) {
    return new HttpError(409, '该提示当前没有有效结果（待执行/受阻），无法撤回');
  }
  return new HttpError(
    409,
    `该提示已有结果：${ACTION_TEXT[existing.action]}（操作人 ${existing.operator}，时间 ${existing.created_at}）`,
    { current: existing }
  );
}

/**
 * 读取一场演出的完整流水，并计算每个提示的「当前有效结果」。
 * 有效结果 = 该提示最新一条 fired/skipped（最新一条为 recalled 时无有效结果）。
 * 返回 { events（按 id 升序）, effectiveByCue, firedLabels }。
 */
function loadEventState(performanceId, versionId) {
  const events = db.prepare(`
    SELECT e.*, c.label, c.seq FROM cue_events e
    JOIN cues c ON c.id = e.cue_id
    WHERE e.performance_id = ? ORDER BY e.id
  `).all(performanceId);

  const effectiveByCue = new Map();
  for (const e of events) {
    if (e.action === 'recalled') effectiveByCue.delete(e.cue_id);
    else effectiveByCue.set(e.cue_id, e);
  }
  const firedLabels = new Set();
  for (const e of effectiveByCue.values()) {
    if (e.action === 'fired') firedLabels.add(e.label);
  }
  return { events, effectiveByCue, firedLabels };
}

/* ---------------- 路由表 ---------------- */

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, rx, keys, handler });
}

/* ---- 场次 ---- */

route('GET', '/api/shows', () => {
  const shows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id) AS version_count,
      (SELECT COUNT(*) FROM versions v WHERE v.show_id = s.id AND v.status = 'published') AS published_count,
      (SELECT COUNT(*) FROM performances p WHERE p.show_id = s.id) AS performance_count
    FROM shows s ORDER BY s.id DESC
  `).all();
  return { shows };
});

route('POST', '/api/shows', (body) => {
  const name = String(body.name || '').trim().slice(0, 100);
  if (!name) throw new HttpError(400, '场次名称不能为空');
  const info = db.prepare('INSERT INTO shows (name) VALUES (?)').run(name);
  return { show: db.prepare('SELECT * FROM shows WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/shows/:id', (body, p) => {
  const show = getShow(p.id);
  const versions = db.prepare(
    'SELECT id, show_id, version_number, status, note, created_at, published_at FROM versions WHERE show_id = ? ORDER BY version_number DESC'
  ).all(show.id);
  const performances = db.prepare(`
    SELECT p.*, v.version_number FROM performances p
    JOIN versions v ON v.id = p.version_id
    WHERE p.show_id = ? ORDER BY p.id DESC
  `).all(show.id);
  return { show, versions, performances };
});

/* ---- 版本（执行单） ---- */

route('POST', '/api/shows/:id/versions', (body, p) => {
  const show = getShow(p.id);
  return withTx(() => {
    // 基准版本：指定 from_version_id，否则取最新版本；没有则建空白草稿
    let base = null;
    if (body.from_version_id != null) {
      base = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?')
        .get(body.from_version_id, show.id);
      if (!base) throw new HttpError(404, '基准版本不存在');
    } else {
      base = db.prepare('SELECT * FROM versions WHERE show_id = ? ORDER BY version_number DESC LIMIT 1')
        .get(show.id);
    }
    const nextNo = (db.prepare('SELECT COALESCE(MAX(version_number), 0) AS m FROM versions WHERE show_id = ?')
      .get(show.id).m) + 1;
    const info = db.prepare('INSERT INTO versions (show_id, version_number, status, note) VALUES (?,?,?,?)')
      .run(show.id, nextNo, 'draft', String(body.note || '').slice(0, 200));
    const newId = Number(info.lastInsertRowid);
    if (base) {
      const cues = db.prepare('SELECT * FROM cues WHERE version_id = ? ORDER BY seq').all(base.id);
      const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps) VALUES (?,?,?,?,?,?)');
      for (const c of cues) ins.run(newId, c.seq, c.label, c.type, c.description, c.deps);
    }
    return { version: getVersion(newId), cues: getVersionCues(newId) };
  });
});

route('GET', '/api/versions/:id', (body, p) => {
  const version = getVersion(p.id);
  return { version, cues: getVersionCues(version.id) };
});

route('PUT', '/api/versions/:id/cues', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') {
    throw new HttpError(409, '该版本已发布，内容不可修改；请新建草稿版本');
  }
  if (!Array.isArray(body.cues)) throw new HttpError(400, '请求格式错误：cues 应为数组');
  if (body.cues.length > 500) throw new HttpError(400, '提示数量过多（上限 500）');

  const cues = body.cues.map(sanitizeCue);
  withTx(() => {
    db.prepare('DELETE FROM cues WHERE version_id = ?').run(version.id);
    const ins = db.prepare('INSERT INTO cues (version_id, seq, label, type, description, deps) VALUES (?,?,?,?,?,?)');
    cues.forEach((c, i) => ins.run(version.id, i + 1, c.label, c.type, c.description, JSON.stringify(c.deps)));
  });
  // 草稿允许暂存不完整内容，同时返回校验结果供界面提示
  return { ok: true, errors: validateCues(cues), cues: getVersionCues(version.id) };
});

route('POST', '/api/versions/:id/validate', (body, p) => {
  getVersion(p.id);
  const cues = Array.isArray(body.cues) ? body.cues.map(sanitizeCue) : getVersionCues(p.id);
  return { errors: validateCues(cues) };
});

route('POST', '/api/versions/:id/publish', (body, p) => {
  const version = getVersion(p.id);
  if (version.status === 'published') throw new HttpError(409, '该版本已发布');
  const cues = getVersionCues(version.id);
  const errors = validateCues(cues);
  if (errors.length) {
    throw new HttpError(422, '校验未通过，无法发布', { errors });
  }
  withTx(() => {
    db.prepare("UPDATE versions SET status = 'published', published_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(version.id);
  });
  return { version: getVersion(version.id) };
});

/* ---- 演出 ---- */

route('POST', '/api/shows/:id/performances', (body, p) => {
  const show = getShow(p.id);
  let version;
  if (body.version_id != null) {
    version = db.prepare('SELECT * FROM versions WHERE id = ? AND show_id = ?').get(body.version_id, show.id);
    if (!version) throw new HttpError(404, '版本不存在');
    if (version.status !== 'published') {
      throw new HttpError(400, `版本 v${version.version_number} 尚未发布，不能用于启动演出`);
    }
  } else {
    version = db.prepare(
      "SELECT * FROM versions WHERE show_id = ? AND status = 'published' ORDER BY version_number DESC LIMIT 1"
    ).get(show.id);
    if (!version) throw new HttpError(400, '无已发布版本，请先发布执行单后再启动演出');
  }
  const name = String(body.name || '').trim().slice(0, 100);
  const operator = String(body.operator || '').trim().slice(0, 50);
  const info = db.prepare('INSERT INTO performances (show_id, version_id, name, started_by) VALUES (?,?,?,?)')
    .run(show.id, version.id, name, operator);
  return { performance: db.prepare('SELECT * FROM performances WHERE id = ?').get(Number(info.lastInsertRowid)) };
});

route('GET', '/api/performances/:id', (body, p) => {
  const perf = db.prepare(`
    SELECT p.*, s.name AS show_name, v.version_number
    FROM performances p
    JOIN shows s ON s.id = p.show_id
    JOIN versions v ON v.id = p.version_id
    WHERE p.id = ?
  `).get(p.id);
  if (!perf) throw new HttpError(404, '演出不存在');

  const cues = getVersionCues(perf.version_id);
  const { events, effectiveByCue, firedLabels } = loadEventState(perf.id, perf.version_id);

  const cueStates = cues.map((c) => {
    const event = effectiveByCue.get(c.id) || null;
    let status;
    let unmet = [];
    if (event) {
      status = event.action; // fired / skipped
    } else {
      unmet = c.deps.filter((d) => !firedLabels.has(d));
      status = unmet.length ? 'blocked' : 'pending';
    }
    return { ...c, status, unmet, event };
  });

  // 完整流水（含撤回），effective 标记该条是否仍为当前有效结果
  const effectiveEventIds = new Set([...effectiveByCue.values()].map((e) => e.id));
  const logEvents = events.map((e) => ({ ...e, effective: effectiveEventIds.has(e.id) }));

  return { performance: perf, cues: cueStates, events: logEvents.slice().reverse() };
});

/* ---- 触发 / 跳过 / 撤回（并发安全：BEGIN IMMEDIATE 串行事务内基于有效状态判定） ---- */

function recordEvent(performanceId, cueId, action, operator, reason) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');

    const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
    if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');

    const { effectiveByCue, firedLabels } = loadEventState(performanceId, perf.version_id);
    const existing = effectiveByCue.get(cueId);
    if (existing) throw conflictError(existing); // 409 附当前结果（fired/skipped）

    if (action === 'fired') {
      const deps = JSON.parse(cue.deps);
      const unmet = deps.filter((d) => !firedLabels.has(d));
      if (unmet.length) {
        throw new HttpError(422, `前置提示未触发，无法触发：${unmet.join('、')}`, { unmet });
      }
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason) VALUES (?,?,?,?,?)'
    ).run(performanceId, cueId, action, operator, reason);
    return { event: db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid)) };
  });
}

/**
 * 撤回：仅当前有效结果为「已触发」的提示可撤回。
 * 沿前置关系向下游（依赖该提示的提示）做可达遍历，若任一可达提示当前仍有效「已触发」，
 * 拒绝撤回并返回受影响编号；事务内任何记录均不改变（整体回滚）。
 */
function recallEvent(performanceId, cueId, operator, reason) {
  return withTx(() => {
    const perf = db.prepare('SELECT * FROM performances WHERE id = ?').get(performanceId);
    if (!perf) throw new HttpError(404, '演出不存在');

    const cue = db.prepare('SELECT * FROM cues WHERE id = ? AND version_id = ?').get(cueId, perf.version_id);
    if (!cue) throw new HttpError(404, '该提示不属于此演出使用的版本');

    const { effectiveByCue } = loadEventState(performanceId, perf.version_id);
    const existing = effectiveByCue.get(cueId);
    if (!existing) throw conflictError(null); // 待执行/受阻（含已撤回后未再操作）：409
    if (existing.action === 'skipped') {
      throw new HttpError(
        409,
        '已跳过的提示不能撤回',
        { current: existing }
      );
    }

    // 构建 下游提示 label -> 提示 的反向依赖图：dependents[d] = 直接依赖 d 的提示
    const cues = getVersionCues(perf.version_id);
    const byLabel = new Map(cues.map((c) => [c.label, c]));
    const dependents = new Map();
    for (const c of cues) {
      for (const d of c.deps) {
        if (!dependents.has(d)) dependents.set(d, []);
        dependents.get(d).push(c.label);
      }
    }

    // 沿前置关系可达的全部下游提示；其中当前仍有效「已触发」者阻塞本次撤回
    const reachable = [];
    const seen = new Set();
    const queue = [...(dependents.get(cue.label) || [])];
    while (queue.length) {
      const label = queue.shift();
      if (seen.has(label)) continue;
      seen.add(label);
      reachable.push(label);
      for (const nxt of dependents.get(label) || []) {
        if (!seen.has(nxt)) queue.push(nxt);
      }
    }

    const blocking = reachable
      .map((label) => byLabel.get(label))
      .filter((c) => c && effectiveByCue.has(c.id) && effectiveByCue.get(c.id).action === 'fired')
      .sort((a, b) => a.seq - b.seq);

    if (blocking.length) {
      const affected = blocking.map((c) => c.label);
      throw new HttpError(
        422,
        `撤回被拒绝：后续提示 ${affected.join('、')} 仍为已触发，请先撤回它们（未改动任何记录）`,
        { affected }
      );
    }

    const info = db.prepare(
      'INSERT INTO cue_events (performance_id, cue_id, action, operator, reason, recalled_event_id) VALUES (?,?,?,?,?,?)'
    ).run(performanceId, cueId, 'recalled', operator, reason, existing.id);
    const recall = db.prepare('SELECT * FROM cue_events WHERE id = ?').get(Number(info.lastInsertRowid));
    return { recalled_event: existing, event: recall };
  });
}

route('POST', '/api/performances/:id/cues/:cueId/fire', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  return recordEvent(Number(p.id), Number(p.cueId), 'fired', operator, null);
});

route('POST', '/api/performances/:id/cues/:cueId/skip', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写操作人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '跳过必须填写原因');
  return recordEvent(Number(p.id), Number(p.cueId), 'skipped', operator, reason);
});

route('POST', '/api/performances/:id/cues/:cueId/recall', (body, p) => {
  const operator = String(body.operator || '').trim().slice(0, 50);
  if (!operator) throw new HttpError(400, '请填写撤回人');
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, '撤回必须填写原因');
  return recallEvent(Number(p.id), Number(p.cueId), operator, reason);
});

/* ---------------- 分发 ---------------- */

async function handle(req, res, url, body) {
  const pathname = url.pathname;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const result = await r.handler(body, params, req);
    return { status: 200, data: result };
  }
  throw new HttpError(404, '接口不存在');
}

module.exports = { handle, HttpError };
