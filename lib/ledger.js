// 签核台账：data/db.json 的唯一读写入口。
// 工序操作全部追加到 db.ledger；缺损上的 steps 为当前态，ledger 为不可变流水。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const status = require("./status");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

const ACTIVE_BATCH_STATUSES = ["open", "review"];

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "not_started",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "not_started",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    }
  ],
  batches: [],
  ledger: []
};

function httpError(code, message, extra) {
  const error = new Error(message);
  error.status = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let db = null;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return;
  }
  const migrated = migrate(db);
  if (migrated) await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// 旧数据迁移：旧缺损没有 steps，一律按未开工；旧批次若四道未齐则退回待复核
function migrate(db) {
  let migrated = false;
  if (!Array.isArray(db.ledger)) {
    db.ledger = [];
    migrated = true;
  }
  for (const damage of db.damages || []) {
    if (!damage.steps || typeof damage.steps !== "object") {
      damage.steps = {};
      damage.status = status.NOT_STARTED;
      damage.repairedAt = null;
      migrated = true;
    } else {
      const derived = status.damageStatus(damage);
      if (damage.status !== derived) {
        damage.status = derived;
        migrated = true;
      }
      if (derived === status.REPAIRED && !damage.repairedAt) {
        damage.repairedAt = damage.createdAt || nowIso();
        migrated = true;
      }
      if (derived !== status.REPAIRED && damage.repairedAt) {
        damage.repairedAt = null;
        migrated = true;
      }
    }
  }
  for (const batch of db.batches || []) {
    if (batch.status === "completed" && !status.canCompleteBatch(db, batch)) {
      batch.status = "review";
      batch.completedAt = null;
      migrated = true;
    }
  }
  return migrated;
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function appendEvent(db, type, payload = {}) {
  const event = { id: makeId("evt"), type, at: nowIso(), ...payload };
  db.ledger.push(event);
  return event;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw httpError(404, "缺损项不存在");
  return damage;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw httpError(404, "修补批次不存在");
  return batch;
}

// 工序操作前确认缺损处于可操作批次：取消批次锁定；
// completed 批次只允许回改/撤销（随后会把完成态退回待复核），不允许新增登记或签核
function batchForStepOp(db, damage, kind) {
  if (!damage.batchId) {
    throw httpError(409, "缺损尚未归入批次，先建批再登记工序");
  }
  const batch = findBatch(db, damage.batchId);
  if (batch.status === "canceled") {
    throw httpError(409, "批次已取消，工序记录锁定");
  }
  if (batch.status === "completed" && (kind === "submit" || kind === "sign")) {
    throw httpError(409, "批次已结项，新增登记与签核锁定；如需修改请回改较早工序");
  }
  return batch;
}

function assertStepKey(stepKey) {
  if (!status.stepMeta(stepKey)) {
    throw httpError(400, `工序不存在，可选：${status.STEP_KEYS.join(", ")}`);
  }
}

function parseOperatedAt(value) {
  if (value === undefined) return nowIso();
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw httpError(400, "operatedAt 必须是合法时间");
  return time.toISOString();
}

// 回改/撤销较早工序后，其后的已签核工序退回待复核；未签核的不动
function cascadeAfter(db, damage, index) {
  for (let j = index + 1; j < status.STEP_KEYS.length; j += 1) {
    const key = status.STEP_KEYS[j];
    const record = status.stepRecord(damage, key);
    if (record && record.state === status.STEP_SIGNED) {
      record.state = status.STEP_REVIEW;
      record.signedBy = null;
      record.signedAt = null;
      appendEvent(db, "step_reset", {
        damageId: damage.id,
        batchId: damage.batchId,
        step: key,
        reasonIndex: index
      });
    }
  }
}

// 缺损掉出完工态时，若批次已结项，完成态退回待复核
function rollbackCompletionIfNeeded(db, damage) {
  if (!damage.batchId) return;
  const batch = db.batches.find((item) => item.id === damage.batchId);
  if (batch && batch.status === "completed") {
    batch.status = "review";
    batch.completedAt = null;
    appendEvent(db, "batch_reopen", {
      batchId: batch.id,
      damageId: damage.id,
      reason: "较早工序回改或撤销，批次完成态退回待复核"
    });
  }
}

// 登记工序（第一道开始，后一道必须等前一道签核）
function submitStep(db, damageId, stepKey, body = {}) {
  assertStepKey(stepKey);
  const damage = findDamage(db, damageId);
  batchForStepOp(db, damage, "submit");
  if (!body.operator) throw httpError(400, "缺少字段：operator");

  const index = status.stepIndex(stepKey);
  const existing = status.stepRecord(damage, stepKey);
  if (existing) {
    // 重复提交：原记录不动
    if (existing.state === status.STEP_SUBMITTED) {
      throw httpError(409, "该工序已登记、待签核，原记录不动");
    }
    if (existing.state === status.STEP_SIGNED) {
      throw httpError(409, "该工序已签核，如需修改请回改");
    }
    throw httpError(409, "该工序退回待复核，请回改后重新登记");
  }
  for (let j = 0; j < index; j += 1) {
    if (status.stepState(damage, status.STEP_KEYS[j]) !== status.STEP_SIGNED) {
      throw httpError(409, "前道工序尚未签核，不能登记本道");
    }
  }

  const record = {
    state: status.STEP_SUBMITTED,
    operator: body.operator,
    operatedAt: parseOperatedAt(body.operatedAt),
    note: body.note || "",
    signedBy: null,
    signedAt: null
  };
  damage.steps[stepKey] = record;
  status.syncDamageStatus(damage);
  appendEvent(db, "step_submit", {
    damageId: damage.id,
    batchId: damage.batchId,
    step: stepKey,
    actor: body.operator,
    note: record.note
  });
  return { damage, record };
}

// 签核工序
function signStep(db, damageId, stepKey, body = {}) {
  assertStepKey(stepKey);
  const damage = findDamage(db, damageId);
  batchForStepOp(db, damage, "sign");
  if (!body.signedBy) throw httpError(400, "缺少字段：signedBy");

  const index = status.stepIndex(stepKey);
  const record = status.stepRecord(damage, stepKey);
  if (!record) throw httpError(409, "该工序尚未登记，无法签核");
  if (record.state === status.STEP_SIGNED) {
    throw httpError(409, "该工序已签核，原记录不动");
  }
  if (record.state === status.STEP_REVIEW) {
    throw httpError(409, "该工序待复核，请重新登记后再签核");
  }
  for (let j = 0; j < index; j += 1) {
    if (status.stepState(damage, status.STEP_KEYS[j]) !== status.STEP_SIGNED) {
      throw httpError(409, "前道工序尚未签核，不能签核本道");
    }
  }

  record.state = status.STEP_SIGNED;
  record.signedBy = body.signedBy;
  record.signedAt = nowIso();
  status.syncDamageStatus(damage);
  appendEvent(db, "step_sign", {
    damageId: damage.id,
    batchId: damage.batchId,
    step: stepKey,
    actor: body.signedBy
  });
  return { damage, record };
}

// 回改工序：已签核的改为重新登记，后续签核级联退回待复核；
// 待签核/待复核的记录可借此修改并重新登记，不触发级联
function amendStep(db, damageId, stepKey, body = {}) {
  assertStepKey(stepKey);
  const damage = findDamage(db, damageId);
  batchForStepOp(db, damage, "amend");

  const index = status.stepIndex(stepKey);
  const record = status.stepRecord(damage, stepKey);
  if (!record) throw httpError(409, "该工序尚无记录，不能回改，请直接登记");

  const fromState = record.state;
  if (body.operator !== undefined) record.operator = body.operator;
  if (body.note !== undefined) record.note = body.note;
  if (body.operatedAt !== undefined) record.operatedAt = parseOperatedAt(body.operatedAt);
  record.state = status.STEP_SUBMITTED;
  record.signedBy = null;
  record.signedAt = null;

  if (fromState === status.STEP_SIGNED) {
    cascadeAfter(db, damage, index);
  }
  status.syncDamageStatus(damage);
  rollbackCompletionIfNeeded(db, damage);
  appendEvent(db, "step_amend", {
    damageId: damage.id,
    batchId: damage.batchId,
    step: stepKey,
    actor: body.operator || record.operator,
    fromState
  });
  return { damage, record };
}

// 撤销工序：删除本道记录，后续已签核的退回待复核
function revokeStep(db, damageId, stepKey, body = {}) {
  assertStepKey(stepKey);
  const damage = findDamage(db, damageId);
  batchForStepOp(db, damage, "revoke");

  const index = status.stepIndex(stepKey);
  const record = status.stepRecord(damage, stepKey);
  if (!record) throw httpError(409, "该工序尚无记录，无需撤销");

  delete damage.steps[stepKey];
  cascadeAfter(db, damage, index);
  status.syncDamageStatus(damage);
  rollbackCompletionIfNeeded(db, damage);
  appendEvent(db, "step_revoke", {
    damageId: damage.id,
    batchId: damage.batchId,
    step: stepKey,
    actor: body.operator || ""
  });
  return { damage };
}

function createBatch(db, body) {
  const damageIds = Array.isArray(body.damageIds) ? body.damageIds : [];
  if (damageIds.length === 0) throw httpError(400, "damageIds必须是非空数组");
  const notFound = damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
  if (notFound.length) throw httpError(400, `缺损项不存在：${notFound.join(", ")}`);

  for (const id of damageIds) {
    const damage = db.damages.find((item) => item.id === id);
    if (damage.batchId) {
      const batch = db.batches.find((item) => item.id === damage.batchId);
      if (batch && ACTIVE_BATCH_STATUSES.includes(batch.status)) {
        throw httpError(409, `缺损 ${id} 已在批次 ${batch.name} 中，不能重复建批`);
      }
    }
    // 四项已签齐的缺损已完工，不再进批；其余按已有工序从第一道未签处继续
    if (status.damageStatus(damage) === status.REPAIRED) {
      throw httpError(409, `缺损 ${id} 四道工序已齐，无需再进批`);
    }
  }

  const batch = {
    id: makeId("batch"),
    name: body.name,
    status: "open",
    damageIds,
    note: body.note || "",
    createdAt: nowIso(),
    completedAt: null,
    canceledAt: null
  };
  db.batches.push(batch);
  for (const damage of db.damages) {
    if (damageIds.includes(damage.id)) {
      damage.batchId = batch.id;
      status.syncDamageStatus(damage);
    }
  }
  appendEvent(db, "batch_create", { batchId: batch.id, actor: body.operator || "", damageIds });
  return batch;
}

function completeBatch(db, batchId, body = {}) {
  const batch = findBatch(db, batchId);
  if (batch.status === "canceled") throw httpError(409, "批次已取消，不能结项");
  if (batch.status === "completed") throw httpError(409, "批次已结项，原记录不动");
  if (!status.canCompleteBatch(db, batch)) {
    const blocking = status
      .batchDamages(db, batch)
      .filter((damage) => status.damageStatus(damage) !== status.REPAIRED)
      .map((damage) => ({ damageId: damage.id, progress: status.damageProgress(damage) }));
    throw httpError(409, "批内尚有缺损四道工序未签齐，不能结项", { blocking });
  }

  const results = Array.isArray(body.results) ? body.results : [];
  for (const damage of status.batchDamages(db, batch)) {
    const result = results.find((item) => item.damageId === damage.id) || {};
    damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
    damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
  }
  batch.status = "completed";
  batch.completedAt = nowIso();
  if (body.note !== undefined) batch.note = body.note;
  appendEvent(db, "batch_complete", { batchId: batch.id, actor: body.operator || "" });
  return batch;
}

// 取消批次：已签结果全部保留，只解绑；重新建批时从第一道未签工序继续
function cancelBatch(db, batchId, body = {}) {
  const batch = findBatch(db, batchId);
  if (batch.status === "canceled") throw httpError(409, "批次已取消，原记录不动");
  if (batch.status === "completed") throw httpError(409, "批次已结项，不能取消");

  for (const damage of status.batchDamages(db, batch)) {
    damage.batchId = null;
    status.syncDamageStatus(damage);
  }
  batch.status = "canceled";
  batch.canceledAt = nowIso();
  if (body.note !== undefined) batch.note = body.note;
  appendEvent(db, "batch_cancel", { batchId: batch.id, actor: body.operator || "" });
  return batch;
}

function getLedger(db, filters = {}) {
  return db.ledger
    .filter(
      (event) =>
        (!filters.type || event.type === filters.type) &&
        (!filters.batchId || event.batchId === filters.batchId) &&
        (!filters.damageId || event.damageId === filters.damageId)
    )
    .slice()
    .reverse();
}

function enrichBatch(db, batch) {
  const damages = status.batchDamages(db, batch).map((damage) => status.damageView(damage));
  return {
    ...batch,
    damages,
    ...status.batchProgress(db, batch),
    canComplete: status.canCompleteBatch(db, batch)
  };
}

module.exports = {
  DB_FILE,
  initialData,
  httpError,
  makeId,
  ensureDb,
  readDb,
  writeDb,
  appendEvent,
  findDamage,
  findBatch,
  submitStep,
  signStep,
  amendStep,
  revokeStep,
  createBatch,
  completeBatch,
  cancelBatch,
  getLedger,
  enrichBatch
};
