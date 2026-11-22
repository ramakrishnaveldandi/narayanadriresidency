import { NARAYANADRI_SHEET_HEADER, NARAYANADRI_TEMPLATE } from '../config/app-config';
import { parseSheet, validateBill } from './excel-import';
import {
  columnSegments,
  detectTariff,
  findVerticalLines,
  gridToRows,
  reconcileRows,
  rowBands,
  toSheetRows,
  waterCharge,
  wordsToGrid,
  type GrayImage,
} from './ocr-table';

const TARIFF = { slabLimit: 15000, rate1: 0.0279, rate2: 0.0321 };
const FIXED = { manjeera: 120, maintenance: 1300 };

// [flat, previous, present, printed TOTAL] from the Oct-2026 sheet
const OCT: [string, number, number, number][] = [
  ['101', 921630, 929980, 1653], ['201', 1096140, 1107440, 1736], ['301', 794190, 805970, 1749], ['401', 1535370, 1554670, 1977],
  ['501', 1128170, 1140180, 1756], ['102', 1248150, 1265330, 1909], ['202', 667160, 685480, 1946], ['302', 909020, 914000, 1559],
  ['402', 1340660, 1352680, 1756], ['502', 934520, 943820, 1680], ['103', 997970, 1010930, 1782], ['203', 1135070, 1143340, 1651],
  ['303', 764840, 776380, 1742], ['403', 1712490, 1721780, 1680], ['503', 835890, 846150, 1707], ['104', 1046910, 1059020, 1758],
  ['204', 1192510, 1202800, 1708], ['304', 1447260, 1462400, 1843], ['404', 764950, 772420, 1629], ['504', 1072520, 1084530, 1756],
  ['105', 1076290, 1085510, 1678], ['205', 824930, 836350, 1739], ['305', 1127830, 1137700, 1696], ['405', 820990, 831320, 1709],
  ['505', 864390, 872600, 1650], ['106', 937100, 946490, 1682], ['206', 714190, 721820, 1633], ['306', 748050, 750560, 1491],
  ['406', 1200730, 1218260, 1920], ['506', 1322860, 1337810, 1838],
];
const KNOWN = OCT.map((r) => r[0]);

/** Grid text as OCR would return it for one sheet row. */
function gridRow(flat: string, prev: number, present: number, total: string, flatCell = flat): string[] {
  const used = present - prev;
  const w = waterCharge(used, TARIFF);
  return [flatCell, String(prev), String(present), String(used), String(w.slab1), String(w.slab2), '0.0279', '0.0321',
    String(w.amount1), String(w.amount2), flat, String(w.water), '120', '1300', total];
}

describe('water tariff', () => {
  it('reproduces every printed TOTAL on the Oct-2026 sheet', () => {
    for (const [flat, prev, present, printed] of OCT) {
      expect(waterCharge(present - prev, TARIFF).water + 120 + 1300, `flat ${flat}`).toBe(printed);
    }
  });
});

describe('reconcileRows', () => {
  it('confirms rows whose readings match the TOTAL (thousand separators handled)', () => {
    const rows = gridToRows(OCT.map(([f, p, q, t]) => gridRow(f, p, q, t.toLocaleString('en-IN'))));
    const read = reconcileRows(rows, { tariff: detectTariff(rows, TARIFF), fixed: FIXED, knownFlats: KNOWN });
    expect(read).toHaveLength(30);
    expect(read.every((r) => r.status === 'ok')).toBe(true);
    expect(read.find((r) => r.flat === '401')).toMatchObject({ used: 19300, slab2: 4300, water: 557, total: 1977 });
  });

  it('fixes a misread TOTAL using the readings and water column', () => {
    const rows = gridToRows([gridRow('101', 921630, 929980, '1658')]);
    const [r] = reconcileRows(rows, { tariff: TARIFF, fixed: FIXED, knownFlats: ['101'] });
    expect(r).toMatchObject({ total: 1653, status: 'ok' });
  });

  it('flags a row when a meter reading is misread', () => {
    const row = gridRow('201', 1096140, 1107440, '1736');
    row[2] = '1107940'; // OCR error in PRESENT
    row[11] = '316';
    const [r] = reconcileRows(gridToRows([row]), { tariff: TARIFF, fixed: FIXED, knownFlats: ['201'] });
    expect(r.status).toBe('check');
    expect(r.total).toBe(1736); // water column + fixed charges agree with TOTAL
  });

  it('assigns an unreadable flat number from row order and reports missing flats', () => {
    const rows = gridToRows([gridRow('101', 921630, 929980, '1653'), gridRow('201', 1096140, 1107440, '1736', '')].map((r, i) => (i === 1 ? [...r.slice(0, 10), '', ...r.slice(11)] : r)));
    const read = reconcileRows(rows, { tariff: TARIFF, fixed: FIXED, knownFlats: ['101', '201', '301'] });
    expect(read.find((r) => r.flat === '201')).toMatchObject({ status: 'check', total: 1736 });
    expect(read.find((r) => r.flat === '301')).toMatchObject({ status: 'missing' });
  });

  it('produces sheet rows the normal Excel importer accepts', () => {
    const rows = gridToRows(OCT.map(([f, p, q, t]) => gridRow(f, p, q, String(t))));
    const read = reconcileRows(rows, { tariff: TARIFF, fixed: FIXED, knownFlats: KNOWN });
    const draft = parseSheet(toSheetRows(read, TARIFF, NARAYANADRI_SHEET_HEADER, 'NARAYANADRI RESIDENCY OCT 26'), NARAYANADRI_TEMPLATE);
    expect(draft.detectedMonth).toBe('2026-10');
    expect(draft.flats.reduce((s, f) => s + f.total, 0)).toBe(52013);
    expect(validateBill({ month: '2026-10', columns: draft.columns, flats: draft.flats })).toEqual({ errors: [], warnings: [] });
  });
});

describe('grid detection', () => {
  it('finds vertical grid lines and row bands', () => {
    // 40x30 white image with grid lines at x=10, x=25 and y=10, y=20
    const w = 40;
    const h = 30;
    const data = new Uint8ClampedArray(w * h).fill(255);
    for (let y = 0; y < h; y++) data[y * w + 10] = data[y * w + 25] = 180;
    const g: GrayImage = { width: w, height: h, data };
    expect(findVerticalLines(g)).toEqual([10, 25]);
    expect(columnSegments([10, 25], w)).toEqual([[0, 9], [12, 24], [27, 39]]);
    expect(rowBands([10, 20], h, 5)).toEqual([[0, 9], [12, 19], [22, 29]]);
  });

  it('maps OCR words to cells by position', () => {
    const cells = [
      { row: 0, col: 0, x0: 0, y0: 0, x1: 50, y1: 20 },
      { row: 0, col: 1, x0: 90, y0: 0, x1: 140, y1: 20 },
    ];
    const grid = wordsToGrid(
      [
        { text: '65', bbox: { x0: 110, y0: 2, x1: 130, y1: 18 } },
        { text: '101', bbox: { x0: 5, y0: 2, x1: 30, y1: 18 } },
        { text: '1,', bbox: { x0: 92, y0: 2, x1: 105, y1: 18 } },
      ],
      cells, 1, 2,
    );
    expect(grid).toEqual([['101', '1,65']]);
  });
});
