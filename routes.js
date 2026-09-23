// 请求入口：路由、参数校验、data/db.json 读写都在这里；
// 状态判断走 lib/status.js，签核/回改/撤销/复核走 lib/ledger.js。

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const status = require("./lib/status");
const ledger = require("./lib/ledger");

const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
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
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  batches: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=&phase=",
  "GET /damages/:id",
  "PATCH /damages/:id",
  "POST /damages/:id/steps/:step/sign",
  "POST /damages/:id/steps/:step/revise",
  "POST /damages/:id/steps/:step/revoke",
  "POST /damages/:id/steps/:step/review",
  "GET /damages/:id/ledger",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "GET /batches/:id/ledger",
  "POST /batches/:id/complete",
  "POST /batches/:id/cancel"
];

const STEP_NAMES = { clean: "清洗", patch: "补纸", reinforce: "加固", retouch: "润色" };

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) {
    const error = new Error("缺损项不存在");
    error.status = 404;
    throw error;
  }
  return damage;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) {
    const error = new Error("修补批次不存在");
    error.status = 404;
    throw error;
  }
  return batch;
}

function enrichDamage(damage) {
  const workflow = status.progress(damage);
  return {
    ...damage,
    status: status.legacyStatus(damage),
    workflowPhase: workflow.phase,
    workflow
  };
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const derived = status.deriveBatch(batch, damages);
  return {
    ...batch,
    status: derived.status,
    statusLabel: derived.statusLabel,
    readyToComplete: derived.readyToComplete,
    damages: damages.map((damage) => {
      const workflow = status.progress(damage);
      return {
        id: damage.id,
        position: damage.position,
        type: damage.type,
        phase: workflow.phase,
        phaseLabel: workflow.phaseLabel,
        current: workflow.current,
        currentLabel: workflow.currentLabel,
        signedCount: workflow.signedCount,
        totalSteps: workflow.totalSteps
      };
    }),
    total: damages.length,
    done: damages.filter((damage) => status.isDone(damage)).length,
    reviewPending: damages.filter((damage) => status.progress(damage).phase === status.PHASE.REVIEW_PENDING).length,
    blockers: derived.blockers
  };
}

// 前道回改/撤销若发生在已结项批次，批次完成态一并退回待复核
function touchBatchAfterMutation(db, damage, step) {
  if (!damage.batchId) return;
  const batch = db.batches.find((item) => item.id === damage.batchId);
  if (batch && batch.status === "completed") {
    ledger.markBatchReviewPending(batch, { damageId: damage.id, step });
  }
}

function pushBatchHistory(batch, entry) {
  if (!batch.history) batch.history = [];
  batch.history.push({ at: new Date().toISOString(), ...entry });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", steps: status.STEPS, routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => !status.isDone(item)).length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId).map(enrichDamage) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      workflowPhase: "not_started",
      repairNote: "",
      batchId: null,
      steps: {},
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    ledger.ensureSteps(damage);
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: enrichDamage(damage) });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const statusFilter = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const phase = url.searchParams.get("phase");
    const batchId = url.searchParams.get("batchId");
    const data = db.damages
      .filter((item) => !type || item.type === type)
      .filter((item) => !batchId || item.batchId === batchId)
      .filter((item) => !phase || status.progress(item).phase === phase)
      .filter((item) => !statusFilter || status.legacyStatus(item) === statusFilter)
      .map(enrichDamage);
    return send(res, 200, { data });
  }

  const stepMatch = pathname.match(/^\/damages\/([^/]+)\/steps\/([^/]+)\/(sign|revise|review)$/);
  if (stepMatch && req.method === "POST") {
    const damage = findDamage(db, stepMatch[1]);
    const step = stepMatch[2];
    const action = stepMatch[3];
    if (!status.isStepKey(step)) return send(res, 400, { error: `未知工序：${step}`, steps: Object.keys(STEP_NAMES) });
    const body = await parseBody(req);
    let result;
    if (action === "sign") result = ledger.sign(damage, step, body);
    if (action === "revise") result = ledger.revise(damage, step, body);
    if (action === "review") result = ledger.review(damage, step, body);
    const { damage: _omit, ...payload } = result;
    touchBatchAfterMutation(db, damage, step);
    await writeDb(db);
    return send(res, 200, {
      data: {
        action,
        step,
        stepLabel: STEP_NAMES[step],
        ...payload,
        workflow: status.progress(damage)
      }
    });
  }

  // 撤销路由单独匹配（revise 与 revoke 前缀不同，上面的正则只含 sign/revise/review 之外的 revoke）
  const revokeMatch = pathname.match(/^\/damages\/([^/]+)\/steps\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const damage = findDamage(db, revokeMatch[1]);
    const step = revokeMatch[2];
    if (!status.isStepKey(step)) return send(res, 400, { error: `未知工序：${step}`, steps: Object.keys(STEP_NAMES) });
    const body = await parseBody(req);
    const result = ledger.revoke(damage, step, body);
    touchBatchAfterMutation(db, damage, step);
    await writeDb(db);
    return send(res, 200, { data: { action: "revoke", step, stepLabel: STEP_NAMES[step], ...result, workflow: status.progress(damage) } });
  }

  const ledgerMatch = pathname.match(/^\/damages\/([^/]+)\/ledger$/);
  if (ledgerMatch && req.method === "GET") {
    const damage = findDamage(db, ledgerMatch[1]);
    return send(res, 200, { data: ledger.damageLedger(damage) });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "GET") {
    const damage = findDamage(db, damagePatchMatch[1]);
    return send(res, 200, { data: enrichDamage(damage) });
  }

  if (damagePatchMatch && req.method === "PATCH") {
    const damage = findDamage(db, damagePatchMatch[1]);
    const body = await parseBody(req);
    // 工序状态不允许直接改，只能走签核流程
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      repairNote: body.repairNote ?? damage.repairNote
    });
    await writeDb(db);
    return send(res, 200, { data: enrichDamage(damage) });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });

    // 已挂在未取消批次下的缺损不能重复建批；取消批次保留已签结果，可重新建批
    const occupied = body.damageIds.filter((id) => {
      const batch = db.batches.find(
        (item) => item.damageIds.includes(id) && ["open", "review_pending", "completed"].includes(item.status)
      );
      return Boolean(batch);
    });
    if (occupied.length) return send(res, 409, { error: `缺损已在其他未结/未取消批次中：${occupied.join(", ")}` });

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      history: [{ action: "create", at: new Date().toISOString() }]
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) damage.batchId = batch.id;
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchLedgerMatch = pathname.match(/^\/batches\/([^/]+)\/ledger$/);
  if (batchLedgerMatch && req.method === "GET") {
    const batch = findBatch(db, batchLedgerMatch[1]);
    return send(res, 200, { data: { batchId: batch.id, name: batch.name, ledger: ledger.batchLedger(db, batch) } });
  }

  const cancelMatch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const batch = findBatch(db, cancelMatch[1]);
    if (!["open", "review_pending"].includes(batch.status)) {
      return send(res, 409, { error: `批次当前为${batch.status}，不可取消` });
    }
    const body = await parseBody(req);
    batch.status = "canceled";
    batch.completedAt = null;
    batch.canceledAt = new Date().toISOString();
    if (body.note) batch.note = body.note;
    pushBatchHistory(batch, { action: "cancel", note: body.note || "" });
    // 取消批次但保留已签结果：缺损脱离批次，工序签核不动
    db.damages.forEach((damage) => {
      if (batch.damageIds.includes(damage.id)) damage.batchId = null;
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = findBatch(db, completeMatch[1]);
    const damages = db.damages.filter((damage) => batch.damageIds.includes(damage.id));
    const derived = status.deriveBatch(batch, damages);
    if (!derived.readyToComplete) {
      return send(res, 409, { error: "四项工序未全部签核，批次不能结项", blockers: derived.blockers });
    }
    const body = await parseBody(req);
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    if (body.note !== undefined) batch.note = body.note;
    pushBatchHistory(batch, { action: "complete" });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = findBatch(db, batchMatch[1]);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle };
