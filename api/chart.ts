import type { VercelRequest, VercelResponse } from '@vercel/node';

type GraphQLResponse = {
  data?: {
    user?: {
      repositories: {
        nodes: Array<{
          name: string;
          isFork: boolean;
          createdAt: string;
          languages: {
            edges: Array<{
              size: number;
              node: {
                name: string;
              };
            }>;
          };
        }>;
      };
    };
    rateLimit?: {
      cost: number;
      remaining: number;
      resetAt: string;
    };
  };
  errors?: Array<{ message: string }>;
};

type Point = {
  x: number;
  y: number;
  repoIndex: number;
  value: number;
};

type Series = {
  name: string;
  color: string;
  points: Point[];
  finalValue: number;
  path: string;
  pathLength: number;
};

const COLORS = [
  '#58a6ff',
  '#3fb950',
  '#f2cc60',
  '#ff7b72',
  '#bc8cff',
  '#ffa657',
  '#79c0ff',
  '#a5d6ff',
  '#7ee787',
  '#d2a8ff',
  '#e3b341',
  '#ffab70'
];

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatBytes(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatDateLabel(value: number, rangeMs: number) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}/${day}`;
}

function startOfDayUtc(value: number) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function getPathLength(points: Point[]) {
  let total = 0;

  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }

  return Math.max(1, total);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  try {
    const username = String(req.query.username || 'joaodemutti');
    const includeForks = String(req.query.forks || 'false') === 'true';
    const top = Math.max(1, Math.min(12, Number(req.query.top || 8)));
    const width = Math.max(700, Number(req.query.width || 1100));
    const height = Math.max(420, Number(req.query.height || 620));
    const mode = String(req.query.mode || 'bytes').toLowerCase();
    const showPercent = mode === 'percent';

    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      res.status(500).json({
        error: 'Missing GITHUB_TOKEN environment variable'
      });
      return;
    }

    const query = `
      query UserLanguages($login: String!) {
        user(login: $login) {
          repositories(
            first: 100
            ownerAffiliations: OWNER
            orderBy: { field: CREATED_AT, direction: ASC }
            isFork: null
            privacy: PUBLIC
          ) {
            nodes {
              name
              isFork
              createdAt
              languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
                edges {
                  size
                  node {
                    name
                  }
                }
              }
            }
          }
        }
        rateLimit {
          cost
          remaining
          resetAt
        }
      }
    `;

    const ghRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'github-language-chart'
      },
      body: JSON.stringify({
        query,
        variables: {
          login: username
        }
      })
    });

    const payload = (await ghRes.json()) as GraphQLResponse;

    if (!ghRes.ok || payload.errors) {
      res.status(ghRes.status || 500).json({
        error: 'GraphQL request failed',
        details: payload.errors?.map((e) => e.message).join('; ') || payload
      });
      return;
    }

    const repos = payload.data?.user?.repositories.nodes ?? [];
    const filteredRepos = includeForks ? repos : repos.filter((r) => !r.isFork);

    if (filteredRepos.length === 0) {
      res.status(404).send('No repositories found');
      return;
    }

    const allLanguages = new Set<string>();

    for (const repo of filteredRepos) {
      for (const edge of repo.languages.edges) {
        allLanguages.add(edge.node.name);
      }
    }

    if (allLanguages.size === 0) {
      res.status(404).send('No language data found');
      return;
    }

    const cumulative = new Map<string, number>();
    const rawData: Array<{
      RepoIndex: number;
      RepoName: string;
      RepoDate: number;
      Language: string;
      Bytes: number;
    }> = [];

    const repoDates = filteredRepos.map((repo) =>
      new Date(repo.createdAt).getTime()
    );
    const minDateRaw = Math.min(...repoDates);
    const maxDateRaw = Math.max(...repoDates);
    const minDate = startOfDayUtc(minDateRaw);
    const maxDate = startOfDayUtc(maxDateRaw);
    const dateRange = Math.max(1, maxDate - minDate);

    filteredRepos.forEach((repo, index) => {
      const repoDate = new Date(repo.createdAt).getTime();
      const repoLangMap = new Map<string, number>();

      for (const edge of repo.languages.edges) {
        repoLangMap.set(edge.node.name, edge.size);
      }

      for (const language of allLanguages) {
        const current = cumulative.get(language) || 0;
        const added = repoLangMap.get(language) || 0;
        const next = current + added;

        cumulative.set(language, next);

        rawData.push({
          RepoIndex: index + 1,
          RepoName: repo.name,
          RepoDate: repoDate,
          Language: language,
          Bytes: next
        });
      }
    });

    const finalTotals = new Map<string, number>();
    for (const row of rawData) {
      finalTotals.set(row.Language, row.Bytes);
    }

    let grandTotal = 0;
    for (const value of finalTotals.values()) {
      grandTotal += value;
    }
    grandTotal = Math.max(1, grandTotal);

    const selectedLanguages = [...allLanguages]
      .filter((language) => (finalTotals.get(language) || 0) > 0)
      .sort((a, b) => (finalTotals.get(b) || 0) - (finalTotals.get(a) || 0))
      .slice(0, top);

    const padding = {
      top: 72,
      right: 220,
      bottom: 56,
      left: showPercent ? 118 : 72
    };

    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxX = Math.max(1, filteredRepos.length);
    let maxY = Math.max(
      1,
      ...selectedLanguages.map((lang) => finalTotals.get(lang) || 0)
    );
    if (showPercent) {
      const maxPercent = (maxY / grandTotal) * 100;
      const roundedPercent = Math.max(5, Math.ceil(maxPercent / 5) * 5);
      maxY = (grandTotal * roundedPercent) / 100;
    }

    const scaleX = (repoDate: number) => {
      if (minDate === maxDate) return padding.left;
      return padding.left + ((repoDate - minDate) / dateRange) * chartWidth;
    };

    const scaleY = (value: number) => {
      return padding.top + chartHeight - (value / maxY) * chartHeight;
    };

    const series: Series[] = selectedLanguages.map((lang, index) => {
      const rows = rawData.filter((r) => r.Language === lang);

      const points = rows.map((r) => ({
        x: scaleX(r.RepoDate),
        y: scaleY(r.Bytes),
        repoIndex: r.RepoIndex,
        value: r.Bytes
      }));

      const path = points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
        .join(' ');

      return {
        name: lang,
        color: COLORS[index % COLORS.length],
        points,
        finalValue: finalTotals.get(lang) || 0,
        path,
        pathLength: getPathLength(points)
      };
    });

    const labelPaddingTop = padding.top + 6;
    const labelPaddingBottom = padding.top + chartHeight - 6;
    const minLabelGap = 16;
    const labelX = padding.left + chartWidth + 16;

    const labelLayout = series
      .map((s, index) => {
        const finalPoint = s.points[s.points.length - 1];
        return {
          index,
          desiredY: finalPoint.y + 4
        };
      })
      .sort((a, b) => a.desiredY - b.desiredY);

    let cursorY = labelPaddingTop;
    const labelPositions: number[] = new Array(series.length);
    for (const item of labelLayout) {
      const clamped = Math.max(labelPaddingTop, Math.min(labelPaddingBottom, item.desiredY));
      const y = Math.max(clamped, cursorY);
      labelPositions[item.index] = y;
      cursorY = y + minLabelGap;
    }

    for (let i = labelLayout.length - 1; i >= 0; i--) {
      const index = labelLayout[i].index;
      const nextIndex = labelLayout[i + 1]?.index;
      const maxY = Math.min(labelPaddingBottom, labelPositions[index] ?? labelPaddingBottom);
      if (nextIndex !== undefined) {
        labelPositions[index] = Math.min(
          maxY,
          (labelPositions[nextIndex] ?? maxY) - minLabelGap
        );
      } else {
        labelPositions[index] = Math.min(maxY, labelPaddingBottom);
      }
    }

    const yTickCount = 5;
    const yTicks = Array.from({ length: yTickCount + 1 }, (_, i) => {
      const value = (maxY / yTickCount) * i;
      return {
        value,
        y: scaleY(value)
      };
    });

    const dayMs = 1000 * 60 * 60 * 24;
    const xTicks: number[] = [];
    for (let t = minDate; t <= maxDate; t += dayMs) {
      xTicks.push(t);
    }

    const totalDur = 8;

    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(username)} GitHub languages line race">
  <defs>
    <style>
      text {
        font-family: Arial, Helvetica, sans-serif;
      }
      .bg {
        fill: #ffffff;
      }
      .title {
        font-size: 24px;
        font-weight: 700;
        fill: #24292f;
      }
      .subtitle {
        font-size: 12px;
        fill: #57606a;
      }
      .axis-line {
        stroke: #d0d7de;
        stroke-width: 1;
      }
      .grid-line {
        stroke: #d8dee4;
        stroke-width: 1;
        stroke-dasharray: 3 4;
      }
      .axis-label {
        font-size: 11px;
        fill: #57606a;
      }
      .line {
        fill: none;
        stroke-width: 3;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .end-label {
        font-size: 12px;
        font-weight: 600;
      }
    </style>
  </defs>

  <rect class="bg" x="0" y="0" width="${width}" height="${height}" rx="0" />

  <text x="${padding.left}" y="34" class="title">${escapeXml(username)} · GitHub Languages</text>
  <text x="${padding.left}" y="54" class="subtitle">Cumulative bytes by repository creation order</text>

  ${yTicks.map((tick) => `
    <line x1="${padding.left}" y1="${tick.y}" x2="${padding.left + chartWidth}" y2="${tick.y}" class="grid-line" />
    <text x="${padding.left - 10}" y="${tick.y + 4}" text-anchor="end" class="axis-label">${formatBytes(tick.value)}${showPercent ? ` (${formatPercent((tick.value / grandTotal) * 100)})` : ''}</text>
  `).join('')}

  <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" class="axis-line" />
  <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}" class="axis-line" />

  ${xTicks.map((tick) => `
    <text x="${scaleX(tick)}" y="${padding.top + chartHeight + 22}" text-anchor="middle" class="axis-label">${formatDateLabel(tick, dateRange)}</text>
  `).join('')}

  <text x="${padding.left + chartWidth / 2}" y="${height - 12}" text-anchor="middle" class="axis-label">Repository date</text>
  <text x="20" y="${padding.top + chartHeight / 2}" transform="rotate(-90 20 ${padding.top + chartHeight / 2})" text-anchor="middle" class="axis-label">Cumulative bytes${showPercent ? ' (%)' : ''}</text>

  ${series.map((s, index) => {
    const finalPoint = s.points[s.points.length - 1];
    const beginSeconds = index * 0.18;
    const durSeconds = Math.max(3.2, totalDur - index * 0.18);
    const endSeconds = beginSeconds + durSeconds;
    const begin = `${beginSeconds.toFixed(2)}s`;
    const dur = `${durSeconds.toFixed(2)}s`;
    const end = `${endSeconds.toFixed(2)}s`;
    const labelY = labelPositions[index] ?? finalPoint.y + 4;

    return `
      <path
        d="${s.path}"
        class="line"
        stroke="${s.color}"
        stroke-dasharray="${s.pathLength}"
        stroke-dashoffset="${s.pathLength}"
      >
        <animate
          attributeName="stroke-dashoffset"
          from="${s.pathLength}"
          to="0"
          begin="${begin}"
          dur="${dur}"
          fill="freeze"
        />
      </path>

      <circle cx="${s.points[0].x}" cy="${s.points[0].y}" r="4" fill="${s.color}" opacity="0">
        <animate attributeName="opacity" from="0" to="1" begin="${begin}" dur="0.15s" fill="freeze" />
        <animateMotion begin="${begin}" dur="${dur}" fill="freeze" path="${s.path}" />
      </circle>

      <text fill="${s.color}" font-size="12" font-weight="600" opacity="0">
        ${escapeXml(s.name)}
        <animate attributeName="opacity" from="0" to="1" begin="${begin}" dur="0.25s" fill="freeze" />
        <animate attributeName="opacity" from="1" to="0" begin="${end}" dur="0.01s" fill="freeze" />
        <animateMotion begin="${begin}" dur="${dur}" fill="freeze" path="${s.path}" />
      </text>

      <g opacity="0">
        <animate attributeName="opacity" from="0" to="1" begin="${end}" dur="0.35s" fill="freeze" />
        <line x1="${finalPoint.x + 4}" y1="${finalPoint.y}" x2="${labelX - 6}" y2="${labelY - 2}" stroke="${s.color}" stroke-width="1" opacity="0.45" />
        <text x="${labelX}" y="${labelY}" class="end-label" fill="${s.color}">
          ${escapeXml(s.name)}: ${formatBytes(s.finalValue)}${showPercent ? ` (${formatPercent((s.finalValue / grandTotal) * 100)})` : ''}
        </text>
      </g>
    `;
  }).join('')}
</svg>`.trim();

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    res.status(200).send(svg);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
