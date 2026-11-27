import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  parseGraphqlCalendar,
  parsePublicContributionsHtml,
  renderActivityGraphSvg,
  selectRecentDays,
} from './generate-activity-graph.mjs';

describe('parseGraphqlCalendar', () => {
  test('flattens and sorts multi-week contribution days', () => {
    const payload = {
      data: {
        user: {
          contributionsCollection: {
            contributionCalendar: {
              weeks: [
                {
                  contributionDays: [
                    { date: '2026-10-03', contributionCount: 4 },
                    { date: '2026-10-01', contributionCount: 0 },
                  ],
                },
                {
                  contributionDays: [
                    { date: '2026-10-02', contributionCount: 1 },
                  ],
                },
              ],
            },
          },
        },
      },
    };

    assert.deepEqual(parseGraphqlCalendar(payload), [
      { date: '2026-10-01', count: 0 },
      { date: '2026-10-02', count: 1 },
      { date: '2026-10-03', count: 4 },
    ]);
  });

  test('rejects GraphQL error payloads and empty calendars', () => {
    assert.throws(
      () => parseGraphqlCalendar({ errors: [{ message: 'Bad credentials' }] }),
      /GraphQL returned errors/i,
    );
    assert.throws(
      () => parseGraphqlCalendar({ data: { user: { contributionsCollection: { contributionCalendar: { weeks: [] } } } } }),
      /zero valid contribution days/i,
    );
    assert.throws(() => parseGraphqlCalendar(null), /Invalid GraphQL/i);
  });
});

describe('parsePublicContributionsHtml', () => {
  test('parses 0, 1, multi-digit counts and unordered tooltips', () => {
    const html = `
      <tool-tip for="day-3">1,234 contributions on October 3rd.</tool-tip>
      <tool-tip for="day-1">No contributions on October 1st.</tool-tip>
      <table>
        <tr>
          <td data-date="2026-10-02" id="day-2" class="ContributionCalendar-day"></td>
          <td data-date="2026-10-03" id="day-3" class="ContributionCalendar-day"></td>
          <td data-date="2026-10-01" id="day-1" class="ContributionCalendar-day"></td>
          <td data-date="2026-10-04" id="day-4" class="ContributionCalendar-day"></td>
        </tr>
      </table>
      <tool-tip for="day-2">1 contribution on October 2nd.</tool-tip>
      <tool-tip for="day-4">12 contributions on October 4th.</tool-tip>
    `;

    assert.deepEqual(parsePublicContributionsHtml(html), [
      { date: '2026-10-01', count: 0 },
      { date: '2026-10-02', count: 1 },
      { date: '2026-10-03', count: 1234 },
      { date: '2026-10-04', count: 12 },
    ]);
  });

  test('handles missing tooltips via aria-label/inner-text fallback and omits unresolved cells', () => {
    const html = `
      <table>
        <tr>
          <td data-date="2026-10-01" id="missing-tip"></td>
          <td data-date="2026-10-02" id="aria-day" aria-label="7 contributions on October 2nd"></td>
          <td data-date="2026-10-03"><span>3 contributions on October 3rd</span></td>
        </tr>
      </table>
    `;

    assert.deepEqual(parsePublicContributionsHtml(html), [
      { date: '2026-10-02', count: 7 },
      { date: '2026-10-03', count: 3 },
    ]);
  });

  test('rejects empty, malformed, or tooltip-less HTML without valid counts', () => {
    assert.throws(() => parsePublicContributionsHtml(''), /empty/i);
    assert.throws(() => parsePublicContributionsHtml('<div>not a calendar</div>'), /Failed to parse/i);
    assert.throws(
      () => parsePublicContributionsHtml('<td data-date="2026-10-01" id="orphan"></td>'),
      /Failed to parse/i,
    );
  });
});

describe('selectRecentDays', () => {
  test('selects the most recent N days up to endDate in ascending order', () => {
    const entries = [
      { date: '2026-10-05', count: 5 },
      { date: '2026-10-01', count: 1 },
      { date: '2026-10-03', count: 3 },
      { date: '2026-10-04', count: 4 },
      { date: '2026-10-02', count: 2 },
    ];

    assert.deepEqual(selectRecentDays(entries, 3, '2026-10-04'), [
      { date: '2026-10-02', count: 2 },
      { date: '2026-10-03', count: 3 },
      { date: '2026-10-04', count: 4 },
    ]);
  });

  test('rejects empty selection', () => {
    assert.throws(() => selectRecentDays([], 31), /No contribution days/i);
    assert.throws(
      () => selectRecentDays([{ date: '2026-12-01', count: 1 }], 31, '2026-11-01'),
      /No contribution days/i,
    );
  });
});

describe('renderActivityGraphSvg', () => {
  test('handles all-zero contributions safely with yMax=5 and no NaN/Infinity', () => {
    const days = [
      { date: '2026-10-01', count: 0 },
      { date: '2026-10-02', count: 0 },
      { date: '2026-10-03', count: 0 },
    ];

    const svg = renderActivityGraphSvg({ user: 'zleo-ai', days });
    assert.doesNotMatch(svg, /\b(?:NaN|Infinity)\b/);
    assert.match(svg, /width="1200"/);
    assert.match(svg, /height="420"/);
    assert.match(svg, /viewBox="0 0 1200 420"/);
    assert.match(svg, /#0A0E1A/);
    assert.match(svg, /#C9A84C/);
    assert.match(svg, /#E2E8F8/);
    assert.match(svg, />5<\/text>/);
    assert.match(svg, /<title>2026-10-01: 0 contributions<\/title>/);
  });

  test('scales a single peak cleanly and handles single-day series', () => {
    const peakDays = [
      { date: '2026-10-01', count: 0 },
      { date: '2026-10-02', count: 18 },
      { date: '2026-10-03', count: 0 },
    ];
    const peakSvg = renderActivityGraphSvg({ user: 'zleo-ai', days: peakDays });
    assert.doesNotMatch(peakSvg, /\b(?:NaN|Infinity)\b/);
    assert.match(peakSvg, />20<\/text>/);
    assert.match(peakSvg, /<title>2026-10-02: 18 contributions<\/title>/);
    assert.match(peakSvg, /stop-opacity="0\.28"/);
    assert.match(peakSvg, /stop-opacity="0\.02"/);

    const singleDaySvg = renderActivityGraphSvg({
      user: 'zleo-ai',
      days: [{ date: '2026-10-02', count: 1 }],
    });
    assert.doesNotMatch(singleDaySvg, /\b(?:NaN|Infinity)\b/);
    assert.match(singleDaySvg, /<title>2026-10-02: 1 contribution<\/title>/);
  });

  test('escapes XML special characters in user login', () => {
    const svg = renderActivityGraphSvg({
      user: 'a&b<c>"d\'',
      days: [
        { date: '2026-10-01', count: 1 },
        { date: '2026-10-02', count: 2 },
      ],
    });
    assert.match(svg, /a&amp;b&lt;c&gt;&quot;d&apos;&apos;s Contribution Graph|a&amp;b&lt;c&gt;&quot;d&apos;'s Contribution Graph/);
    assert.ok(!svg.includes('<c>'));
  });
});
