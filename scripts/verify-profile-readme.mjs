import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
const snapshotRaw = readFileSync(resolve(repoRoot, 'data/nebula-system.snapshot.json'), 'utf8');
const snapshot = JSON.parse(snapshotRaw);
const publicBase = 'https://nebula.zleo.ai';
const source = {
  repository: 'zleo-ai/nebula',
  commit: '30fde9c8ea8704811ca8f7dea7a8f4ea5dcd6332',
  path: 'src/data/system.json',
  sha256: '1b6e0d90f27bad52093390b42af8084e81aa4fff329a3d2130041636e40ca0fc',
};
const groups = ['system', 'engine', 'product', 'vision'];
const startMarker = '<!-- eosphor-system-module:start -->';
const endMarker = '<!-- eosphor-system-module:end -->';

function count(text, fragment) {
  return text.split(fragment).length - 1;
}

function publicHref(link) {
  if (!link) return null;
  if (link === publicBase) return `${publicBase}/projects/nebula`;
  if (/^https?:\/\//.test(link)) return link;
  if (link.startsWith('/')) return `${publicBase}${link}`;
  return null;
}

function renderSystemModule(system) {
  const lines = [
    startMarker,
    '',
    '## `0x03` 项目星座 · Eosphor Constellation',
    '',
    '> 这一段由 `nebula/src/data/system.json` 生成。GitHub profile 请保留原有 hero / 视觉 / 教育 / 技术栈 / 统计等丰富结构，只替换这个模块。',
    '',
    '### 数字团队 · Agents',
    '',
  ];

  for (const agent of system.agents) {
    lines.push(`- **${agent.zh} · ${agent.en}** · ${agent.role} — ${agent.desc}`);
  }

  lines.push('', '### 项目星座 · Projects', '');
  for (const group of groups) {
    const projects = system.projects.filter((project) => project.group === group);
    if (!projects.length) continue;
    lines.push(`#### ${system.groupLabels[group]}`, '');
    for (const project of projects) {
      const href = publicHref(project.link);
      const suffix = href ? ` · [公开项目页](${href})` : '';
      lines.push(`- **${project.zh} · ${project.en}** \`${project.status}\` — ${project.desc}${suffix}`);
    }
    lines.push('');
  }

  lines.push(endMarker);
  return lines.join('\n');
}

function extractSystemModule(text) {
  if (count(text, startMarker) !== 1 || count(text, endMarker) !== 1) {
    throw new Error('expected exactly one ordered system module marker pair');
  }
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start >= end) throw new Error('system module markers are out of order');
  return text.slice(start, end + endMarker.length);
}

function extractUrls(text) {
  const urls = new Set(text.match(/https?:\/\/[^\s<>"')]+/g) ?? []);
  return [...urls].map((url) => url.replace(/&amp;/g, '&'));
}

function verify(candidate) {
  const snapshotSha256 = createHash('sha256').update(snapshotRaw).digest('hex');
  if (snapshotSha256 !== source.sha256) throw new Error('pinned Nebula snapshot digest mismatch');

  const expectedSource = `<!-- nebula-source: ${source.repository}@${source.commit}:${source.path} -->`;
  if (count(candidate, expectedSource) !== 1) throw new Error('missing or duplicate pinned Nebula source marker');

  const actualModule = extractSystemModule(candidate);
  const expectedModule = renderSystemModule(snapshot);
  if (actualModule !== expectedModule) throw new Error('system module differs from pinned Nebula public snapshot');

  if (!candidate.includes('愿景不等同于当前已交付能力')) {
    throw new Error('missing explicit vision-versus-delivery boundary');
  }

  const privatePatterns = [
    /\/home\/maple/i,
    /C:\\Users\\Maple/i,
    /beacon\.zleo\.ai/i,
    /\.local\/share\/vyane/i,
    /localhost(?::\d+)?/i,
  ];
  for (const pattern of privatePatterns) {
    if (pattern.test(candidate)) throw new Error(`private implementation detail found: ${pattern}`);
  }

  const allowedNebulaUrls = new Set([
    publicBase,
    ...snapshot.projects.map((project) => publicHref(project.link)).filter(Boolean),
  ]);
  for (const url of extractUrls(candidate)) {
    const parsed = new URL(url);
    if (parsed.hostname !== 'nebula.zleo.ai') continue;
    const normalized = `${parsed.origin}${parsed.pathname.replace(/\/$/, '') || ''}`;
    if (parsed.search || parsed.hash || !allowedNebulaUrls.has(normalized)) {
      throw new Error(`unapproved Nebula public URL: ${url}`);
    }
  }

  const references = new Set();
  for (const match of candidate.matchAll(/(?:src|srcset)="([^"]+)"/g)) references.add(match[1]);
  for (const match of candidate.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) references.add(match[1]);
  for (const reference of references) {
    if (/^(?:https?:|data:|#)/.test(reference)) continue;
    const path = resolve(repoRoot, reference.split(/[?#]/, 1)[0]);
    if (!existsSync(path)) throw new Error(`missing local README asset: ${reference}`);
  }

  return references.size;
}

const checkedReferences = verify(readme);

const wrongStatus = readme.replace('**爟 · Beacon** `运行中`', '**爟 · Beacon** `尚未公开`');
if (wrongStatus === readme) throw new Error('negative test setup failed: Beacon status not found');
try {
  verify(wrongStatus);
  throw new Error('negative test failed: wrong Beacon status was accepted');
} catch (error) {
  if (!String(error.message).includes('system module differs')) throw error;
}

const privateEntry = `${readme}\n[admin](${publicBase}/admin/login?next=/internal)\n`;
try {
  verify(privateEntry);
  throw new Error('negative test failed: authentication entry was accepted');
} catch (error) {
  if (!String(error.message).includes('unapproved Nebula public URL')) throw error;
}

console.log(`profile README verified (${checkedReferences} image references checked; 2 negative cases rejected)`);
