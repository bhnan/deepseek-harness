#!/usr/bin/env node
// tc —— 教学日历(8787) + 学生成长档案(8797) 统一 Agent CLI
// stdout 恒为单个 JSON 信封；人类诊断走 stderr。详见 tc discover。

import { dispatch } from './lib/commands.mjs';
import { envelopeFromError, TcError } from './lib/api.mjs';

const argv = process.argv.slice(2);

// JSON 输出统一收口（含 --pretty 可选）；写回调后退出，防管道下信封被截断
async function main() {
  const pretty = argv.includes('--pretty');
  const out = (envelope, code) => process.stdout.write(JSON.stringify(envelope, null, pretty ? 2 : 0) + '\n', () => process.exit(code));

  try {
    const { envelope, exitCode } = await dispatch(argv.filter((a) => a !== '--pretty'));
    out(envelope, exitCode);
  } catch (err) {
    // 兜底：任何未预期本地错误也保持 JSON 契约
    out(envelopeFromError(err instanceof TcError ? err : new TcError('UPSTREAM_ERROR', `内部错误：${err?.message || err}`)), 3);
  }
}

main();
