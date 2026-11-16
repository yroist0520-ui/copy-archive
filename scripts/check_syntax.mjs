#!/usr/bin/env node
/* 前端 ES 模块语法自检。
 *
 * 注意：直接 `node --check foo.js` 会按 CommonJS 解析，漏掉 ESM 场景下的
 * 解析错误（历史上漏过一次：注释块闭合位置写错，浏览器报
 * "SyntaxError: Unexpected token '*'"，而 node --check 竟没有报错）。
 * 这里统一复制成 .mjs 临时文件后再检查，保证按 ESM 规则解析。
 */
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = join(ROOT, 'public', 'js');
const tmp = mkdtempSync(join(tmpdir(), 'ca-syntax-'));
const files = readdirSync(DIR).filter((f) => f.endsWith('.js')).sort();
const failed = [];

for (const file of files) {
  const target = join(tmp, file.replace(/\.js$/, '.mjs'));
  writeFileSync(target, readFileSync(join(DIR, file), 'utf-8'));
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    console.log(`  PASS  ${file}`);
  } catch (err) {
    const detail = (err.stderr?.toString() || err.message).split('\n').slice(0, 5).join('\n');
    console.log(`  FAIL  ${file}\n${detail}`);
    failed.push(file);
  }
}

rmSync(tmp, { recursive: true, force: true });

if (failed.length) {
  console.log(`\n${files.length - failed.length}/${files.length} 个模块通过语法检查，失败：${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n${files.length}/${files.length} 个模块通过语法检查`);
