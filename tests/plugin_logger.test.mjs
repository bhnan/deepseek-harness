/* 文件日志模块测试：按天落盘 / 追加 / tail 读取 / 失败不影响主流程。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { FileLogger } = require("../plugins/trading-dashboard/src/logger.js");

test("FileLogger 写入/追加/tail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "td-log-"));
  const log = new FileLogger(dir);
  log.info("hello", { a: 1 });
  log.error("boom", "stack-abc");
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes("[INFO] hello"), "INFO 行落盘");
  assert.ok(content.includes("[ERROR] boom"), "ERROR 行落盘");
  assert.ok(content.includes("stack-abc"), "上下文落盘");
  const lines = log.tail(1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("[ERROR] boom"), "tail 返回最后一行");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("FileLogger 目录不可写时不抛异常", () => {
  const log = new FileLogger("/nonexistent-root/xyz/sub");
  assert.doesNotThrow(() => log.info("should not throw"));
  assert.deepEqual(log.tail(10), []);
});
