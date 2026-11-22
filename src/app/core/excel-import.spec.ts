import { NARAYANADRI_TEMPLATE } from '../config/app-config';
import { buildColumns, detectHeaderRow, detectMonth, parseSheet, validateBill } from './excel-import';

const HEADER = ['FLAT', 'PREVIOUS', 'PRESENT', 'Total', 'SLAB I', 'SLB II Ltrs(', 'Per Ltr in', 'Per Ltr in', 'Slab I', 'Slab II', 'FLAT', 'Total', 'Manjeera', 'MNTS', 'TOTAL'];
const OCT: unknown[][] = [
  ['*******NARAYANADRI RESIDENCY OCT 26 MAINTAINANCE REP', null, null, null, null, null, 0.0279, 0.0321],
  HEADER,
  [101, 921630, 929980, 8350, 8350, 0, 0.0279, 0.0321, 232.965, 0, 101, 233, 120, 1300, 1653],
  [401, 1535370, 1554670, 19300, 15000, 4300, 0.0279, 0.0321, 418.5, 138.03, 401, 557, 120, 1300, '1,977'],
  [null],
];

describe('Narayanadri sheet import', () => {
  const draft = parseSheet(OCT, NARAYANADRI_TEMPLATE);

  it('finds the header row and month from the title', () => {
    expect(draft.headerRowIndex).toBe(1);
    expect(draft.detectedMonth).toBe('2026-10');
  });

  it('uses the final TOTAL column, not the other two "Total" columns', () => {
    const total = draft.columns.filter((c) => c.role === 'total');
    expect(total.map((c) => c.sourceIndex)).toEqual([14]);
    expect(draft.columns.filter((c) => c.role === 'expense').map((c) => c.label)).toEqual(['Water Charges', 'Manjeera Water', 'Maintenance']);
    expect(draft.columns[10].role).toBe('ignore');
  });

  it('extracts flats and totals (including formatted numbers)', () => {
    expect(draft.flats.map((f) => [f.flat, f.total])).toEqual([['101', 1653], ['401', 1977]]);
    expect(draft.flats[1].sourceRow).toBe(4);
  });

  it('validates cleanly when line items add up', () => {
    const v = validateBill({ month: '2026-10', columns: draft.columns, flats: draft.flats });
    expect(v).toEqual({ errors: [], warnings: [] });
  });

  it('flags mismatched totals, duplicates and missing month', () => {
    const flats = [...draft.flats, { ...draft.flats[0], total: 1700 }];
    const v = validateBill({ month: '', columns: draft.columns, flats });
    expect(v.errors.join('\n')).toMatch(/month/);
    expect(v.errors.join('\n')).toMatch(/Flat 101 appears more than once/);
    expect(v.warnings.join('\n')).toMatch(/add up to 1653 but total is 1700/);
  });
});

describe('generic sheets (different number of columns)', () => {
  it('maps a simple layout without a template', () => {
    const rows = [['Flat No', 'Maintenance', 'Water', 'Generator', 'Total'], ['A-1', 1300, 200, 50, 1550], ['A-2', 1300, 180, 50, 1530]];
    const d = parseSheet(rows);
    expect(d.columns.find((c) => c.role === 'flat')?.sourceHeader).toBe('Flat No');
    expect(d.columns.find((c) => c.role === 'total')?.sourceHeader).toBe('Total');
    expect(d.flats.map((f) => f.total)).toEqual([1550, 1530]);
  });

  it('does not guess the total when several total-like headers are ambiguous', () => {
    const cols = buildColumns(['Flat', 'Total', 'Total']);
    expect(cols.some((c) => c.role === 'total')).toBe(false);
    expect(validateBill({ month: '2026-11', columns: cols, flats: [] }).errors.join()).toMatch(/Total/);
  });

  it('returns -1 when no flat header exists', () => {
    expect(detectHeaderRow([['a', 'b'], [1, 2]])).toBe(-1);
  });
});

describe('detectMonth', () => {
  it.each([
    ['NARAYANADRI RESIDENCY OCT 26 MAINTAINANCE', '2026-10'],
    ['Oct-2026.xlsx', '2026-10'],
    ['November 2026', '2026-11'],
    ['2027-01 bill.xlsx', '2027-01'],
    ['random.xlsx', null],
  ])('%s -> %s', (text, expected) => {
    expect(detectMonth(text)).toBe(expected);
  });
});
