#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FONT_FAMILY = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const USER_AGENT = 'zleo-ai-profile-generator';

const GRAPHQL_QUERY = `
query ($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}
`;

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeHtmlText(raw) {
  return String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function getAttr(attrSource, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`, 'i');
  const match = attrSource.match(re);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function parseContributionCountText(rawText) {
  if (typeof rawText !== 'string') return null;
  const text = decodeHtmlText(rawText);
  if (!text) return null;
  if (/\bno\s+contributions?\b/i.test(text)) return 0;
  const match = text.match(/\b(\d[\d,]*)\s+contributions?\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeEntries(rawEntries) {
  const byDate = new Map();
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const { date, count } = entry;
    if (typeof date !== 'string' || !DATE_RE.test(date)) continue;
    if (typeof count !== 'number' || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) continue;
    byDate.set(date, { date, count });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseGraphqlCalendar(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid GraphQL response payload');
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const messages = payload.errors
      .map((err) => (err && typeof err.message === 'string' ? err.message : 'unknown error'))
      .join('; ');
    throw new Error(`GitHub GraphQL returned errors: ${messages}`);
  }
  const weeks = payload?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) {
    throw new Error('GitHub GraphQL response is missing contributionCalendar.weeks');
  }

  const raw = [];
  for (const week of weeks) {
    if (!week || !Array.isArray(week.contributionDays)) continue;
    for (const day of week.contributionDays) {
      if (!day || typeof day !== 'object') continue;
      raw.push({
        date: day.date,
        count: day.contributionCount,
      });
    }
  }

  const entries = normalizeEntries(raw);
  if (entries.length === 0) {
    throw new Error('GitHub GraphQL response contained zero valid contribution days');
  }
  return entries;
}

export function parsePublicContributionsHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('Public contributions HTML is empty');
  }

  const tooltips = new Map();
  const tooltipRe = /<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/gi;
  for (const match of html.matchAll(tooltipRe)) {
    const targetId = getAttr(match[1], 'for');
    if (targetId) {
      tooltips.set(targetId, match[2]);
    }
  }

  const raw = [];
  const tdRe = /<td\b([^>]*?)(?:\/>|>([\s\S]*?)<\/td>)/gi;
  for (const match of html.matchAll(tdRe)) {
    const attrs = match[1];
    const inner = match[2] ?? '';
    const date = getAttr(attrs, 'data-date');
    if (!date || !DATE_RE.test(date)) continue;

    const id = getAttr(attrs, 'id');
    const ariaLabel = getAttr(attrs, 'aria-label');

    let count = null;
    if (id && tooltips.has(id)) {
      count = parseContributionCountText(tooltips.get(id));
    }
    if (count === null && ariaLabel) {
      count = parseContributionCountText(ariaLabel);
    }
    if (count === null && inner) {
      count = parseContributionCountText(inner);
    }
    if (count !== null) {
      raw.push({ date, count });
    }
  }

  const entries = normalizeEntries(raw);
  if (entries.length === 0) {
    throw new Error('Failed to parse any valid contribution days from public HTML');
  }
  return entries;
}

export function selectRecentDays(entries, days = 31, endDate = undefined) {
  if (!Array.isArray(entries)) {
    throw new Error('entries must be an array');
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('days must be a positive integer');
  }

  let cutoff = null;
  if (endDate instanceof Date) {
    if (Number.isNaN(endDate.getTime())) {
      throw new Error('endDate is invalid');
    }
    cutoff = endDate.toISOString().slice(0, 10);
  } else if (typeof endDate === 'string') {
    if (!DATE_RE.test(endDate)) {
      throw new Error(`endDate must be YYYY-MM-DD, received: ${endDate}`);
    }
    cutoff = endDate;
  } else if (endDate !== undefined && endDate !== null) {
    throw new Error('endDate must be a Date or YYYY-MM-DD string');
  }

  let normalized = normalizeEntries(entries);
  if (cutoff) {
    normalized = normalized.filter((entry) => entry.date <= cutoff);
  }
  const selected = normalized.slice(-days);
  if (selected.length === 0) {
    throw new Error('No contribution days available for the selected range');
  }
  return selected;
}

function fmt(num) {
  if (!Number.isFinite(num)) {
    throw new Error(`Non-finite SVG coordinate encountered: ${num}`);
  }
  const rounded = Math.round(num * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function computeYAxis(maxCount) {
  if (maxCount <= 0) {
    return { yMax: 5, ticks: [0, 1, 2, 3, 4, 5] };
  }
  if (maxCount <= 5) {
    const ticks = [];
    for (let v = 0; v <= maxCount; v += 1) ticks.push(v);
    return { yMax: maxCount, ticks };
  }

  const rawStep = maxCount / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  let niceUnit = 10;
  if (normalized <= 1) niceUnit = 1;
  else if (normalized <= 2) niceUnit = 2;
  else if (normalized <= 5) niceUnit = 5;

  const step = Math.max(1, Math.round(niceUnit * magnitude));
  const yMax = Math.ceil(maxCount / step) * step;
  const ticks = [];
  for (let v = 0; v <= yMax; v += step) {
    ticks.push(v);
  }
  return { yMax, ticks };
}

function buildMonotoneCubicPath(points) {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  }

  const n = points.length;
  const dx = new Array(n - 1);
  const dy = new Array(n - 1);
  const slopes = new Array(n - 1);

  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    dy[i] = points[i + 1].y - points[i].y;
    slopes[i] = dx[i] === 0 ? 0 : dy[i] / dx[i];
  }

  const tangents = new Array(n).fill(0);
  tangents[0] = slopes[0];
  tangents[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      tangents[i] = 0;
    } else {
      tangents[i] = (slopes[i - 1] + slopes[i]) / 2;
    }
  }

  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / slopes[i];
      const b = tangents[i + 1] / slopes[i];
      const magSq = a * a + b * b;
      if (magSq > 9) {
        const tau = 3 / Math.sqrt(magSq);
        tangents[i] = tau * a * slopes[i];
        tangents[i + 1] = tau * b * slopes[i];
      }
    }
  }

  const parts = [`M ${fmt(points[0].x)} ${fmt(points[0].y)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const h = dx[i];
    const cp1x = p0.x + h / 3;
    const cp1y = p0.y + (tangents[i] * h) / 3;
    const cp2x = p1.x - h / 3;
    const cp2y = p1.y - (tangents[i + 1] * h) / 3;
    parts.push(`C ${fmt(cp1x)} ${fmt(cp1y)}, ${fmt(cp2x)} ${fmt(cp2y)}, ${fmt(p1.x)} ${fmt(p1.y)}`);
  }
  return parts.join(' ');
}

export function renderActivityGraphSvg({ user, days }) {
  if (typeof user !== 'string' || !user.trim()) {
    throw new Error('user must be a non-empty string');
  }
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error('days must be a non-empty array');
  }

  const normalizedDays = days.map((entry) => {
    if (!entry || typeof entry.date !== 'string' || !DATE_RE.test(entry.date)) {
      throw new Error(`Invalid day date: ${entry?.date}`);
    }
    if (typeof entry.count !== 'number' || !Number.isFinite(entry.count) || entry.count < 0) {
      throw new Error(`Invalid day count for ${entry.date}: ${entry.count}`);
    }
    return { date: entry.date, count: Math.round(entry.count) };
  });

  const width = 1200;
  const height = 420;
  const padLeft = 88;
  const padRight = 40;
  const padTop = 68;
  const padBottom = 76;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const baselineY = padTop + plotHeight;

  const maxCount = Math.max(...normalizedDays.map((d) => d.count));
  const { yMax, ticks } = computeYAxis(maxCount);

  const points = normalizedDays.map((day, index) => {
    const x = normalizedDays.length === 1
      ? padLeft + plotWidth / 2
      : padLeft + (index / (normalizedDays.length - 1)) * plotWidth;
    const y = baselineY - (day.count / yMax) * plotHeight;
    return { ...day, x, y };
  });

  const linePath = buildMonotoneCubicPath(points);
  const areaPath = points.length > 1
    ? `${linePath} L ${fmt(points[points.length - 1].x)} ${fmt(baselineY)} L ${fmt(points[0].x)} ${fmt(baselineY)} Z`
    : '';

  const horizontalGrid = [];
  const yTickLabels = [];
  for (const tick of ticks) {
    const y = baselineY - (tick / yMax) * plotHeight;
    horizontalGrid.push(
      `    <line x1="${fmt(padLeft)}" y1="${fmt(y)}" x2="${fmt(padLeft + plotWidth)}" y2="${fmt(y)}" stroke="#1E293B" stroke-width="1" stroke-dasharray="4 4" />`,
    );
    yTickLabels.push(
      `    <text x="${fmt(padLeft - 14)}" y="${fmt(y + 4)}" text-anchor="end" fill="#94A3B8" font-family="${FONT_FAMILY}" font-size="12">${tick}</text>`,
    );
  }

  const labelStep = Math.max(1, Math.ceil(points.length / 15));
  const verticalGrid = [];
  const xTickLabels = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    verticalGrid.push(
      `    <line x1="${fmt(point.x)}" y1="${fmt(padTop)}" x2="${fmt(point.x)}" y2="${fmt(baselineY)}" stroke="#1E293B" stroke-width="1" stroke-dasharray="4 4" />`,
    );
    const isLast = i === points.length - 1;
    const isSelected = i % labelStep === 0 || (isLast && (points.length - 1) % labelStep >= Math.ceil(labelStep / 2));
    if (isSelected) {
      const label = point.date.slice(5);
      xTickLabels.push(
        `    <text x="${fmt(point.x)}" y="${fmt(baselineY + 24)}" text-anchor="middle" fill="#94A3B8" font-family="${FONT_FAMILY}" font-size="12">${escapeXml(label)}</text>`,
      );
    }
  }

  const circles = points.map((point) => {
    const unit = point.count === 1 ? 'contribution' : 'contributions';
    return `    <circle cx="${fmt(point.x)}" cy="${fmt(point.y)}" r="4.5" fill="#E2E8F8" stroke="#C9A84C" stroke-width="1.5"><title>${escapeXml(point.date)}: ${point.count} ${unit}</title></circle>`;
  });

  const escapedUser = escapeXml(user);
  const titleText = `${escapedUser}'s Contribution Graph`;

  const svg = [
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${titleText}">`,
    '  <defs>',
    '    <linearGradient id="activityAreaGradient" x1="0" y1="0" x2="0" y2="1">',
    '      <stop offset="0%" stop-color="#C9A84C" stop-opacity="0.28" />',
    '      <stop offset="100%" stop-color="#C9A84C" stop-opacity="0.02" />',
    '    </linearGradient>',
    '  </defs>',
    `  <rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="#0A0E1A" />`,
    `  <text x="${fmt(width / 2)}" y="40" text-anchor="middle" fill="#C9A84C" font-family="${FONT_FAMILY}" font-size="20" font-weight="600">${titleText}</text>`,
    '  <g aria-hidden="true">',
    ...horizontalGrid,
    ...verticalGrid,
    '  </g>',
    '  <g>',
    ...yTickLabels,
    `    <text x="26" y="${fmt(padTop + plotHeight / 2)}" text-anchor="middle" fill="#C9A84C" font-family="${FONT_FAMILY}" font-size="13" font-weight="600" transform="rotate(-90 26 ${fmt(padTop + plotHeight / 2)})">Contributions</text>`,
    '  </g>',
    '  <g>',
    ...xTickLabels,
    `    <text x="${fmt(padLeft + plotWidth / 2)}" y="${fmt(height - 18)}" text-anchor="middle" fill="#C9A84C" font-family="${FONT_FAMILY}" font-size="13" font-weight="600">Days</text>`,
    '  </g>',
    ...(areaPath ? [`  <path d="${areaPath}" fill="url(#activityAreaGradient)" />`] : []),
    `  <path d="${linePath}" stroke="#C9A84C" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" />`,
    '  <g>',
    ...circles,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');

  if (/\b(?:NaN|Infinity)\b/.test(svg)) {
    throw new Error('Generated SVG contained non-finite numeric output');
  }
  return svg;
}

async function fetchViaGraphql({ user, days, token, now }) {
  const toDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days + 1), 0, 0, 0));

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        login: user,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status}`);
  }
  const payload = await response.json();
  return parseGraphqlCalendar(payload);
}

async function fetchViaPublicHtml({ user }) {
  const url = `https://github.com/users/${encodeURIComponent(user)}/contributions`;
  const response = await fetch(url, {
    headers: {
      Accept: 'text/html',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Public contributions HTTP ${response.status}`);
  }
  const html = await response.text();
  return parsePublicContributionsHtml(html);
}

async function fetchContributionDays({ user, days, token, now = new Date() }) {
  const todayUtc = now.toISOString().slice(0, 10);
  if (token) {
    try {
      const graphqlEntries = await fetchViaGraphql({ user, days, token, now });
      return selectRecentDays(graphqlEntries, days, todayUtc);
    } catch (error) {
      console.warn(`GraphQL fetch failed (${error.message}); falling back to public contributions HTML`);
    }
  }

  const htmlEntries = await fetchViaPublicHtml({ user });
  return selectRecentDays(htmlEntries, days, todayUtc);
}

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: 'string', default: 'zleo-ai' },
      output: { type: 'string', default: 'dist/github-activity-graph.svg' },
      days: { type: 'string', default: '31' },
    },
    strict: true,
  });

  const user = values.user.trim();
  if (!user) {
    throw new Error('--user must be a non-empty GitHub login');
  }
  const days = Number.parseInt(values.days, 10);
  if (!/^\d+$/.test(values.days) || !Number.isInteger(days) || days < 1) {
    throw new Error(`--days must be a positive integer, received: ${values.days}`);
  }
  const outputPath = resolve(values.output);
  const token = (process.env.GITHUB_TOKEN ?? '').trim();

  const recentDays = await fetchContributionDays({ user, days, token });
  const svg = renderActivityGraphSvg({ user, days: recentDays });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, svg, 'utf8');
  console.log(`Generated activity graph for ${user} (${recentDays.length} days) -> ${outputPath}`);
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`generate-activity-graph failed: ${error.message}`);
    process.exitCode = 1;
  });
}
