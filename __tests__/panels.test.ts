import { spawnSync } from 'child_process';
import * as path from 'path';

import { PanelRect, parsePagePanels, readingOrder } from '../src/library/panels';

const r = (x: number, y: number, w: number, h: number): PanelRect => ({ x, y, w, h });

describe('readingOrder', () => {
  // 2x2 grid: A B on top, C D below.
  const A = r(0, 0, 100, 100);
  const B = r(110, 0, 100, 100);
  const C = r(0, 110, 100, 100);
  const D = r(110, 110, 100, 100);

  it('reads rows top to bottom, right to left for manga', () => {
    expect(readingOrder([A, B, C, D], true)).toEqual([B, A, D, C]);
  });

  it('reads rows top to bottom, left to right for western', () => {
    expect(readingOrder([B, A, D, C], false)).toEqual([A, B, C, D]);
  });

  it('keeps a stack of small panels together beside a tall one', () => {
    const tall = r(0, 0, 100, 300);
    const top = r(110, 0, 100, 140);
    const bottom = r(110, 160, 100, 140);
    expect(readingOrder([tall, top, bottom], true)).toEqual([top, bottom, tall]);
    expect(readingOrder([top, bottom, tall], false)).toEqual([tall, top, bottom]);
  });

  it('re-sorts stored panels for the requested direction', () => {
    const json = JSON.stringify([B, A, D, C]);
    expect(parsePagePanels(json)).toEqual([B, A, D, C]);
    expect(parsePagePanels(json, true)).toEqual([B, A, D, C]);
    expect(parsePagePanels(json, false)).toEqual([A, B, C, D]);
  });
});

// Cross-check against the panelizer's Python implementation on random layouts.
function randomLayouts(seed: number, count: number): number[][][] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const pages: number[][][] = [];
  for (let p = 0; p < count; p++) {
    const n = 1 + Math.floor(rand() * 9);
    const boxes: number[][] = [];
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rand() * 1600);
      const y = Math.floor(rand() * 2300);
      boxes.push([x, y, x + 60 + Math.floor(rand() * 900), y + 60 + Math.floor(rand() * 1200)]);
    }
    pages.push(boxes);
  }
  return pages;
}

const PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from panelize import reading_order
pages = json.load(sys.stdin)
print(json.dumps([[reading_order(p, True), reading_order(p, False)] for p in pages]))
`;

const panelizerDir = path.join(__dirname, '..', 'tools', 'panelizer');
const probe = spawnSync('python', ['-c', `import sys; sys.path.insert(0, r"${panelizerDir}"); import panelize`]);
const havePython = probe.status === 0;

(havePython ? it : it.skip)('matches panelize.py reading_order', () => {
  const pages = randomLayouts(42, 400);
  const res = spawnSync('python', ['-c', PY, panelizerDir], { input: JSON.stringify(pages), encoding: 'utf8' });
  expect(res.status).toBe(0);
  const expected = JSON.parse(res.stdout) as number[][][][];
  pages.forEach((boxes, i) => {
    const rects = boxes.map(([x1, y1, x2, y2]) => r(x1, y1, x2 - x1, y2 - y1));
    const toXyxy = (rs: PanelRect[]) => rs.map((q) => [q.x, q.y, q.x + q.w, q.y + q.h]);
    expect(toXyxy(readingOrder(rects, true))).toEqual(expected[i][0]);
    expect(toXyxy(readingOrder(rects, false))).toEqual(expected[i][1]);
  });
});
