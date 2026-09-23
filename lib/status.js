// 状态判断：纯函数模块，不读写文件。
// 工序状态完全由缺损上的 steps 记录推导，批次结项态由各缺损工序态推导。

const STEPS = [
  { key: "cleaning", label: "清洗" },
  { key: "filling", label: "补纸" },
  { key: "reinforcing", label: "加固" },
  { key: "retouching", label: "润色" }
];

const STEP_KEYS = STEPS.map((item) => item.key);

// 缺损状态
const NOT_STARTED = "not_started"; // 未开工（旧缺损无工序记录时同此态）
const IN_PROGRESS = "in_progress"; // 施工中
const IN_REVIEW = "review"; // 待复核（较早工序被回改/撤销，后续签核失效）
const REPAIRED = "repaired"; // 四项签核齐全，完工

// 工序状态
const STEP_UNSET = "unset"; // 未登记
const STEP_SUBMITTED = "submitted"; // 已登记，待签核
const STEP_SIGNED = "signed"; // 已签核
const STEP_REVIEW = "review"; // 签核退回待复核

function stepMeta(key) {
  return STEPS.find((item) => item.key === key) || null;
}

function stepIndex(key) {
  return STEP_KEYS.indexOf(key);
}

function stepRecord(damage, key) {
  return (damage.steps && damage.steps[key]) || null;
}

function stepState(damage, key) {
  const record = stepRecord(damage, key);
  return record ? record.state : STEP_UNSET;
}

// 第一道尚未签核的工序下标；四项全签完返回 -1
function currentStepIndex(damage) {
  return STEP_KEYS.findIndex((key) => stepState(damage, key) !== STEP_SIGNED);
}

// 已签核的工序数
function signedCount(damage) {
  return STEP_KEYS.filter((key) => stepState(damage, key) === STEP_SIGNED).length;
}

function damageStatus(damage) {
  const states = STEP_KEYS.map((key) => stepState(damage, key));
  if (states.every((state) => state === STEP_SIGNED)) return REPAIRED;
  if (states.every((state) => state === STEP_UNSET)) return NOT_STARTED;
  if (states.includes(STEP_REVIEW)) return IN_REVIEW;
  return IN_PROGRESS;
}

function damageFinished(damage) {
  return damageStatus(damage) === REPAIRED;
}

function damageProgress(damage) {
  const current = currentStepIndex(damage);
  return {
    status: damageStatus(damage),
    currentStep: current === -1 ? null : STEP_KEYS[current],
    currentStepLabel: current === -1 ? null : STEPS[current].label,
    signedCount: signedCount(damage),
    stages: STEPS.map(({ key, label }) => {
      const record = stepRecord(damage, key);
      return {
        key,
        label,
        state: record ? record.state : STEP_UNSET,
        operator: record ? record.operator : null,
        operatedAt: record ? record.operatedAt : null,
        note: record ? record.note : "",
        signedBy: record ? record.signedBy : null,
        signedAt: record ? record.signedAt : null
      };
    })
  };
}

// 在返回给请求方的缺损对象上附带工序进度，不改动持久化结构
function damageView(damage) {
  return { ...damage, progress: damageProgress(damage) };
}

function batchDamages(db, batch) {
  return db.damages.filter((damage) => batch.damageIds.includes(damage.id));
}

function batchProgress(db, batch) {
  const damages = batchDamages(db, batch);
  const count = (status) => damages.filter((damage) => damageStatus(damage) === status).length;
  return {
    total: damages.length,
    notStarted: count(NOT_STARTED),
    inProgress: count(IN_PROGRESS),
    inReview: count(IN_REVIEW),
    repaired: count(REPAIRED)
  };
}

// 四项齐了（批内每个缺损四道工序全部签核）才允许结项
function canCompleteBatch(db, batch) {
  const damages = batchDamages(db, batch);
  return (
    damages.length > 0 &&
    damages.every((damage) => damageStatus(damage) === REPAIRED)
  );
}

// 把推导结果同步回缺损的冗余状态字段，便于旧的 status 查询条件继续可用
function syncDamageStatus(damage, now = new Date().toISOString()) {
  const status = damageStatus(damage);
  damage.status = status;
  damage.repairedAt = status === REPAIRED ? damage.repairedAt || now : null;
  return status;
}

module.exports = {
  STEPS,
  STEP_KEYS,
  NOT_STARTED,
  IN_PROGRESS,
  IN_REVIEW,
  REPAIRED,
  STEP_UNSET,
  STEP_SUBMITTED,
  STEP_SIGNED,
  STEP_REVIEW,
  stepMeta,
  stepIndex,
  stepRecord,
  stepState,
  currentStepIndex,
  signedCount,
  damageStatus,
  damageFinished,
  damageProgress,
  damageView,
  batchDamages,
  batchProgress,
  canCompleteBatch,
  syncDamageStatus
};
