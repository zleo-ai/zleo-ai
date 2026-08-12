import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');

function count(fragment) {
  return readme.split(fragment).length - 1;
}

for (const marker of ['<!-- eosphor-system-module:start -->', '<!-- eosphor-system-module:end -->']) {
  if (count(marker) !== 1) throw new Error(`expected exactly one ${marker}`);
}

const required = [
  'https://nebula.zleo.ai',
  '伊 · 燧 · 藏 · 启',
  '**燧 · Sui** · CTO',
  '**藏 · Zang** · CIO · 信息治理',
  '**启 · Qi** · 学习导师',
  '**御 · Fulcrum** `统一体验建设中`',
  '**燮 · Forge** `建设中`',
  '**星汉 · Nebula** `已上线`',
  '**星穹 · Galaxy** `原型演化中`',
  '**重明 · Horus** `持续迭代`',
  '**通几 · Aletheia** `已上线`',
  '**巡天 · Radar** `独立建设`',
  '愿景不等同于当前已交付能力',
  'nebula-source: zleo-ai/nebula@30fde9c8ea8704811ca8f7dea7a8f4ea5dcd6332:src/data/system.json',
];

for (const fragment of required) {
  if (!readme.includes(fragment)) throw new Error(`missing current public fact: ${fragment}`);
}

const stale = [
  '数字员工团队',
  '**燧 · Sui** · 开发 · 工程',
  '**星穹 · Galaxy** `建设中`',
  '**重明 · Horus** `原型`',
  '**通几 · Aletheia** `孵化中`',
];

for (const fragment of stale) {
  if (readme.includes(fragment)) throw new Error(`stale public claim remains: ${fragment}`);
}

const privatePatterns = [
  /\/home\/maple/i,
  /C:\\Users\\Maple/i,
  /beacon\.zleo\.ai/i,
  /\.local\/share\/vyane/i,
];

for (const pattern of privatePatterns) {
  if (pattern.test(readme)) throw new Error(`private implementation detail found: ${pattern}`);
}

const references = new Set();
for (const match of readme.matchAll(/(?:src|srcset)="([^"]+)"/g)) references.add(match[1]);
for (const match of readme.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) references.add(match[1]);

for (const reference of references) {
  if (/^(?:https?:|data:|#)/.test(reference)) continue;
  const path = resolve(repoRoot, reference.split(/[?#]/, 1)[0]);
  if (!existsSync(path)) throw new Error(`missing local README asset: ${reference}`);
}

console.log(`profile README verified (${references.size} image references checked)`);
