const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const ROOM_STATUS = ['运行', '检修', '停用'];
const ROOM_TYPE = ['冷藏库', '冷藏车', '冷冻库'];
const PROBE_STATUS = ['在用', '停用', '送检'];
const BATCH_STATUS = ['在库', '待放行', '已放行', '已拒收'];
const SOURCE_LIST = ['自动', '人工'];

function roomCode(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  return room ? room.code : '';
}
function batchCode(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  return batch ? batch.code : '';
}
function probeCode(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  return probe ? probe.code : '';
}

function decorateRoom(data, room) {
  const probes = data.probes.filter((p) => p.roomId === room.id);
  const batches = data.batches.filter((b) => b.roomId === room.id);
  return Object.assign({}, room, {
    probeCount: probes.length,
    runningProbeCount: probes.filter((p) => p.status === '在用').length,
    batchCount: batches.length,
    openBatchCount: batches.filter((b) => b.status === '在库' || b.status === '待放行').length,
  });
}

function decorateProbe(data, probe) {
  const records = data.records.filter((r) => r.probeId === probe.id);
  return Object.assign({}, probe, {
    roomCode: roomCode(data, probe.roomId),
    recordCount: records.length,
    manualCount: records.filter((r) => r.source === '人工').length,
    expired: !coldlib.probeValidOn(probe, store.nowText().slice(0, 10)),
  });
}

function decorateBatch(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  const releases = data.releases.filter((r) => r.batchId === batch.id);
  return Object.assign({}, batch, {
    roomCode: roomCode(data, batch.roomId),
    recordCount: stats.recordCount,
    longestExcursionMinutes: stats.longestMinutes,
    totalExcursionMinutes: stats.totalMinutes,
    mkt: check.mkt,
    chainGapCount: check.chain.gapCount,
    expiredProbeCodes: check.expiredProbes.map((p) => p.probeCode),
    releaseCheck: check,
    releaseCount: releases.length,
    lastDecision: releases.length ? releases[releases.length - 1].decision : '',
  });
}

function listRooms(data, query) {
  const q = query || {};
  let rows = data.rooms.slice();
  if (q.status) rows = rows.filter((r) => r.status === q.status);
  if (q.type) rows = rows.filter((r) => r.type === q.type);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((r) => [r.code, r.name, r.location].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  return rows.map((r) => decorateRoom(data, r)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function roomDetail(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  return Object.assign({}, decorateRoom(data, room), {
    probes: data.probes.filter((p) => p.roomId === id).map((p) => decorateProbe(data, p)),
    batches: data.batches.filter((b) => b.roomId === id).map((b) => decorateBatch(data, b)),
  });
}

function validateRoom(payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编码不能为空';
  if (!String(merged.name || '').trim()) errors.name = '名称不能为空';
  if (!ROOM_TYPE.includes(merged.type)) errors.type = '类型只能是：' + ROOM_TYPE.join('、');
  if (!ROOM_STATUS.includes(merged.status)) errors.status = '状态只能是：' + ROOM_STATUS.join('、');
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有项目没通过校验', errors);
}

function createRoom(data, payload) {
  validateRoom(payload, null);
  const room = {
    id: store.nextId('rm', data.rooms),
    code: String(payload.code).trim(),
    name: String(payload.name).trim(),
    type: payload.type,
    location: String(payload.location || '').trim(),
    capacityPlt: Number(payload.capacityPlt) || 0,
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.rooms.push(room);
  return decorateRoom(data, room);
}

function updateRoom(data, id, payload) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  validateRoom(payload, room);
  const merged = Object.assign({}, room, payload);
  Object.assign(room, {
    name: String(merged.name).trim(),
    type: merged.type,
    location: String(merged.location || '').trim(),
    capacityPlt: Number(merged.capacityPlt) || 0,
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateRoom(data, room);
}

function removeRoom(data, id) {
  const room = data.rooms.find((r) => r.id === id);
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '这个冷库或者车厢不存在');
  const used = data.probes.filter((p) => p.roomId === id).length + data.batches.filter((b) => b.roomId === id).length;
  if (used > 0) throw new AppError(409, 'ROOM_IN_USE', '名下还有 ' + used + ' 条探头或者批次，不能删除', { count: used });
  data.rooms = data.rooms.filter((r) => r.id !== id);
  return { removed: id };
}

function listProbes(data, query) {
  const q = query || {};
  let rows = data.probes.slice();
  if (q.roomId) rows = rows.filter((p) => p.roomId === q.roomId);
  if (q.status) rows = rows.filter((p) => p.status === q.status);
  return rows.map((p) => decorateProbe(data, p)).sort((a, b) => (a.code < b.code ? -1 : 1));
}

function validateProbe(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '编号不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所属冷库不存在';
  if (!PROBE_STATUS.includes(merged.status)) errors.status = '状态只能是：' + PROBE_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.calibratedUntil || ''))) errors.calibratedUntil = '校准有效期要像 2026-12-31';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createProbe(data, payload) {
  validateProbe(data, payload, null);
  const probe = {
    id: store.nextId('pb', data.probes),
    code: String(payload.code).trim(),
    roomId: payload.roomId,
    position: String(payload.position || '').trim(),
    status: payload.status,
    calibratedUntil: String(payload.calibratedUntil),
    remark: String(payload.remark || ''),
  };
  data.probes.push(probe);
  return decorateProbe(data, probe);
}

function updateProbe(data, id, payload) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  validateProbe(data, payload, probe);
  const merged = Object.assign({}, probe, payload);
  Object.assign(probe, {
    roomId: merged.roomId,
    position: String(merged.position || '').trim(),
    status: merged.status,
    calibratedUntil: String(merged.calibratedUntil),
    remark: String(merged.remark || ''),
  });
  return decorateProbe(data, probe);
}

function removeProbe(data, id) {
  const probe = data.probes.find((p) => p.id === id);
  if (!probe) throw new AppError(404, 'PROBE_NOT_FOUND', '这个探头不存在');
  const used = data.records.filter((r) => r.probeId === id).length;
  if (used > 0) throw new AppError(409, 'PROBE_IN_USE', '这个探头名下还有 ' + used + ' 条温度记录，不能删除', { count: used });
  data.probes = data.probes.filter((p) => p.id !== id);
  return { removed: id };
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.batches.slice();
  if (q.roomId) rows = rows.filter((b) => b.roomId === q.roomId);
  if (q.status) rows = rows.filter((b) => b.status === q.status);
  if (q.product) rows = rows.filter((b) => String(b.product || '').includes(q.product));
  const decorated = rows.map((b) => decorateBatch(data, b));
  return decorated.sort((a, b) => (a.loadedAt < b.loadedAt ? 1 : -1));
}

function batchDetail(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  const rows = coldlib.recordsOfBatch(data, id).map((r) => Object.assign({}, r, {
    probeCode: probeCode(data, r.probeId),
    probeExpired: !coldlib.probeValidOn(coldlib.probeOf(data, r.probeId), String(r.at).slice(0, 10)),
  }));
  return Object.assign({}, decorateBatch(data, batch), {
    records: rows,
    effectiveRecords: coldlib.effectiveRecords(data, id).map((r) => Object.assign({}, r, { probeCode: probeCode(data, r.probeId) })),
    segments: coldlib.excursionStats(data, id).segments,
    chainGaps: coldlib.chainGaps(data, id).gaps,
    releases: data.releases.filter((r) => r.batchId === id).slice().sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1)),
  });
}

function validateBatch(data, payload, current) {
  const merged = Object.assign({}, current || {}, payload || {});
  const errors = {};
  if (!String(merged.code || '').trim()) errors.code = '批次号不能为空';
  if (!String(merged.product || '').trim()) errors.product = '品名不能为空';
  if (!data.rooms.some((r) => r.id === merged.roomId)) errors.roomId = '所在冷库不存在';
  if (!BATCH_STATUS.includes(merged.status)) errors.status = '状态只能是：' + BATCH_STATUS.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.loadedAt || ''))) errors.loadedAt = '入库时刻格式要像 2026-09-01 08:00:00';
  const units = Number(merged.units);
  if (!Number.isFinite(units) || units <= 0) errors.units = '件数要是大于零的数';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '有几项没通过校验', errors);
}

function createBatch(data, payload) {
  validateBatch(data, payload, null);
  const batch = {
    id: store.nextId('bt', data.batches),
    code: String(payload.code).trim(),
    product: String(payload.product).trim(),
    spec: String(payload.spec || '').trim(),
    units: Number(payload.units),
    roomId: payload.roomId,
    loadedAt: String(payload.loadedAt),
    supplier: String(payload.supplier || '').trim(),
    status: payload.status,
    remark: String(payload.remark || ''),
  };
  data.batches.push(batch);
  return decorateBatch(data, batch);
}

function updateBatch(data, id, payload) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  validateBatch(data, payload, batch);
  const merged = Object.assign({}, batch, payload);
  Object.assign(batch, {
    product: String(merged.product).trim(),
    spec: String(merged.spec || '').trim(),
    units: Number(merged.units),
    roomId: merged.roomId,
    loadedAt: String(merged.loadedAt),
    supplier: String(merged.supplier || '').trim(),
    status: merged.status,
    remark: String(merged.remark || ''),
  });
  return decorateBatch(data, batch);
}

function removeBatch(data, id) {
  const batch = data.batches.find((b) => b.id === id);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (batch.status === '已放行') throw new AppError(409, 'BATCH_RELEASED', '这个批次已经放行，不能直接删除', { code: batch.code });
  const used = data.records.filter((r) => r.batchId === id).length;
  data.records = data.records.filter((r) => r.batchId !== id);
  data.releases = data.releases.filter((r) => r.batchId !== id);
  data.batches = data.batches.filter((b) => b.id !== id);
  return { removed: id, removedRecords: used };
}

function listRecords(data, query) {
  const q = query || {};
  let rows = data.records.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.probeId) rows = rows.filter((r) => r.probeId === q.probeId);
  if (q.source) rows = rows.filter((r) => r.source === q.source);
  if (q.from) rows = rows.filter((r) => r.at >= q.from);
  if (q.to) rows = rows.filter((r) => r.at <= q.to);
  return rows
    .map((r) => Object.assign({}, r, {
      batchCode: batchCode(data, r.batchId),
      probeCode: probeCode(data, r.probeId),
      outOfRange: Number(r.temperatureC) > Number(data.settings.upperLimitC) || Number(r.temperatureC) < Number(data.settings.lowerLimitC),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function validateRecord(data, payload) {
  const errors = {};
  const batch = data.batches.find((b) => b.id === payload.batchId);
  if (!batch) errors.batchId = '批次不存在';
  const probe = data.probes.find((p) => p.id === payload.probeId);
  if (!probe) errors.probeId = '探头不存在';
  if (!SOURCE_LIST.includes(payload.source)) errors.source = '来源只能是：' + SOURCE_LIST.join('、');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(payload.at || ''))) errors.at = '记录时刻格式要像 2026-09-01 08:00:00';
  if (payload.temperatureC === undefined || payload.temperatureC === '') errors.temperatureC = '温度不能为空';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '这条温度记录没通过校验', errors);
  return { batch, probe };
}

function createRecord(data, payload) {
  validateRecord(data, payload);
  const record = {
    id: store.nextId('rc', data.records),
    batchId: payload.batchId,
    probeId: payload.probeId,
    at: String(payload.at),
    temperatureC: Number(payload.temperatureC),
    source: payload.source,
    operator: String(payload.operator || '').trim(),
    remark: String(payload.remark || ''),
  };
  data.records.push(record);
  return Object.assign({}, record, { batchCode: batchCode(data, record.batchId), probeCode: probeCode(data, record.probeId) });
}

function removeRecord(data, id) {
  const record = data.records.find((r) => r.id === id);
  if (!record) throw new AppError(404, 'RECORD_NOT_FOUND', '这条温度记录不存在');
  data.records = data.records.filter((r) => r.id !== id);
  return { removed: id };
}

function listReleases(data, query) {
  const q = query || {};
  let rows = data.releases.slice();
  if (q.batchId) rows = rows.filter((r) => r.batchId === q.batchId);
  if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
  return rows
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId), batchReleaseId: r.batchReleaseId || '' }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态
function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const check = coldlib.releaseCheck(data, batch);
  const release = buildReleaseDoc(data, batch, check, payload, null);
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

/* ---------- 批量放行 ---------- */

const BATCH_RELEASE_MAX = 100;

function buildReleaseDoc(data, batch, check, payload, batchReleaseId) {
  const release = {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    batchCode: batch.code,
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    mkt: check.mkt,
    longestExcursionMinutes: check.longestMinutes,
    totalExcursionMinutes: check.totalMinutes,
    chainGapCount: check.chain.gapCount,
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  };
  if (batchReleaseId) release.batchReleaseId = batchReleaseId;
  return release;
}

function normalizeBatchIds(raw) {
  if (!Array.isArray(raw)) {
    throw new AppError(400, 'VALIDATION_FAILED', '要给出 batchIds 批次清单', { batchIds: '批次清单必须是数组' });
  }
  const ids = raw.map((x) => String(x == null ? '' : x).trim());
  if (!ids.length) throw new AppError(400, 'VALIDATION_FAILED', '至少选一个批次', { batchIds: '批次清单不能为空' });
  if (ids.length > BATCH_RELEASE_MAX) {
    throw new AppError(400, 'VALIDATION_FAILED', '一次最多放行 ' + BATCH_RELEASE_MAX + ' 批', { batchIds: '一次最多 ' + BATCH_RELEASE_MAX + ' 批' });
  }
  if (ids.some((x) => !x)) throw new AppError(400, 'VALIDATION_FAILED', '批次清单里有空值', { batchIds: '每一批都要有批次 id' });
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) throw new AppError(400, 'VALIDATION_FAILED', '批次在清单里重复：' + id, { batchIds: '同一批不能在清单里出现两次' });
    seen.add(id);
  }
  return ids;
}

// 预检一条批次：给出结论、被哪条判据挡下、差多少、以及本次预检的指纹
function precheckOne(data, id, nowText) {
  const batch = data.batches.find((b) => b.id === id);
  const base = {
    batchId: id,
    batchCode: batch ? batch.code : '',
    product: batch ? batch.product : '',
    units: batch ? batch.units : 0,
    roomCode: batch ? roomCode(data, batch.roomId) : '',
    status: batch ? batch.status : '',
    checkedAt: nowText,
    pass: false,
    reasons: [],
    metrics: null,
    fingerprint: '',
  };
  if (!batch) {
    base.reasons.push({ key: 'missing', text: '批次存在', value: 0, limit: 1, unit: '批', gap: 1, gapText: '这个批次已经找不到了，可能已被删除' });
    return base;
  }
  if (batch.status === '已放行' || batch.status === '已拒收') {
    base.reasons.push({ key: 'decided', text: '批次还没做过放行/拒收决定', value: batch.status, limit: '在库或待放行', unit: '', gap: 1, gapText: '该批次已经' + batch.status + '，不能重复放行' });
  }
  const check = coldlib.releaseCheck(data, batch);
  base.metrics = {
    mkt: check.mkt,
    longestMinutes: check.longestMinutes,
    totalMinutes: check.totalMinutes,
    recordCount: check.recordCount,
    chainGapCount: check.chain.gapCount,
  };
  for (const c of check.conditions) {
    if (!c.ok) {
      base.reasons.push({ key: c.key, text: c.text, value: c.value, limit: c.limit, unit: c.unit || '', gap: c.gap, gapText: c.gapText });
    }
  }
  base.pass = base.reasons.length === 0;
  base.fingerprint = coldlib.batchFingerprint(data, batch);
  return base;
}

// 批量预检：逐批列出结论与挡下原因，不通过的批在这里点名，不允许混进批量放行
function batchPrecheck(data, payload) {
  const ids = normalizeBatchIds(payload && payload.batchIds);
  const checkedAt = store.nowText();
  const results = ids.map((id) => precheckOne(data, id, checkedAt));
  const blocked = results.filter((r) => !r.pass);
  return {
    checkedAt,
    total: results.length,
    passedCount: results.length - blocked.length,
    blockedCount: blocked.length,
    allPassed: blocked.length === 0,
    results,
  };
}

function failureOf(result, code, message, reason) {
  return {
    batchId: result.batchId,
    batchCode: result.batchCode,
    code,
    message,
    reason: reason || null,
    reasons: result.reasons || [],
  };
}

// 批量放行：两阶段。第一阶段只校验不落任何数据；第二阶段快照后逐批落单，落完再整体核验，任何一批失败都整体回退。
function batchExecute(data, payload) {
  const ids = normalizeBatchIds(payload && payload.batchIds);
  const decider = String((payload && payload.decider) || '').trim();
  if (!decider) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  if (!payload || !payload.fingerprints || typeof payload.fingerprints !== 'object') {
    throw new AppError(400, 'PRECHECK_REQUIRED', '必须带每一批的预检指纹，请先跑批量预检', { fingerprints: '缺少预检结果' });
  }
  const expectedFp = {};
  for (const id of ids) {
    const fp = String(payload.fingerprints[id] || '');
    if (!/^[0-9a-f]{64}$/.test(fp)) {
      throw new AppError(400, 'PRECHECK_REQUIRED', '批次 ' + id + ' 缺少有效的预检指纹，请先跑批量预检', { batchId: id });
    }
    expectedFp[id] = fp;
  }

  const decidedAt = String((payload && payload.decidedAt) || store.nowText());
  const basis = String((payload && payload.basis) || '').trim() || ('批量放行：' + ids.length + ' 批预检全部通过');
  const remark = String((payload && payload.remark) || '');
  const precheckCheckedAt = String((payload && payload.checkedAt) || '');

  // —— 第一阶段：用最新数据逐批复核，任何一批不过就整单拦下，一条数据都不落 ——
  const failures = [];
  const plans = [];
  for (const id of ids) {
    const now = precheckOne(data, id, decidedAt);
    const batch = data.batches.find((b) => b.id === id);
    if (!batch) { failures.push(failureOf(now, 'BATCH_NOT_FOUND', '批次已经不存在', '预检后被删除')); continue; }
    if (batch.status === '已放行' || batch.status === '已拒收') {
      failures.push(failureOf(now, 'BATCH_ALREADY_DECIDED', '批次已' + batch.status, '预检后这批已经被别人做过决定'));
      continue;
    }
    const freshFp = coldlib.batchFingerprint(data, batch);
    if (freshFp !== expectedFp[id]) {
      failures.push(failureOf(now, 'BATCH_STALE', '预检结果已过期', '预检后这批的温度记录、判定口径或探头状态被改动过，请重新预检'));
      continue;
    }
    if (!now.pass) {
      failures.push(failureOf(now, 'BATCH_PRECHECK_FAILED', '最新判定已不通过', '预检后数据变了，判定结果随之变化'));
      continue;
    }
    plans.push({ batch, check: coldlib.releaseCheck(data, batch) });
  }

  if (failures.length) {
    throw new AppError(409, 'BATCH_RELEASE_ABORTED',
      '批量放行已整体拦下：' + failures.length + ' / ' + ids.length + ' 批不能放行，没有任何一批被放行，请处理后重新预检',
      { aborted: true, rolledBack: true, releasedCount: 0, total: ids.length, failures });
  }

  // —— 第二阶段：快照 → 逐批落单 → 整体核验；中途或核验失败就回滚到快照 ——
  const snapshot = JSON.stringify({
    batches: data.batches.map((b) => Object.assign({}, b)),
    releases: data.releases.map((r) => Object.assign({}, r)),
    batchReleases: data.batchReleases.map((x) => x),
  });
  const rollback = (err) => {
    const saved = JSON.parse(snapshot);
    data.batches = saved.batches;
    data.releases = saved.releases;
    data.batchReleases = saved.batchReleases;
    throw err;
  };

  const orderId = store.nextId('br', data.batchReleases);
  const items = [];
  try {
    for (const plan of plans) {
      const docPayload = { decision: '放行', decidedAt, decider, basis, remark };
      const release = buildReleaseDoc(data, plan.batch, plan.check, docPayload, orderId);
      data.releases.push(release);
      plan.batch.status = '已放行';
      plan.batch.decidedAt = decidedAt;
      items.push({
        batchId: plan.batch.id,
        batchCode: plan.batch.code,
        product: plan.batch.product,
        units: plan.batch.units,
        roomCode: roomCode(data, plan.batch.roomId),
        releaseId: release.id,
        decidedAt: release.decidedAt,
        decider: release.decider,
        mkt: release.mkt,
        longestExcursionMinutes: release.longestExcursionMinutes,
        totalExcursionMinutes: release.totalExcursionMinutes,
        chainGapCount: release.chainGapCount,
        basis: release.basis,
      });
    }

    // 落单后的整体核验：每批必须已放行，每张放行单必须在
    const verifyFailures = [];
    for (const item of items) {
      const batch = data.batches.find((b) => b.id === item.batchId);
      const release = data.releases.find((r) => r.id === item.releaseId);
      if (!batch || batch.status !== '已放行' || !release || release.decision !== '放行') {
        verifyFailures.push({ batchId: item.batchId, batchCode: item.batchCode, code: 'BATCH_RELEASE_VERIFY_FAILED', message: '落单后核验不到放行结果' });
      }
    }
    if (verifyFailures.length) {
      rollback(new AppError(500, 'BATCH_RELEASE_ROLLED_BACK',
        '批量放行落单后核验失败，已整体回退，没有任何一批被放行',
        { rolledBack: true, releasedCount: 0, total: ids.length, failures: verifyFailures }));
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    rollback(new AppError(500, 'BATCH_RELEASE_ROLLED_BACK',
      '批量放行执行到一半出错，已整体回退，没有任何一批被放行：' + err.message,
      { rolledBack: true, releasedCount: 0, total: ids.length }));
  }

  const order = {
    id: orderId,
    decidedAt,
    decider,
    basis,
    remark,
    precheckCheckedAt,
    total: items.length,
    successCount: items.length,
    failedCount: 0,
    totalUnits: items.reduce((a, x) => a + Number(x.units || 0), 0),
    status: '全部放行',
    items,
  };
  data.batchReleases.push(order);

  return {
    order,
    summary: {
      total: order.total,
      successCount: order.successCount,
      failedCount: 0,
      rolledBack: false,
      decider,
      decidedAt,
      orderId,
    },
    results: items.map((x) => ({ batchId: x.batchId, batchCode: x.batchCode, releaseId: x.releaseId, ok: true, decidedAt: x.decidedAt })),
  };
}

function decorateBatchRelease(data, order) {
  return Object.assign({}, order, {
    items: (order.items || []).map((x) => {
      const batch = data.batches.find((b) => b.id === x.batchId);
      return Object.assign({}, x, {
        batchCode: x.batchCode || batchCode(data, x.batchId),
        roomCode: x.roomCode || (batch ? roomCode(data, batch.roomId) : ''),
      });
    }),
  });
}

function listBatchReleases(data, query) {
  const q = query || {};
  let rows = data.batchReleases.slice();
  if (q.batchId) rows = rows.filter((o) => (o.items || []).some((x) => x.batchId === q.batchId));
  if (q.decider) rows = rows.filter((o) => String(o.decider || '').includes(q.decider));
  return rows.map((o) => decorateBatchRelease(data, o)).sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

function batchReleaseDetail(data, id) {
  const order = data.batchReleases.find((o) => o.id === id);
  if (!order) throw new AppError(404, 'BATCH_RELEASE_NOT_FOUND', '这张批量放行单不存在');
  return decorateBatchRelease(data, order);
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  batchPrecheck, batchExecute, listBatchReleases, batchReleaseDetail,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
