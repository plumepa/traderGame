import { wavyPath } from '../js/styles/chart.js';
import { monthName } from '../js/styles/palette.js';

const baseCloses = [13.0, 13.8, 12.4, 14.1, 15.0, 13.6, 16.2, 15.1, 17.0, 16.2, 18.1, 19.5];

function ascii(turn, chartW = 76, chartH = 16) {
  const closes = baseCloses.slice(0, turn + 1);
  const INNER = 5;
  const wavy = wavyPath(closes, '910101', { inner: INNER });

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;

  const grid = Array.from({ length: chartH }, () => Array(chartW).fill(' '));

  // 按 positions 映射到列
  const n = wavy.length;
  const positions = [];
  const labelAt = [];
  for (let i = 0; i < closes.length; i++) {
    positions.push(i / (closes.length - 1));
    labelAt.push(positions.length - 1);
    for (let k = 1; k <= INNER && i < closes.length - 1; k++) {
      positions.push((i + k / (INNER + 1)) / (closes.length - 1));
    }
  }

  wavy.forEach((v, i) => {
    const col = Math.round(positions[i] * (chartW - 1));
    const row = chartH - 1 - Math.round(((v - min) / span) * (chartH - 1));
    if (row >= 0 && row < chartH && col >= 0 && col < chartW) grid[row][col] = '*';
  });
  // 月份点标 o
  labelAt.forEach((idx) => {
    const col = Math.round(positions[idx] * (chartW - 1));
    const row = chartH - 1 - Math.round(((wavy[idx] - min) / span) * (chartH - 1));
    if (row >= 0 && row < chartH) grid[row][col] = 'o';
  });

  console.log(`\n=== 第 ${turn} 月（${closes.length} 个月度点，${wavy.length} 个绘点）===`);
  grid.forEach((r) => console.log('|' + r.join('') + '|'));
}

[1, 3, 6, 12].forEach((t) => ascii(t));
