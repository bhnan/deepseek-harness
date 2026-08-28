/** 插件文件日志：按天轮转，data/logs/plugin/YYYY-MM-DD.log。
 *  记录：插件启动、HTTP 请求、cron 触发/执行、个股导出、客户端上报的错误、异常堆栈。
 */
const fs = require("node:fs");
const path = require("node:path");

class FileLogger {
  constructor(dir) {
    this.dir = dir;
  }

  _file() {
    return path.join(this.dir, `${new Date().toISOString().slice(0, 10)}.log`);
  }

  _write(level, msg, ctx) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const ctxStr = ctx === undefined ? "" : " " + (typeof ctx === "string" ? ctx : JSON.stringify(ctx));
      const line = `${new Date().toISOString()} [${level}] ${msg}${ctxStr}\n`;
      fs.appendFileSync(this._file(), line, "utf8");
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }

  info(msg, ctx) { this._write("INFO", msg, ctx); }
  warn(msg, ctx) { this._write("WARN", msg, ctx); }
  error(msg, ctx) { this._write("ERROR", msg, ctx); }

  request(method, url, status, ms) {
    this.info("http", { method, url, status, ms });
  }

  clientReport(payload) {
    this._write(payload.level === "error" ? "ERROR" : "INFO", "client", payload);
  }

  /** 读今日日志最后 N 行（调试端点用）。 */
  tail(lines = 100) {
    try {
      const file = this._file();
      if (!fs.existsSync(file)) return [];
      const text = fs.readFileSync(file, "utf8");
      return text.split("\n").filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }
}

module.exports = { FileLogger };
