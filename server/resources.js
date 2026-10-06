const crypto = require('crypto');
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
    .map((r) => Object.assign({}, r, { batchCode: batchCode(data, r.batchId) }))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
}

// 放行：登记放行单并改批次状态
function buildReleaseRow(data, batch, fields, check) {
  const c = check || coldlib.releaseCheck(data, batch);
  return {
    id: store.nextId('rl', data.releases),
    batchId: batch.id,
    decision: fields.decision,
    decidedAt: fields.decidedAt,
    decider: fields.decider,
    mkt: c.mkt,
    longestExcursionMinutes: c.longestMinutes,
    totalExcursionMinutes: c.totalMinutes,
    chainGapCount: c.chain.gapCount,
    basis: fields.basis,
    remark: fields.remark,
  };
}

function decide(data, batchId, payload) {
  const batch = data.batches.find((b) => b.id === batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这个批次不存在');
  if (!['放行', '拒收'].includes(payload.decision)) {
    throw new AppError(400, 'VALIDATION_FAILED', '决定只能是放行或者拒收', { decision: '请选择放行或者拒收' });
  }
  if (!String(payload.decider || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  }
  const release = buildReleaseRow(data, batch, {
    decision: payload.decision,
    decidedAt: String(payload.decidedAt || store.nowText()),
    decider: String(payload.decider).trim(),
    basis: String(payload.basis || '').trim(),
    remark: String(payload.remark || ''),
  });
  data.releases.push(release);
  batch.status = payload.decision === '放行' ? '已放行' : '已拒收';
  batch.decidedAt = release.decidedAt;
  return { release, batch: decorateBatch(data, batch) };
}

/* ---------- 批量预检与批量放行 ---------- */

const RELEASABLE_STATUS = ['在库', '待放行'];
const BULK_MAX = 200;

// 确定性 JSON：对象键排序，数组保序，供预检令牌做指纹
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
    .join(',') + '}';
}

// 预检令牌：覆盖所有能改变放行判定的输入（判定设置、批次状态/放行单数、生效记录、相关探头校准期）
function precheckToken(data, batch) {
  const rows = coldlib.effectiveRecords(data, batch.id);
  const probeIds = Array.from(new Set(rows.map((r) => r.probeId))).sort();
  const s = data.settings;
  const fingerprint = {
    v: 1,
    settings: {
      lowerLimitC: Number(s.lowerLimitC),
      upperLimitC: Number(s.upperLimitC),
      allowExcursionMinutes: Number(s.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(s.allowTotalExcursionMinutes),
      chainGapMinutes: Number(s.chainGapMinutes),
      recordIntervalMinutes: Number(s.recordIntervalMinutes),
    },
    batch: {
      status: batch.status,
      loadedAt: String(batch.loadedAt || ''),
      releaseCount: data.releases.filter((r) => r.batchId === batch.id).length,
    },
    records: rows.map((r) => [r.probeId, String(r.at), Number(r.temperatureC), r.source]),
    probes: probeIds.map((id) => {
      const p = coldlib.probeOf(data, id);
      return [id, p ? String(p.calibratedUntil || '') : null];
    }),
  };
  return crypto.createHash('sha256').update(stableStringify(fingerprint), 'utf8').digest('hex');
}

// 不满足判据 → 结构化原因：哪一条、实际、阈值、差多少
function conditionReasons(check) {
  const gapKeys = { chain: '个', calibration: '个', records: '条' };
  return check.conditions
    .filter((c) => !c.ok)
    .map((c) => ({
      key: c.key,
      text: c.text,
      value: c.value,
      limit: c.limit,
      shortfall: c.key === 'records' ? c.limit - c.value : c.value - c.limit,
      unit: Object.prototype.hasOwnProperty.call(gapKeys, c.key) ? gapKeys[c.key] : '分钟',
    }));
}

function normalizeBatchIds(payload) {
  const raw = payload && payload.batchIds;
  if (!Array.isArray(raw)) throw new AppError(400, 'VALIDATION_FAILED', '请选择批次', { batchIds: '批次列表必须是数组' });
  if (!raw.length) throw new AppError(400, 'VALIDATION_FAILED', '至少选择一个批次', { batchIds: '批次列表不能为空' });
  if (raw.length > BULK_MAX) throw new AppError(400, 'VALIDATION_FAILED', '一次最多 ' + BULK_MAX + ' 个批次', { batchIds: '数量超限' });
  const ids = raw.map((x) => String(x == null ? '' : x).trim());
  if (ids.some((x) => !x)) throw new AppError(400, 'VALIDATION_FAILED', '批次编号不能为空', { batchIds: '存在空编号' });
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) {
    throw new AppError(400, 'VALIDATION_FAILED', '选择了重复批次，请去重后重试', { batchIds: '重复批次：' + Array.from(new Set(dup)).join('、') });
  }
  return ids;
}

function normalizeBulkItems(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new AppError(400, 'VALIDATION_FAILED', '缺少预检条目', { items: '预检条目必须是非空数组' });
  if (raw.length > BULK_MAX) throw new AppError(400, 'VALIDATION_FAILED', '一次最多 ' + BULK_MAX + ' 个批次', { items: '数量超限' });
  const items = raw.map((it) => ({ batchId: String((it && it.batchId) || '').trim(), token: String((it && it.token) || '') }));
  if (items.some((it) => !it.batchId)) throw new AppError(400, 'VALIDATION_FAILED', '批次编号不能为空', { items: '存在空编号' });
  const dup = items.map((it) => it.batchId).filter((x, i, arr) => arr.indexOf(x) !== i);
  if (dup.length) throw new AppError(400, 'VALIDATION_FAILED', '选择了重复批次，请去重后重试', { items: '重复批次：' + Array.from(new Set(dup)).join('、') });
  return items;
}

// 批量预检：只读，逐批给结论、挡下原因与令牌
function bulkReleaseCheck(data, payload) {
  const ids = normalizeBatchIds(payload);
  const checkedAt = store.nowText();
  const items = ids.map((batchId) => {
    const batch = data.batches.find((b) => b.id === batchId);
    if (!batch) {
      return {
        batchId: batchId, batchCode: '', status: '', pass: false, releasable: false,
        recordCount: 0, mkt: 0, longestMinutes: 0, totalMinutes: 0, chainGapCount: 0,
        expiredProbes: [], token: '',
        reasons: [{ key: 'not_found', text: '批次不存在或已被删除', value: '', limit: '', shortfall: 0, unit: '' }],
      };
    }
    const check = coldlib.releaseCheck(data, batch);
    const reasons = [];
    if (!RELEASABLE_STATUS.includes(batch.status)) {
      reasons.push({ key: 'status', text: '批次状态为「' + batch.status + '」，不能放行', value: batch.status, limit: RELEASABLE_STATUS.join('/'), shortfall: 0, unit: '' });
    }
    reasons.push.apply(reasons, conditionReasons(check));
    return {
      batchId: batchId,
      batchCode: batch.code,
      status: batch.status,
      pass: check.pass,
      releasable: RELEASABLE_STATUS.includes(batch.status) && check.pass,
      recordCount: check.recordCount,
      mkt: check.mkt,
      longestMinutes: check.longestMinutes,
      totalMinutes: check.totalMinutes,
      chainGapCount: check.chain.gapCount,
      reasons: reasons,
      expiredProbes: check.expiredProbes,
      token: precheckToken(data, batch),
    };
  });
  const blockedCount = items.filter((it) => !it.releasable).length;
  return {
    checkedAt: checkedAt,
    items: items,
    summary: { total: items.length, releasableCount: items.length - blockedCount, blockedCount: blockedCount },
  };
}

// 批量放行：先把整批校验一遍，有一个失败就整体抛错（withData 不写盘 = 整批回滚）；全部通过后一次提交
function bulkDecide(data, payload) {
  const body = payload || {};
  if (body.decision !== '放行') {
    throw new AppError(400, 'VALIDATION_FAILED', '批量操作只支持放行', { decision: '批量决定必须是放行' });
  }
  const decider = String(body.decider || '').trim();
  if (!decider) throw new AppError(400, 'VALIDATION_FAILED', '经办人要填', { decider: '经办人不能为空' });
  const basis = String(body.basis || '').trim();
  const remark = String(body.remark || '');
  const items = normalizeBulkItems(body.items);

  // 阶段 1：纯校验，零写入
  const targets = items.map((it) => {
    const batch = data.batches.find((b) => b.id === it.batchId);
    if (!batch) {
      return { batch: null, failure: { batchId: it.batchId, batchCode: '', code: 'BATCH_NOT_FOUND', message: '批次不存在或已被删除', reasons: [] } };
    }
    const base = { batchId: batch.id, batchCode: batch.code };
    if (precheckToken(data, batch) !== it.token) {
      return { batch: batch, failure: Object.assign({}, base, { code: 'STALE_PRECHECK', message: '预检结果已过期，请重新预检（记录、判定设置、探头校准或批次状态发生了变化）', reasons: [] }) };
    }
    if (!RELEASABLE_STATUS.includes(batch.status)) {
      return { batch: batch, failure: Object.assign({}, base, { code: 'STATUS_NOT_RELEASABLE', message: '批次已被处理，当前状态为「' + batch.status + '」', reasons: [] }) };
    }
    const check = coldlib.releaseCheck(data, batch);
    if (!check.pass) {
      return { batch: batch, failure: Object.assign({}, base, { code: 'PRECHECK_FAILED', message: '放行判据未全部满足', reasons: conditionReasons(check) }) };
    }
    return { batch: batch, check: check };
  });

  const failures = targets.filter((t) => t.failure).map((t) => Object.assign({ reasons: [] }, t.failure));
  if (failures.length) {
    throw new AppError(409, 'BATCH_BULK_ABORTED',
      '批量放行已整体中止：' + failures.length + ' 个批次不能放行，全部批次均未改动，请调整后重新预检',
      { failures: failures });
  }

  // 阶段 2/3：校验已全部通过，逐行生成放行单（nextId 依赖台账当前最大值）并立即登记，再改批次状态；
  // 此段不再有任何可能抛错的调用
  const decidedAt = store.nowText();
  const results = targets.map((t) => {
    const row = buildReleaseRow(data, t.batch, {
      decision: '放行', decidedAt: decidedAt, decider: decider, basis: basis, remark: remark,
    }, t.check);
    data.releases.push(row);
    t.batch.status = '已放行';
    t.batch.decidedAt = decidedAt;
    return {
      batchId: t.batch.id,
      batchCode: t.batch.code,
      releaseId: row.id,
      status: '已放行',
      decidedAt: decidedAt,
      decider: decider,
      mkt: row.mkt,
      longestExcursionMinutes: row.longestExcursionMinutes,
      totalExcursionMinutes: row.totalExcursionMinutes,
      chainGapCount: row.chainGapCount,
    };
  });
  return {
    decidedAt: decidedAt,
    decider: decider,
    decision: '放行',
    basis: basis,
    remark: remark,
    results: results,
    summary: { requested: targets.length, released: targets.length, failed: 0 },
  };
}

module.exports = {
  listRooms, roomDetail, createRoom, updateRoom, removeRoom,
  listProbes, createProbe, updateProbe, removeProbe,
  listBatches, batchDetail, createBatch, updateBatch, removeBatch,
  listRecords, createRecord, removeRecord,
  listReleases, decide,
  precheckToken, bulkReleaseCheck, bulkDecide,
  ROOM_STATUS, ROOM_TYPE, PROBE_STATUS, BATCH_STATUS, SOURCE_LIST,
};
