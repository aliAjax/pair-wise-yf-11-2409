// 启动壳：路由与请求处理见 routes.js，状态判断见 lib/status.js，签核台账见 lib/ledger.js。
const http = require("http");
const { handle } = require("./routes");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    res.writeHead(error.status || 500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || "服务器错误" }, null, 2));
  });
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
