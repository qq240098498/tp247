// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const crypto = require('crypto');
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准；停用探头名下的记录不参与判定
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (probe && probe.status === '停用') continue;
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    // 后到的手工更正覆盖自动记录；自动记录不能覆盖手工记录
    if (picked[key].source !== '人工' && row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 超限：连续超出上下限的时段，回到范围内即断开；每段时长按段内相邻记录的实际时刻差累加
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      if (current) {
        current.minutes += store.minutesBetween(current.endAt, row.at);
        current.endAt = row.at;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: minutes });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度，MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T))) / n)) − 273.15，T 用开尔文
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const ea = Number(settings.mktActivationEnergy || 83144);
  const gasR = Number(settings.gasConstant || 8.314);
  let sum = 0;
  for (const row of rows) {
    const kelvin = Number(row.temperatureC) + 273.15;
    sum += Math.exp((-ea) / (gasR * kelvin));
  }
  const mktKelvin = (-ea) / (gasR * Math.log(sum / rows.length));
  return store.round(mktKelvin - 273.15, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 放行判定：无记录、最长超限、累计超限、断链、探头校准五条；每条都给出实际值、阈值与差多少
function releaseCheck(data, batch) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batch.id);
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = accumulatedExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');

  const conditions = [];

  // 没有任何温度记录的批次不能放行
  conditions.push({
    key: 'records',
    ok: rows.length > 0,
    value: rows.length,
    limit: 1,
    unit: '条',
    text: '至少要有 1 条温度记录',
    gap: rows.length > 0 ? 0 : 1,
    gapText: rows.length > 0 ? '' : '还差 1 条温度记录（当前 0 条，不能放行）',
  });

  const longestLimit = Number(settings.allowExcursionMinutes);
  conditions.push({
    key: 'longest',
    ok: stats.longestMinutes <= longestLimit,
    value: stats.longestMinutes,
    limit: longestLimit,
    unit: '分钟',
    text: '单次连续超限不超过 ' + longestLimit + ' 分钟',
    gap: Math.max(0, stats.longestMinutes - longestLimit),
    gapText: stats.longestMinutes > longestLimit
      ? '最长一次超限 ' + stats.longestMinutes + ' 分钟，超出门限 ' + (stats.longestMinutes - longestLimit) + ' 分钟'
      : '',
  });

  const totalLimit = Number(settings.allowTotalExcursionMinutes);
  conditions.push({
    key: 'total',
    ok: accumulated <= totalLimit,
    value: accumulated,
    limit: totalLimit,
    unit: '分钟',
    text: '累计超限不超过 ' + totalLimit + ' 分钟（跨月不重置）',
    gap: Math.max(0, accumulated - totalLimit),
    gapText: accumulated > totalLimit
      ? '累计超限 ' + accumulated + ' 分钟，超出门限 ' + (accumulated - totalLimit) + ' 分钟'
      : '',
  });

  conditions.push({
    key: 'chain',
    ok: chain.gapCount === 0,
    value: chain.gapCount,
    limit: 0,
    unit: '处',
    text: '全程没有断链（相邻记录间隔不超过 ' + settings.chainGapMinutes + ' 分钟）',
    gap: chain.gapCount,
    gapText: chain.gapCount > 0
      ? '有 ' + chain.gapCount + ' 处断链（最大缺口 ' + chain.gaps.reduce((m, g) => (g.minutes > m ? g.minutes : m), 0) + ' 分钟）'
      : '',
  });

  conditions.push({
    key: 'calibration',
    ok: expired.length === 0,
    value: expired.length,
    limit: 0,
    unit: '个',
    text: '参与判定的探头都在校准有效期内',
    gap: expired.length,
    gapText: expired.length
      ? '有 ' + expired.length + ' 个探头已过校准有效期：' + expired.map((p) => p.probeCode + '（有效期至 ' + p.calibratedUntil + '）').join('、')
      : '',
  });

  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

// 参与放行判定的输入指纹：批次本体、设置门槛、有效温度记录（去停用探头/手工优先之后）、相关探头状态与校准期。
// 预检之后、放行之前这些字节只要变过（补录、删除、判定重算、改设置、探头停用或校准期变化），指纹就对不上。
function batchFingerprint(data, batch) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batch.id).map((r) => [r.probeId, r.at, r.temperatureC, r.source]);
  const probeIds = Array.from(new Set(rows.map((r) => r[0]))).sort();
  const probes = probeIds.map((pid) => {
    const p = probeOf(data, pid);
    return p ? [p.id, p.status, p.calibratedUntil] : [pid, null, null];
  });
  const payload = {
    settings: {
      lowerLimitC: settings.lowerLimitC,
      upperLimitC: settings.upperLimitC,
      allowExcursionMinutes: settings.allowExcursionMinutes,
      allowTotalExcursionMinutes: settings.allowTotalExcursionMinutes,
      chainGapMinutes: settings.chainGapMinutes,
      recordIntervalMinutes: settings.recordIntervalMinutes,
      mktActivationEnergy: settings.mktActivationEnergy,
      gasConstant: settings.gasConstant,
    },
    batch: {
      id: batch.id,
      status: batch.status,
      loadedAt: batch.loadedAt,
      roomId: batch.roomId,
    },
    records: rows,
    probes,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
  batchFingerprint,
};
