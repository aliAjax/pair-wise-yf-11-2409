// 状态判断：工序顺序、缺损进度、批次结项状态均在此纯派生，不读写文件。
// 工序固定为四道，后一道以前一道“已签核”为前提。

const STEPS = [
  { key: "clean", label: "清洗" },
  { key: "patch", label: "补纸" },
  { key: "reinforce", label: "加固" },
  { key: "retouch", label: "润色" }
];

const STEP_KEYS = STEPS.map((step) => step.key);

const STEP_STATE = {
  UNSIGNED: "unsigned", // 未签核（未做）
  SIGNED: "signed", // 已签核
  PENDING_REVIEW: "pending_review" // 前道回改/撤销后，本道退回待复核
};

const PHASE = {
  NOT_STARTED: "not_started", // 未开工
  IN_PROGRESS: "in_progress", // 工序进行中
  REVIEW_PENDING: "review_pending", // 有待复核工序
  DONE: "done" // 四道齐
};

function labelOf(key) {
  const step = STEPS.find((item) => item.key === key);
  return step ? step.label : key;
}

function isStepKey(key) {
  return STEP_KEYS.includes(key);
}

function stepIndex(key) {
  return STEP_KEYS.indexOf(key);
}

function stepRecord(damage, key) {
  return damage.steps && damage.steps[key] ? damage.steps[key] : null;
}

function stepState(damage, key) {
  const record = stepRecord(damage, key);
  return record ? record.state : STEP_STATE.UNSIGNED;
}

function stepView(damage, key) {
  const record = stepRecord(damage, key);
  return {
    key,
    label: labelOf(key),
    state: record ? record.state : STEP_STATE.UNSIGNED,
    signoff: record && record.signoff ? { ...record.signoff } : null,
    review: record && record.review ? { ...record.review } : null
  };
}

// 缺损是否留下过任何签核痕迹（旧缺损没有 steps，按未开工）
function hasAnyRecord(damage) {
  return STEP_KEYS.some((key) => {
    const record = stepRecord(damage, key);
    return Boolean(record) && (Boolean(record.signoff) || (record.history || []).length > 0);
  });
}

// 缺损级进度：当前应做/应复核的工序、各道状态
function progress(damage) {
  const steps = STEP_KEYS.map((key) => stepView(damage, key));
  const signedCount = steps.filter((step) => step.state === STEP_STATE.SIGNED).length;
  const currentStep = steps.find((step) => step.state !== STEP_STATE.SIGNED) || null;
  const inReview = steps.some((step) => step.state === STEP_STATE.PENDING_REVIEW);
  // 当前卡点若是未签工序（如前道被撤销），应先重做该道，而非先复核后道
  const blockedAtUnsigned = Boolean(currentStep && currentStep.state === STEP_STATE.UNSIGNED);

  let phase;
  if (signedCount === STEP_KEYS.length) {
    phase = PHASE.DONE;
  } else if (!hasAnyRecord(damage)) {
    phase = PHASE.NOT_STARTED;
  } else if (inReview && !blockedAtUnsigned) {
    phase = PHASE.REVIEW_PENDING;
  } else {
    phase = PHASE.IN_PROGRESS;
  }

  return {
    phase,
    phaseLabel: {
      [PHASE.NOT_STARTED]: "未开工",
      [PHASE.IN_PROGRESS]: "进行中",
      [PHASE.REVIEW_PENDING]: "待复核",
      [PHASE.DONE]: "四道已齐"
    }[phase],
    current: currentStep ? currentStep.key : null,
    currentLabel: currentStep ? currentStep.label : null,
    signedCount,
    totalSteps: STEP_KEYS.length,
    steps
  };
}

function isDone(damage) {
  return progress(damage).phase === PHASE.DONE;
}

// 兼容旧 status 字段：pending / in_repair / repaired
function legacyStatus(damage) {
  const phase = progress(damage).phase;
  if (phase === PHASE.DONE) return "repaired";
  if (phase === PHASE.NOT_STARTED) return "pending";
  return "in_repair";
}

// 批次结项状态：已结项批次若因前道回改导致缺损不再四道齐，派生为待复核
function deriveBatch(batch, damages) {
  const allDone = damages.length > 0 && damages.every((damage) => isDone(damage));
  let status = batch.status;
  if (status === "completed" && !allDone) status = "review_pending";
  const blockers = damages
    .filter((damage) => !isDone(damage))
    .map((damage) => {
      const p = progress(damage);
      return {
        damageId: damage.id,
        position: damage.position,
        phase: p.phase,
        phaseLabel: p.phaseLabel,
        current: p.current,
        currentLabel: p.currentLabel,
        signedCount: p.signedCount
      };
    });
  return {
    status,
    statusLabel: {
      open: "进行中",
      review_pending: "待复核",
      completed: "已结项",
      canceled: "已取消"
    }[status] || status,
    allDone,
    readyToComplete: ["open", "review_pending"].includes(status) && allDone,
    blockers
  };
}

module.exports = {
  STEPS,
  STEP_KEYS,
  STEP_STATE,
  PHASE,
  labelOf,
  isStepKey,
  stepIndex,
  stepState,
  stepRecord,
  stepView,
  progress,
  isDone,
  legacyStatus,
  deriveBatch
};
