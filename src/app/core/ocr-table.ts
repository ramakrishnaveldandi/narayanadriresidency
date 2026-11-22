/**
 * Reading the monthly maintenance sheet from a screenshot / photo.
 *
 * Pipeline (all pure functions - no DOM, no OCR engine - so they run in the
 * browser and in Node tests):
 *   1. toGray            RGBA pixels -> luminance
 *   2. findVerticalLines detect the spreadsheet's column grid lines
 *   3. rebuildSpaced     redraw each column with wide white gaps, upscaled and
 *                        binarised (grid lines and grey row bands disappear) -
 *                        stops OCR from gluing neighbouring cells together
 *   4. (OCR engine reads the rebuilt image, digits only)
 *   5. parseOcrText      text lines -> rows of numbers
 *   6. reconcileRows     recompute every bill from the meter readings and the
 *                        water tariff and cross-check against the TOTAL read by
 *                        OCR; rows that do not agree are flagged for review
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA
}

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // one luminance byte per pixel
}

export function toGray(img: RgbaImage): GrayImage {
  const out = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
  }
  return { width: img.width, height: img.height, data: out };
}

/** X positions of vertical grid lines: columns that are non-white over almost the whole height. */
export function findVerticalLines(g: GrayImage, minCoverage = 0.85, whiteLevel = 235): number[] {
  const hits: boolean[] = [];
  for (let x = 0; x < g.width; x++) {
    let dark = 0;
    for (let y = 0; y < g.height; y++) if (g.data[y * g.width + x] < whiteLevel) dark++;
    hits.push(dark / g.height >= minCoverage);
  }
  const lines: number[] = [];
  for (let x = 0; x < hits.length; x++) {
    if (!hits[x]) continue;
    let end = x;
    while (end + 1 < hits.length && hits[end + 1]) end++;
    // Wide runs are filled areas, not grid lines.
    if (end - x <= 4) lines.push(Math.round((x + end) / 2));
    x = end;
  }
  return lines;
}

/**
 * Y positions of horizontal borders between rows: thin rows of pixels that are
 * darker than the pixels 2-3 px above and below across most of the width.
 */
export function findHorizontalLines(g: GrayImage, minCoverage = 0.6, margin = 8): number[] {
  const W = g.width;
  const out: number[] = [];
  for (let y = 3; y < g.height - 3; y++) {
    let ridge = 0;
    for (let x = 0; x < W; x++) {
      const v = g.data[y * W + x];
      const up = Math.max(g.data[(y - 2) * W + x], g.data[(y - 3) * W + x]);
      const down = Math.max(g.data[(y + 2) * W + x], g.data[(y + 3) * W + x]);
      if (v + margin < up && v + margin < down) ridge++;
    }
    if (ridge / W >= minCoverage) out.push(y);
  }
  return out;
}

/** Column segments [x0, x1) between grid lines (narrow slivers dropped). */
export function columnSegments(lines: number[], width: number, minWidth = 6): [number, number][] {
  const edges = [0, ...lines, width];
  const segs: [number, number][] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const x0 = edges[i] + (i === 0 ? 0 : 2);
    const x1 = edges[i + 1] - 1;
    if (x1 - x0 >= minWidth) segs.push([x0, x1]);
  }
  return segs;
}

/**
 * Redraws the image column by column with `gap` white pixels between columns,
 * upscaled by `scale` (bilinear) and binarised at `threshold`. Returns RGBA so
 * it can be put straight onto a canvas.
 */
export function rebuildSpaced(
  g: GrayImage,
  segments: [number, number][],
  scale = 3,
  gap = 48,
  threshold = 150,
  hLines: number[] = [],
): RgbaImage {
  // Source rows that belong to a horizontal border are painted white.
  const erase = new Uint8Array(g.height);
  for (const y of hLines) for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < g.height) erase[y + d] = 1;
  const colWidths = segments.map(([a, b]) => Math.round((b - a) * scale));
  const width = colWidths.reduce((s, w) => s + w, 0) + gap * (segments.length + 1);
  const height = Math.round(g.height * scale) + 2 * gap;
  const out = new Uint8ClampedArray(width * height * 4).fill(255);
  let ox = gap;
  segments.forEach(([x0, x1], i) => {
    const w = colWidths[i];
    for (let oy = 0; oy < height - 2 * gap; oy++) {
      const sy = Math.min(g.height - 1.001, oy / scale);
      const y0 = Math.floor(sy);
      const fy = sy - y0;
      if (erase[y0] || erase[y0 + 1]) continue;
      for (let dx = 0; dx < w; dx++) {
        const sx = Math.min(x1 - 1.001, x0 + dx / scale);
        const xa = Math.floor(sx);
        const fx = sx - xa;
        const i00 = g.data[y0 * g.width + xa];
        const i10 = g.data[y0 * g.width + xa + 1];
        const i01 = g.data[(y0 + 1) * g.width + xa];
        const i11 = g.data[(y0 + 1) * g.width + xa + 1];
        const v = (i00 * (1 - fx) + i10 * fx) * (1 - fy) + (i01 * (1 - fx) + i11 * fx) * fy;
        if (v < threshold) {
          const p = ((oy + gap) * width + ox + dx) * 4;
          out[p] = out[p + 1] = out[p + 2] = 0;
        }
      }
    }
    ox += w + gap;
  });
  return { width, height, data: out };
}

/** Row bands [y0, y1) between horizontal borders (borders within 3 px merged). */
export function rowBands(hLines: number[], height: number, minHeight = 8): [number, number][] {
  const merged: number[] = [];
  for (const y of hLines) {
    if (merged.length && y - merged[merged.length - 1] <= 3) merged[merged.length - 1] = y;
    else merged.push(y);
  }
  const edges = [0, ...merged, height];
  const bands: [number, number][] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const y0 = edges[i] + (i === 0 ? 0 : 2);
    const y1 = edges[i + 1] - 1;
    if (y1 - y0 >= minHeight) bands.push([y0, y1]);
  }
  return bands;
}

export interface CellRect {
  row: number;
  col: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Redraws every cell on its own spot of a wide grid (big white gaps between all
 * cells), upscaled and binarised. Grid lines and row bands disappear, OCR cannot
 * glue neighbouring cells together, and each recognised word can be mapped back
 * to its exact (row, column) from its position.
 */
export function rebuildGrid(
  g: GrayImage,
  cols: [number, number][],
  rows: [number, number][],
  scale = 3,
  gap = 40,
  threshold = 150,
): { image: RgbaImage; cells: CellRect[] } {
  const cw = cols.map(([a, b]) => Math.round((b - a) * scale));
  const rh = rows.map(([a, b]) => Math.round((b - a) * scale));
  const width = cw.reduce((s, w) => s + w + gap, gap);
  const height = rh.reduce((s, h) => s + h + gap, gap);
  const out = new Uint8ClampedArray(width * height * 4).fill(255);
  const cells: CellRect[] = [];
  let oy = gap;
  rows.forEach(([ry0, ry1], r) => {
    let ox = gap;
    cols.forEach(([cx0, cx1], c) => {
      const w = cw[c];
      const h = rh[r];
      for (let dy = 0; dy < h; dy++) {
        const sy = Math.min(ry1 - 1.001, ry0 + dy / scale);
        const y0 = Math.floor(sy);
        const fy = sy - y0;
        for (let dx = 0; dx < w; dx++) {
          const sx = Math.min(cx1 - 1.001, cx0 + dx / scale);
          const x0 = Math.floor(sx);
          const fx = sx - x0;
          const a = g.data[y0 * g.width + x0];
          const b = g.data[y0 * g.width + x0 + 1];
          const cc = g.data[(y0 + 1) * g.width + x0];
          const d = g.data[(y0 + 1) * g.width + x0 + 1];
          const v = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
          if (v < threshold) {
            const p = ((oy + dy) * width + ox + dx) * 4;
            out[p] = out[p + 1] = out[p + 2] = 0;
          }
        }
      }
      cells.push({ row: r, col: c, x0: ox, y0: oy, x1: ox + w, y1: oy + h });
      ox += w + gap;
    });
    oy += rh[r] + gap;
  });
  return { image: { width, height, data: out }, cells };
}

export interface OcrWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Puts each OCR word into the cell that contains its centre; returns cell texts [row][col]. */
export function wordsToGrid(words: OcrWord[], cells: CellRect[], nRows: number, nCols: number): string[][] {
  const grid: { x: number; t: string }[][][] = Array.from({ length: nRows }, () => Array.from({ length: nCols }, () => []));
  for (const w of words) {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const cell = cells.find((c) => cx >= c.x0 - 8 && cx <= c.x1 + 8 && cy >= c.y0 - 8 && cy <= c.y1 + 8);
    if (cell) grid[cell.row][cell.col].push({ x: w.bbox.x0, t: w.text });
  }
  return grid.map((row) => row.map((parts) => parts.sort((a, b) => a.x - b.x).map((p) => p.t).join('')));
}

/** Columns of the Narayanadri sheet that hold decimals (rates and slab amounts); all others are whole numbers. */
const DECIMAL_COLUMNS = new Set([6, 7, 8, 9]);

/** Cell texts -> OcrRows. Only rows whose first cell is a flat number are kept. */
export function gridToRows(grid: string[][]): OcrRow[] {
  const rows: OcrRow[] = [];
  for (const cellsText of grid) {
    const flatLike = (t: string | undefined) => /^\d{3,4}$/.test((t ?? '').replace(/[^0-9]/g, ''));
    const filled = cellsText.filter((t) => /\d/.test(t)).length;
    // A data row has a flat number in column 1 or 11, or at least is mostly numbers
    // (the flat is then taken from the row order during reconciliation).
    if (!flatLike(cellsText[0]) && !flatLike(cellsText[10]) && filled < 8) continue;
    const cells = cellsText.map((t, col) => {
      let s = t.replace(/[^0-9.,]/g, '');
      if (!s) return null;
      // Whole-number columns: "1,653" / "1.653" are thousands separators.
      s = DECIMAL_COLUMNS.has(col) ? s.replace(/,/g, '.') : s.replace(/[.,]/g, '');
      const n = Number(s);
      return Number.isFinite(n) && s !== '' ? n : null;
    });
    rows.push({ numbers: cells.filter((v): v is number => v !== null), cells, raw: cellsText.join(' | ') });
  }
  return rows;
}

// ------------------------------------------------------------------ text -> rows

export interface OcrRow {
  /** Numbers found on the line, in reading order. */
  numbers: number[];
  /** Value per sheet column when the column layout is known (null = unreadable). */
  cells?: (number | null)[];
  raw: string;
}

/** Keeps lines that start with a flat-like number (3-4 digits) and extracts all numbers. */
export function parseOcrText(text: string): OcrRow[] {
  const rows: OcrRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const tokens = raw
      .replace(/(\d),(\d{3})(?!\d)/g, '$1$2') // 1,653 -> 1653
      .split(/\s+/)
      .map((t) => t.replace(/^[.,]+|[.,]+$/g, ''))
      .filter((t) => /^\d+(\.\d+)?$/.test(t));
    if (tokens.length < 4 || !/^\d{3,4}$/.test(tokens[0])) continue;
    rows.push({ numbers: tokens.map(Number), raw: raw.trim() });
  }
  return rows;
}

// ------------------------------------------------------------------ reconcile

export interface WaterTariff {
  slabLimit: number;
  rate1: number;
  rate2: number;
}

export interface FixedCharges {
  manjeera: number;
  maintenance: number;
}

export interface ReadRow {
  flat: string;
  previous: number | null;
  present: number | null;
  used: number | null;
  slab1: number | null;
  slab2: number | null;
  amount1: number | null;
  amount2: number | null;
  water: number | null;
  manjeera: number;
  maintenance: number;
  total: number;
  /** 'ok' = calculation and OCR total agree; 'check' = admin should look; 'missing' = row not read at all. */
  status: 'ok' | 'check' | 'missing';
  notes: string[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function waterCharge(used: number, t: WaterTariff) {
  const slab1 = Math.min(used, t.slabLimit);
  const slab2 = Math.max(0, used - t.slabLimit);
  const amount1 = r3(slab1 * t.rate1);
  const amount2 = r3(slab2 * t.rate2);
  // Sheet rounds the combined water charge up to the next rupee.
  const water = Math.ceil(r3(amount1 + amount2) - 1e-9);
  return { slab1, slab2, amount1, amount2, water };
}

/** Most common per-litre rates found in the rows (columns 7 and 8 of the sheet), if any. */
export function detectTariff(rows: OcrRow[], fallback: WaterTariff): WaterTariff {
  const vote = (vals: number[]) => {
    const counts = new Map<number, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: number | undefined;
    let n = 0;
    for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
    return n >= 3 ? best : undefined;
  };
  const r1: number[] = [];
  const r2: number[] = [];
  for (const r of rows) {
    if (r.cells && r.cells.length === SHEET_COLUMNS) {
      const [a, b] = [r.cells[6], r.cells[7]];
      if (a && b && a < 0.2 && b < 0.2) {
        r1.push(a);
        r2.push(b);
      }
      continue;
    }
    const small = r.numbers.filter((v) => v > 0.005 && v < 0.2);
    if (small.length >= 2) {
      r1.push(small[0]);
      r2.push(small[1]);
    }
  }
  return { slabLimit: fallback.slabLimit, rate1: vote(r1) ?? fallback.rate1, rate2: vote(r2) ?? fallback.rate2 };
}

interface Anchors {
  flatA?: number;
  flatB?: number;
  previous?: number;
  present?: number;
  ocrWater?: number;
  manjeera?: number;
  maintenance?: number;
  total?: number;
}

/** FLAT | PREVIOUS | PRESENT | Total | SLAB I | SLB II | rate1 | rate2 | Slab I ₹ | Slab II ₹ | FLAT | Total | Manjeera | MNTS | TOTAL */
export const SHEET_COLUMNS = 15;

function anchors(row: OcrRow): Anchors {
  const c = row.cells;
  if (c && c.length === SHEET_COLUMNS) {
    const v = (i: number) => c[i] ?? undefined;
    return {
      flatA: v(0), previous: v(1), present: v(2), flatB: v(10),
      ocrWater: v(11), manjeera: v(12), maintenance: v(13), total: v(14),
    };
  }
  const nums = row.numbers;
  const a: Anchors = {};
  a.flatA = nums[0];
  // Meter readings: first consecutive pair of large integers with present > previous.
  for (let i = 1; i < nums.length - 1; i++) {
    const p = nums[i];
    const q = nums[i + 1];
    if (Number.isInteger(p) && Number.isInteger(q) && p >= 10000 && q >= p && q - p < 200000) {
      a.previous = p;
      a.present = q;
      break;
    }
  }
  const n = nums.length;
  if (n >= 5) {
    a.total = nums[n - 1];
    a.maintenance = nums[n - 2];
    a.manjeera = nums[n - 3];
    a.ocrWater = nums[n - 4];
    if (n >= 6 && /^\d{3,4}$/.test(String(nums[n - 5]))) a.flatB = nums[n - 5];
  }
  return a;
}

/**
 * Turns OCR rows into bills. Every row is recomputed from its meter readings and
 * compared with the TOTAL read from the image. Flat numbers are matched against
 * the previous month's list (and its order) so a misread flat number is repaired;
 * flats that were not read at all come back as status 'missing'.
 */
export function reconcileRows(
  rows: OcrRow[],
  opts: { tariff: WaterTariff; fixed: FixedCharges; knownFlats: string[] },
): ReadRow[] {
  const known = opts.knownFlats;
  const used = new Set<string>();
  const out: ReadRow[] = [];

  rows.forEach((row, i) => {
    const a = anchors(row);
    const notes: string[] = [];

    // ---- flat number (read twice on the sheet: first and 11th column)
    const candidates = [a.flatA, a.flatB].filter((v): v is number => v !== undefined).map(String);
    let flat = candidates.find((c) => (!known.length || known.includes(c)) && !used.has(c));
    if (!flat && known.length) {
      const expected = known[i];
      if (expected && !used.has(expected)) {
        flat = expected;
        notes.push(`Flat number unclear (read ${candidates.join('/') || '?'}), assumed ${expected} from row order.`);
      }
    }
    if (!flat) return; // not a usable row
    used.add(flat);

    // ---- fixed charges
    const manjeera = a.manjeera === opts.fixed.manjeera ? a.manjeera : opts.fixed.manjeera;
    const maintenance = a.maintenance === opts.fixed.maintenance ? a.maintenance : opts.fixed.maintenance;
    if (a.manjeera !== undefined && a.manjeera !== opts.fixed.manjeera) notes.push(`Manjeera read as ${a.manjeera}, used ${opts.fixed.manjeera}.`);
    if (a.maintenance !== undefined && a.maintenance !== opts.fixed.maintenance) notes.push(`Maintenance read as ${a.maintenance}, used ${opts.fixed.maintenance}.`);

    // ---- recompute from readings
    let calc: ReturnType<typeof waterCharge> | null = null;
    let usedL: number | null = null;
    if (a.previous !== undefined && a.present !== undefined && a.present >= a.previous) {
      usedL = a.present - a.previous;
      if (usedL >= 0 && usedL <= 100000) calc = waterCharge(usedL, opts.tariff);
      else usedL = null;
    }
    const expected = calc ? calc.water + manjeera + maintenance : null;
    const ocrTotal = a.total;
    const ocrConsistent = a.ocrWater !== undefined && ocrTotal !== undefined && a.ocrWater + manjeera + maintenance === ocrTotal;

    let total: number;
    let water: number | null = calc?.water ?? null;
    let status: ReadRow['status'] = 'check';
    if (expected !== null && expected === ocrTotal) {
      total = expected;
      status = notes.length ? 'check' : 'ok';
    } else if (expected !== null && expected === (a.ocrWater ?? NaN) + manjeera + maintenance) {
      // Water column agrees with the readings; the TOTAL cell was misread.
      total = expected;
      status = notes.length ? 'check' : 'ok';
    } else if (ocrConsistent) {
      total = ocrTotal!;
      water = a.ocrWater!;
      notes.push(
        expected === null ? 'Meter readings could not be read.' : `Meter readings give ₹${expected}, sheet shows ₹${ocrTotal} - check readings.`,
      );
    } else if (expected !== null) {
      total = expected;
      notes.push(`Calculated ₹${expected} from readings; TOTAL read as ${ocrTotal ?? '?'} - please confirm.`);
    } else {
      total = ocrTotal ?? NaN;
      notes.push('Row only partly readable - please check.');
    }

    out.push({
      flat,
      previous: a.previous ?? null,
      present: a.present ?? null,
      used: usedL,
      slab1: calc?.slab1 ?? null,
      slab2: calc?.slab2 ?? null,
      amount1: calc?.amount1 ?? null,
      amount2: calc?.amount2 ?? null,
      water,
      manjeera,
      maintenance,
      total,
      status,
      notes,
    });
  });

  for (const f of known) {
    if (used.has(f)) continue;
    out.push({
      flat: f, previous: null, present: null, used: null, slab1: null, slab2: null, amount1: null, amount2: null,
      water: null, manjeera: opts.fixed.manjeera, maintenance: opts.fixed.maintenance, total: NaN,
      status: 'missing', notes: ['This flat was not found in the image - enter its figures.'],
    });
  }
  return out;
}

/** Rows in the Narayanadri sheet layout, ready for parseSheet() with the import template. */
export function toSheetRows(read: ReadRow[], tariff: WaterTariff, header: string[], title: string): unknown[][] {
  return [
    [title],
    header,
    ...read.map((r) => [
      r.flat, r.previous, r.present, r.used, r.slab1, r.slab2, tariff.rate1, tariff.rate2,
      r.amount1, r.amount2, r.flat, r.water, r.manjeera, r.maintenance, Number.isFinite(r.total) ? r.total : null,
    ]),
  ];
}
