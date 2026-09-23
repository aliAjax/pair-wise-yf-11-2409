# 古籍拓片缺损修补API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次和签核台账。

## 结构

- `server.js`：请求入口，只做 HTTP 路由与参数校验。
- `lib/status.js`：状态判断（纯函数）。工序态、缺损态、批次能否结项均由缺损上的四道工序记录推导，旧缺损无工序记录即为「未开工」。
- `lib/ledger.js`：签核台账。唯一读写 `db.json` 的模块，工序登记/签核/回改/撤销的规则与级联退回都在这里，并向 `ledger` 追加不可变事件。

数据仍只写现有的 `data/db.json`：缺损记录新增 `steps` 当前态，顶层新增 `ledger` 事件流。服务启动时自动迁移旧数据。

## 启动

```bash
PORT=3020 node server.js
```

## 工序流水线

每道缺损按固定顺序走四道工序：**清洗 cleaning → 补纸 filling → 加固 reinforcing → 润色 retouching**。

每次操作登记操作人、时刻和备注；**后一道必须等前一道签核**才能登记/签核。
重复提交或跳序提交返回 `409`，**原记录不动**。批内每个缺损四项全部签核，批次才允许结项。

- `POST /damages/:id/steps/:step` — 登记工序，body：`{operator, operatedAt?, note?}`
- `POST /damages/:id/steps/:step/sign` — 签核，body：`{signedBy}`
- `PATCH /damages/:id/steps/:step` — 回改较早工序（或对「待复核」工序重新登记）
- `DELETE /damages/:id/steps/:step` — 撤销工序

回改或撤销较早工序后，该道变为待签核，其后**已签核**的工序退回「待复核」；
若批次已结项，批次完成态也退回「待复核」，需重新签齐后再结项。

## 批次

- `POST /batches` — 建批，body：`{name, damageIds, note?, operator?}`
- `POST /batches/:id/cancel` — 取消批次：**已签结果全部保留**，只解绑缺损
- 取消后重新建批时，缺损带着原工序记录从第一道未签核的工序继续
- `POST /batches/:id/complete` — 四项签齐才结项，否则 `409` 并返回卡住的缺损进度；可带 `results`/`defaultAfterPhotoUrl` 写完工照片

## 其他接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `GET /damages/:id`
- `PATCH /damages/:id`（只改登记资料，工序状态不能直接覆写）
- `GET /batches` / `GET /batches/:id`
- `GET /ledger?damageId=&batchId=&type=` — 签核台账事件（最新在前）

缺损与批次响应中带 `progress`（各工序状态、当前工序、已签数量）；批次响应中带
`notStarted/inProgress/inReview/repaired` 计数和 `canComplete`。

## 闭环示例

```bash
curl http://127.0.0.1:3020/damages?status=not_started
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","damageIds":["damage_demo_1","damage_demo_2"]}'

curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/steps/cleaning \
  -H 'Content-Type: application/json' -d '{"operator":"张师傅","note":"虫蛀孔先除尘"}'
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/steps/cleaning/sign \
  -H 'Content-Type: application/json' -d '{"signedBy":"王审核"}'
```
