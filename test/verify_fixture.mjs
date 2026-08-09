/**
 * verify_fixture.mjs
 *
 * 用真实抓取的页面快照（test/fixtures/updates.html）验证 parseUpdates() 解析结果。
 * 运行：npm run verify:fixture  （或 node test/verify_fixture.mjs）
 */

import { readFileSync } from 'node:fs';
import { parseUpdates } from '../scripts/parse-updates.mjs';

const html = readFileSync(new URL('./fixtures/updates.html', import.meta.url), 'utf8');

const entries = parseUpdates(html);

// ---- 断言 ------------------------------------------------------------------
const failures = [];

const check = (name, cond) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failures.push(name);
    console.error(`[FAIL] ${name}`);
  }
};

check(`条目数量 === 18（实际 ${entries.length}）`, entries.length === 18);
check(`第一条日期 === '2026-07-31'（实际 ${entries[0]?.date}）`, entries[0]?.date === '2026-07-31');
check(
  `第一条标题以 'DeepSeek-V4-Flash' 开头（实际 "${entries[0]?.title}"）`,
  entries[0]?.title.startsWith('DeepSeek-V4-Flash')
);
check('所有条目均有非空 date', entries.every((e) => typeof e.date === 'string' && e.date.length > 0));
check('所有条目均有非空 title', entries.every((e) => typeof e.title === 'string' && e.title.length > 0));
check('所有条目均有非空 body', entries.every((e) => typeof e.body === 'string' && e.body.length > 0));

// ---- 输出摘要 ---------------------------------------------------------------
console.log('\n解析到的条目（前 4 条 + 后 2 条）：');
for (const e of entries.slice(0, 4)) console.log(`  ${e.date} | ${e.title} | bodyLen=${e.body.length}`);
console.log('  ...');
for (const e of entries.slice(-2)) console.log(`  ${e.date} | ${e.title} | bodyLen=${e.body.length}`);
console.log(`\n全部日期：${entries.map((e) => e.date).join(', ')}`);

if (failures.length > 0) {
  console.error(`\n✗ 校验未通过，共 ${failures.length} 项失败`);
  process.exit(1);
}
console.log('\n✓ 全部校验通过');
