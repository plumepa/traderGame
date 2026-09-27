import { readFileSync } from 'node:fs';

const h = readFileSync('preview/layout-preview.html', 'utf8');
const m = /const DATA = (\{[\s\S]*?\});\n\nfunction replay/.exec(h);
const d = JSON.parse(m[1]);

// 检查走势图那一帧：折线的 x 覆盖范围应当接近绘图区宽度
const f = d.frames.find((x) => x.label === '走势图弹窗');
const xs = [];
const ys = [];
let inStroke = 0;
for (const [op, args] of f.ops) {
  if (op === 'moveTo' || op === 'lineTo') {
    xs.push(args[0]);
    ys.push(args[1]);
  }
}
console.log('走势图弹窗：折线点数 =', xs.length);
console.log('  x 范围 =', Math.min(...xs).toFixed(1), '~', Math.max(...xs).toFixed(1));
console.log('  y 范围 =', Math.min(...ys).toFixed(1), '~', Math.max(...ys).toFixed(1));
console.log('  画布 W =', d.W, ' H =', d.H);
console.log('  期望：x 最大 ≈ W - 24 =', d.W - 24);

// 检查每帧的最低文字位置，确认都在安全区之下
console.log('\n各帧最低/最高文字 y：');
for (const fr of d.frames) {
  const t = fr.ops.filter((o) => o[0] === 'fillText').map((o) => o[1][2]);
  console.log(
    `  ${fr.label.padEnd(12)} 文字 ${String(t.length).padStart(3)} 条  y ∈ [${Math.min(...t).toFixed(0)}, ${Math.max(...t).toFixed(0)}]`,
  );
}
