import { NARAYANADRI_TEMPLATE } from '../config/app-config';
import {
  buildColumns,
  describeSheets,
  detectHeaderRow,
  detectMonth,
  isFlatId,
  isPaidStatus,
  parseSheet,
  pickLatestSheet,
  validateBill,
} from './excel-import';

// Header row exactly as in the association's NR-WaterMeterReadings workbook (OCT 2026 sheet).
const HEADER = [
  'FLAT\nNO.', 'PREVIOUS\nREADING ', 'PRESENT', 'Total TARE IN\nLTRS ', 'SLAB I Ltrs ( Up to 15k)', 'SLB II Ltrs( Above 15k)',
  'Per Ltr in NP Slab I ( Actual Cost)', 'Per Ltr in NP Slab II ( 15% on SLB I)', 'Slab I Charges', 'Slab II Charges',
  'FLAT\nNO. maintaince stataus', 'Total WATER\nCHARGES (Rounded)', 'Manjeera Water Bill per Flat', 'Repair Manjeera',
  'MNTS\nCHARGES', 'TOTAL', 'Status', null,
];
const OCT: unknown[][] = [
  ['*******NARAYANADRI RESIDENCY OCT 26 MAINTAINANCE REPORT*******', null, null, null, null, null, 0.0279, 0.0321],
  HEADER,
  [101, 921630, 929980, 8350, 8350, 0, 0.0279, 0.0321, 232.965, 0, 101, 233, 120, null, 1300, 1653, 'P', 101],
  [401, 1535370, 1554670, 19300, 15000, 4300, 0.0279, 0.0321, 418.5, 138.03, 401, 557, 120, 50, 1300, '2,027', null, 401],
  [],
  [null, null, 'Total Water Readings', 27650, null, null, null, 'Amount to be collected:', null, 3680],
  [null, null, 'Tanker Charges', 1500, null, null, null, 'Pending Amount', null, 2027],
  ['Common water usage'],
  ['Note:'],
];

describe('NR maintenance sheet import (real workbook layout)', () => {
  const draft = parseSheet(OCT, NARAYANADRI_TEMPLATE);
  const role = (i: number) => draft.columns[i].role;

  it('finds the header row and month', () => {
    expect(draft.headerRowIndex).toBe(1);
    expect(draft.detectedMonth).toBe('2026-10');
  });

  it('maps flat, meter info, line items, TOTAL and Status', () => {
    expect(role(0)).toBe('flat');
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(role)).toEqual(Array(9).fill('info'));
    expect(role(10)).toBe('ignore'); // second FLAT column
    expect(draft.columns.filter((c) => c.role === 'expense').map((c) => c.label)).toEqual([
      'Water Charges', 'Manjeera Water', 'Repair Manjeera', 'Maintenance',
    ]);
    expect(role(15)).toBe('total');
    expect(role(16)).toBe('status');
    expect(role(17)).toBe('ignore'); // unlabelled helper column right of TOTAL
    expect(draft.columns[0].sourceHeader).toBe('FLAT NO.'); // line breaks collapsed
  });

  it('reads flats, totals and status; skips the summary block and notes', () => {
    expect(draft.flats.map((f) => [f.flat, f.total, f.sheetStatus ?? ''])).toEqual([
      ['101', 1653, 'P'],
      ['401', 2027, ''],
    ]);
  });

  it('validates cleanly - extra charge columns are part of the total', () => {
    expect(validateBill({ month: '2026-10', columns: draft.columns, flats: draft.flats })).toEqual({ errors: [], warnings: [] });
  });

  it('flags mismatched totals, duplicates and a missing month', () => {
    const flats = [...draft.flats, { ...draft.flats[0], total: 1700 }];
    const v = validateBill({ month: '', columns: draft.columns, flats });
    expect(v.errors.join('\n')).toMatch(/month/);
    expect(v.errors.join('\n')).toMatch(/Flat 101 appears more than once/);
    expect(v.warnings.join('\n')).toMatch(/add up to 1653 but total is 1700/);
  });

  it('treats extra charges between water charges and TOTAL as line items (any name)', () => {
    const cols = buildColumns(
      ['FLAT NO.', 'Total WATER CHARGES (Rounded)', 'Manjeera Water Bill per Flat', 'Septic Tank Expenses', 'MNTS CHARGES', 'TOTAL', 'Status', 'Flat no', 'Total'],
      NARAYANADRI_TEMPLATE,
    );
    expect(cols.map((c) => c.role)).toEqual(['flat', 'expense', 'expense', 'expense', 'expense', 'total', 'status', 'ignore', 'ignore']);
  });

  it('reads the older 2019 layout (service no, single rate)', () => {
    const rows = [
      ['NARAYANADRI - MAINTANENCE DATA November - 2019'],
      ['SERVICE\nNO.', 'FLAT\nNO.', 'PREVIOUS\nREADING', 'PRESENT\nREADING', 'TARE IN\nLTRS', 'Per Ltr in NP', 'WATER\nCHARGES (Rounded)', 'MNTS\nCHARGES', 'TOTAL'],
      [4100, 101, 29780, 47190, 17410, 0.009469, 165, 1000, 1165],
    ];
    const d = parseSheet(rows, NARAYANADRI_TEMPLATE);
    expect(d.detectedMonth).toBe('2019-11');
    expect(d.flats).toMatchObject([{ flat: '101', total: 1165 }]);
    expect(validateBill({ month: '2019-11', columns: d.columns, flats: d.flats }).errors).toEqual([]);
  });
});

describe('workbook with one sheet per month', () => {
  const sheet = (title: string) => [[title], HEADER, [101, 1, 2, 1, 1, 0, 0, 0, 0, 0, 101, 1, 120, null, 1300, 1421]];
  const sheets = [
    { name: 'Nov -2019', rows: sheet('NOV 2019') },
    { name: 'Dec 2025', rows: sheet('DEC 2025') },
    { name: 'OCT 2026', rows: sheet('OCT 26') },
    { name: 'May 2021', rows: sheet('May 2020') },
    { name: 'Notes', rows: [['just notes']] },
  ];

  it('describes each sheet and picks the latest month by default', () => {
    const info = describeSheets(sheets);
    expect(info.map((s) => s.month)).toEqual(['2019-11', '2025-12', '2026-10', '2021-05', null]);
    expect(info[4].hasHeader).toBe(false);
    expect(pickLatestSheet(info)).toBe(2);
  });
});

describe('helpers', () => {
  it('recognises flat ids and paid status', () => {
    expect(['101', 'A-101', 'B 12', '12A'].every(isFlatId)).toBe(true);
    expect(['Note:', 'Common water usage', '3.Late payments penalities borne by payee'].some(isFlatId)).toBe(false);
    expect(['P', 'p', 'Paid', 'yes'].every(isPaidStatus)).toBe(true);
    expect(['', 'NP', 'pending', undefined].some(isPaidStatus)).toBe(false);
  });

  it('does not guess the total when several total-like headers are ambiguous', () => {
    const cols = buildColumns(['Flat', 'Total', 'Total']);
    expect(cols.some((c) => c.role === 'total')).toBe(false);
    expect(validateBill({ month: '2026-11', columns: cols, flats: [] }).errors.join()).toMatch(/Total/);
  });

  it('returns -1 when no flat header exists', () => {
    expect(detectHeaderRow([['a', 'b'], [1, 2]])).toBe(-1);
  });

  it.each([
    ['NARAYANADRI RESIDENCY OCT 26 MAINTAINANCE', '2026-10'],
    ['Oct-2026.xlsx', '2026-10'],
    ['Jun, 2023', '2023-06'],
    ['Nov -2019', '2019-11'],
    ['July 22', '2022-07'],
    ['Oct2020', '2020-10'],
    ['2027-01 bill.xlsx', '2027-01'],
    ['NR-WaterMeterReadings_2026.xlsx', null],
  ])('detectMonth(%s) = %s', (text, expected) => {
    expect(detectMonth(text)).toBe(expected);
  });
});
