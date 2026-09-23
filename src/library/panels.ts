export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PagePanels {
  w: number | null;
  h: number | null;
  panels: PanelRect[];
}

export interface PanelsDoc {
  rtl: boolean;
  pages: Record<string, PagePanels>;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normRects(v: unknown): PanelRect[] {
  if (!Array.isArray(v)) return [];
  const out: PanelRect[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    const w = num(o.w);
    const h = num(o.h);
    if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

/** Accepts the full document form and the bare {entry: [rects]} form. */
export function parsePanelsJson(text: string): PanelsDoc | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') return null;
    const pagesRaw = (raw.pages && typeof raw.pages === 'object' ? raw.pages : raw) as Record<string, unknown>;
    const pages: Record<string, PagePanels> = {};
    for (const [name, v] of Object.entries(pagesRaw)) {
      if (Array.isArray(v)) {
        pages[name] = { w: null, h: null, panels: normRects(v) };
      } else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        pages[name] = { w: num(o.w), h: num(o.h), panels: normRects(o.panels) };
      }
    }
    return { rtl: raw.rtl !== false, pages };
  } catch {
    return null;
  }
}

export function parsePagePanels(json: string | null): PanelRect[] {
  if (!json) return [];
  try {
    return normRects(JSON.parse(json));
  } catch {
    return [];
  }
}
