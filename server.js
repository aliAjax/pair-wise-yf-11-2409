const http = require("http");
const ledger = require("./lib/ledger");
const status = require("./lib/status");

const PORT = Number(process.env.PORT || 3020);

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "GET /damages/:id",
  "PATCH /damages/:id",
  "POST /damages/:id/steps/:step  {operator,operatedAt?,note?} 登记工序",
  "POST /damages/:id/steps/:step/sign  {signedBy} 签核",
  "PATCH /damages/:id/steps/:step  回改/重新登记（后续签核退回待复核）",
  "DELETE /damages/:id/steps/:step  撤销工序",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete  四项签齐才允许结项",
  "POST /batches/:id/cancel  取消批次，已签结果保留",
  "GET /ledger?damageId=&batchId=&type="
];

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
    throw ledger.httpError(400, "请求体必须是合法JSON");
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw ledger.httpError(400, `缺少字段：${missing.join(", ")}`);
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw ledger.httpError(404, "拓片不存在");
  return rubbing;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const db = await ledger.readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== status.REPAIRED).length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: ledger.makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await ledger.writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const data = db.damages
      .filter((item) => item.rubbingId === rubbingId)
      .map((damage) => status.damageView(damage));
    return send(res, 200, { data });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: ledger.makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: status.NOT_STARTED,
      steps: {},
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await ledger.writeDb(db);
    return send(res, 201, { data: status.damageView(damage) });
  }

  const stepMatch = pathname.match(/^\/damages\/([^/]+)\/steps\/([^/]+)$/);
  if (stepMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { damage } = ledger.submitStep(db, stepMatch[1], stepMatch[2], body);
    await ledger.writeDb(db);
    return send(res, 201, { data: status.damageView(damage) });
  }
  if (stepMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const { damage } = ledger.amendStep(db, stepMatch[1], stepMatch[2], body);
    await ledger.writeDb(db);
    return send(res, 200, { data: status.damageView(damage) });
  }
  if (stepMatch && req.method === "DELETE") {
    const body = await parseBody(req).catch(() => ({}));
    const { damage } = ledger.revokeStep(db, stepMatch[1], stepMatch[2], body);
    await ledger.writeDb(db);
    return send(res, 200, { data: status.damageView(damage) });
  }

  const signMatch = pathname.match(/^\/damages\/([^/]+)\/steps\/([^/]+)\/sign$/);
  if (signMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { damage } = ledger.signStep(db, signMatch[1], signMatch[2], body);
    await ledger.writeDb(db);
    return send(res, 200, { data: status.damageView(damage) });
  }

  const damageMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damageMatch && req.method === "GET") {
    const damage = ledger.findDamage(db, damageMatch[1]);
    return send(res, 200, { data: status.damageView(damage) });
  }
  if (damageMatch && req.method === "PATCH") {
    const damage = ledger.findDamage(db, damageMatch[1]);
    const body = await parseBody(req);
    // 只允许改登记资料；工序状态走 steps 接口，不能直接覆写
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      repairNote: body.repairNote ?? damage.repairNote
    });
    await ledger.writeDb(db);
    return send(res, 200, { data: status.damageView(damage) });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const statusFilter = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages
      .filter((item) => (!statusFilter || item.status === statusFilter) && (!type || item.type === type))
      .map((damage) => status.damageView(damage));
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => ledger.enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    const batch = ledger.createBatch(db, body);
    await ledger.writeDb(db);
    return send(res, 201, { data: ledger.enrichBatch(db, batch) });
  }

  if (req.method === "GET" && pathname === "/ledger") {
    const data = ledger.getLedger(db, {
      type: url.searchParams.get("type"),
      batchId: url.searchParams.get("batchId"),
      damageId: url.searchParams.get("damageId")
    });
    return send(res, 200, { data });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = ledger.findBatch(db, batchMatch[1]);
    return send(res, 200, { data: ledger.enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = ledger.completeBatch(db, completeMatch[1], body);
    await ledger.writeDb(db);
    return send(res, 200, { data: ledger.enrichBatch(db, batch) });
  }

  const cancelMatch = pathname.match(/^\/batches\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const body = await parseBody(req);
    const batch = ledger.cancelBatch(db, cancelMatch[1], body);
    await ledger.writeDb(db);
    return send(res, 200, { data: ledger.enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) =>
    send(res, error.status || 500, { error: error.message || "服务器错误", blocking: error.blocking })
  );
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
