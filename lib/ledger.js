// 签核台账：四道工序的提交签核、回改、撤销、复核，及级联退回。
// 只改传入对象，文件读写由请求入口负责。
// 每次动作都追加 history（原记录不动，回改/撤销只追加并把后道置为待复核）。

const {
  STEP_KEYS,
  STEP_STATE,
  stepIndex,
  stepState,
  stepRecord,
  progress,
  legacyStatus
} = require("./status");

class WorkflowError extends Error {
  constructor(message, status = 409, code = "workflow_conflict") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ensureSteps(damage) {
  if (!damage.steps) damage.steps = {};
  STEP_KEYS.forEach((key) => {
    if (!damage.steps[key]) damage.steps[key] = { state: STEP_STATE.UNSIGNED, signoff: null, review: null, history: [] };
  });
}

function appendHistory(damage, key, entry) {
  ensureSteps(damage);
  damage.steps[key].history.push(entry);
}

function syncDamageStatus(damage) {
  const before = progress(damage);
  damage.status = legacyStatus(damage);
  damage.workflowPhase = before.phase;
  if (before.phase === "done") {
    if (!damage.repairedAt) damage.repairedAt = nowIso();
  } else {
    damage.repairedAt = null;
  }
}

// 前道变动后：后面已签/待复核的道次一律退回待复核；未签的保持未签
function rollbackAfter(damage, key) {
  const idx = stepIndex(key);
  const affected = [];
  STEP_KEYS.forEach((later) => {
    if (stepIndex(later) <= idx) return;
    ensureSteps(damage);
    const record = damage.steps[later];
    if (record.state === STEP_STATE.SIGNED || record.state === STEP_STATE.PENDING_REVIEW) {
      record.state = STEP_STATE.PENDING_REVIEW;
      record.review = null;
      affected.push(later);
    }
  });
  return affected;
}

function assertPrerequisiteSigned(damage, key) {
  const idx = stepIndex(key);
  for (let i = 0; i < idx; i += 1) {
    const prev = STEP_KEYS[i];
    if (stepState(damage, prev) !== STEP_STATE.SIGNED) {
      throw new WorkflowError(
        `前道工序未签核，需先完成「${prev === "clean" ? "清洗" : prev === "patch" ? "补纸" : prev === "reinforce" ? "加固" : "润色"}」后再提交本道`,
        409,
        "out_of_sequence"
      );
    }
  }
}

// 提交签核（重复或跳序直接拒绝，原记录不动）
function sign(damage, key, input) {
  if (!STEP_KEYS.includes(key)) throw new WorkflowError("未知工序", 400, "bad_step");
  if (!input.operator) throw new WorkflowError("缺少操作人", 400, "missing_field");

  const state = stepState(damage, key);
  if (state === STEP_STATE.SIGNED) {
    throw new WorkflowError(`「${stepLabel(key)}」已签核，重复提交不改动原记录；如需更正请走回改`, 409, "duplicate_signoff");
  }
  assertPrerequisiteSigned(damage, key);

  ensureSteps(damage);
  const signoff = {
    operator: input.operator,
    note: input.note || "",
    at: input.at || nowIso()
  };
  damage.steps[key].signoff = signoff;
  damage.steps[key].state = STEP_STATE.SIGNED;
  damage.steps[key].review = null;
  appendHistory(damage, key, { action: "sign", ...signoff });

  syncDamageStatus(damage);
  return { signoff, damage };
}

// 回改较早工序：覆盖本道签核，后道退回待复核，已结项批次由入口改判
function revise(damage, key, input) {
  if (!STEP_KEYS.includes(key)) throw new WorkflowError("未知工序", 400, "bad_step");
  if (!input.operator) throw new WorkflowError("缺少操作人", 400, "missing_field");

  const record = stepRecord(damage, key);
  if (!record || !record.signoff) throw new WorkflowError(`「${stepLabel(key)}」尚未签核，无可回改内容`, 409, "nothing_to_revise");

  const previous = { ...record.signoff };
  const signoff = {
    operator: input.operator,
    note: input.note || "",
    at: input.at || nowIso()
  };
  appendHistory(damage, key, { action: "revise", previous, ...signoff });
  record.signoff = signoff;
  record.state = STEP_STATE.SIGNED;
  record.review = null;

  const rolledBack = rollbackAfter(damage, key);
  rolledBack.forEach((later) =>
    appendHistory(damage, later, { action: "rollback", reason: "prior_step_revised", causedByStep: key, at: nowIso() })
  );

  syncDamageStatus(damage);
  return { signoff, rolledBack, damage };
}

// 撤销较早工序：本道签核清空退回未签，后道退回待复核
function revoke(damage, key, input) {
  if (!STEP_KEYS.includes(key)) throw new WorkflowError("未知工序", 400, "bad_step");
  const record = stepRecord(damage, key);
  if (!record || !record.signoff) throw new WorkflowError(`「${stepLabel(key)}」尚未签核，无可撤销内容`, 409, "nothing_to_revoke");

  const previous = { ...record.signoff };
  appendHistory(damage, key, {
    action: "revoke",
    previous,
    operator: input.operator || "",
    note: input.note || "",
    at: nowIso()
  });
  record.signoff = null;
  record.state = STEP_STATE.UNSIGNED;
  record.review = null;

  const rolledBack = rollbackAfter(damage, key);
  rolledBack.forEach((later) =>
    appendHistory(damage, later, { action: "rollback", reason: "prior_step_revoked", causedByStep: key, at: nowIso() })
  );

  syncDamageStatus(damage);
  return { rolledBack, damage };
}

// 复核确认：把待复核工序重新签核（操作人/时间/备注按复核动作另记 review）
function review(damage, key, input) {
  if (!STEP_KEYS.includes(key)) throw new WorkflowError("未知工序", 400, "bad_step");
  if (!input.reviewer) throw new WorkflowError("缺少复核人", 400, "missing_field");

  const record = stepRecord(damage, key);
  if (!record || record.state !== STEP_STATE.PENDING_REVIEW) {
    throw new WorkflowError(`「${stepLabel(key)}」不在待复核状态`, 409, "not_pending_review");
  }
  assertPrerequisiteSigned(damage, key);

  const reviewEntry = {
    reviewer: input.reviewer,
    note: input.note || "",
    at: input.at || nowIso()
  };
  appendHistory(damage, key, { action: "review", ...reviewEntry });
  record.review = reviewEntry;
  record.state = STEP_STATE.SIGNED;

  syncDamageStatus(damage);
  return { review: reviewEntry, damage };
}

function stepLabel(key) {
  return { clean: "清洗", patch: "补纸", reinforce: "加固", retouch: "润色" }[key] || key;
}

// 签核台账：某缺损四道的当前台账 + 历次动作
function damageLedger(damage) {
  const steps = STEP_KEYS.map((key) => {
    const record = stepRecord(damage, key) || { state: STEP_STATE.UNSIGNED, signoff: null, review: null, history: [] };
    return {
      key,
      label: stepLabel(key),
      state: record.state,
      signoff: record.signoff ? { ...record.signoff } : null,
      review: record.review ? { ...record.review } : null,
      history: (record.history || []).map((entry) => ({ ...entry }))
    };
  });
  return {
    damageId: damage.id,
    position: damage.position,
    type: damage.type,
    batchId: damage.batchId || null,
    progress: progress(damage),
    steps
  };
}

function batchLedger(db, batch) {
  return db.damages
    .filter((damage) => batch.damageIds.includes(damage.id))
    .map((damage) => damageLedger(damage));
}

// 已结项批次出现回改：批次完成态退回待复核
function markBatchReviewPending(batch, input = {}) {
  if (batch.status === "completed") {
    batch.status = "review_pending";
    batch.completedAt = null;
    if (!batch.history) batch.history = [];
    batch.history.push({
      action: "reopen_for_review",
      reason: input.reason || "prior_step_changed",
      causedBy: { damageId: input.damageId || null, step: input.step || null },
      at: nowIso()
    });
  }
}

module.exports = {
  WorkflowError,
  ensureSteps,
  sign,
  revise,
  revoke,
  review,
  damageLedger,
  batchLedger,
  markBatchReviewPending
};
