# 古籍拓片缺损修补 API

纯后端零依赖 Node 服务，数据仍只持久化在 `data/db.json`。

- 状态判断（派生，不落盘）：`lib/status.js`
- 签核台账（签核/回改/撤销/复核/级联退回）：`lib/ledger.js`
- 请求入口（路由、校验、读写 db.json）：`routes.js`
- 启动壳：`server.js`

## 启动

```bash
PORT=3020 node server.js
```

## 工序规则

每个缺损固定四道工序，顺序签核，后一道以前一道已签核为前提：

1. `clean` 清洗
2. `patch` 补纸
3. `reinforce` 加固
4. `retouch` 润色

每次签核登记 **操作人 operator、时刻 at（不传由服务器生成）、备注 note**。

- **跳序提交**：前道未签核直接提交后道 → 409，原记录不动。
- **重复提交**：已签核工序再次 sign → 409，原记录不动；要改请走回改。
- **结项**：批次内所有缺损四道全部已签核才能 `complete`，否则返回 blockers 指明卡在哪一道。
- **回改 / 撤销较早工序**：
  - `revise`：覆盖本道签核（旧值留在该道 history），后面已签/待复核的道次退回 `pending_review`；
  - `revoke`：本道签核撤销、退回未签，后道同样退回待复核；
  - 若批次已结项，批次完成态一并退回 `review_pending`，需重新走完才能再结项。
- **复核**：退回 `pending_review` 的工序由复核人走 `review` 重新确认，仍按顺序逐道复核。
- **取消批次**：`cancel` 后批次保留、已签工序结果不动，缺损脱离批次；重新建批后从第一道未齐的工序继续。
- **旧缺损**：没有 `steps` 记录的旧数据一律按"未开工 not_started"派生。

## 接口

基础接口：

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=&phase=&batchId=`（phase: not_started/in_progress/review_pending/done）
- `GET /damages/:id` / `PATCH /damages/:id`（status 不可直接改，只走工序接口）
- `GET /batches` / `POST /batches` / `GET /batches/:id`
- `POST /batches/:id/complete` / `POST /batches/:id/cancel`

工序与台账（`:step` ∈ clean/patch/reinforce/retouch）：

- `POST /damages/:id/steps/:step/sign` — 提交签核 `{operator, note?, at?}`
- `POST /damages/:id/steps/:step/revise` — 回改 `{operator, note?}`
- `POST /damages/:id/steps/:step/revoke` — 撤销 `{operator?, note?}`
- `POST /damages/:id/steps/:step/review` — 复核确认 `{reviewer, note?}`
- `GET /damages/:id/ledger` — 该缺损四道签核台账（含历次动作）
- `GET /batches/:id/ledger` — 批次内全部缺损的签核台账

## 闭环示例

```bash
# 旧缺损默认未开工
curl 'http://127.0.0.1:3020/damages?phase=not_started'

# 建批（取消过的批次缺损可重新建批，已签结果保留）
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 按清洗→补纸→加固→润色逐道签核
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/steps/clean/sign \
  -H 'Content-Type: application/json' -d '{"operator":"张师傅","note":"水渍已清"}'

# 结批（四道未齐会被拒，blockers 指明缺口）
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete

# 查台账，看做到哪一步、谁签的
curl http://127.0.0.1:3020/batches/<batchId>/ledger
```
