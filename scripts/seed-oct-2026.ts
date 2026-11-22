/**
 * Builds samples/Oct-2026.xlsx - a sample in the same layout as the association's
 * NR-WaterMeterReadings workbook (title row, real column headers, an extra
 * "Repair Manjeera" charge column, Status column, helper column and the summary
 * block under the table) - and generates public/data/2026-10.json from it using the
 * same parser the admin import screen uses.
 *
 * Run: node scripts/seed-oct-2026.ts
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseSheet, validateBill } from '../src/app/core/excel-import.ts';
import type { MonthRecord } from '../src/app/core/models.ts';
import { NARAYANADRI_TEMPLATE } from '../src/app/config/app-config.ts';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const R1 = 0.0279;
const R2 = 0.0321;
const MANJEERA = 120;
const MNTS = 1300;
const SLAB = 15000;

// FLAT, PREVIOUS, PRESENT - October 2026 meter readings
const readings: [string, number, number][] = [
  ['101', 921630, 929980], ['201', 1096140, 1107440], ['301', 794190, 805970], ['401', 1535370, 1554670],
  ['501', 1128170, 1140180], ['102', 1248150, 1265330], ['202', 667160, 685480], ['302', 909020, 914000],
  ['402', 1340660, 1352680], ['502', 934520, 943820], ['103', 997970, 1010930], ['203', 1135070, 1143340],
  ['303', 764840, 776380], ['403', 1712490, 1721780], ['503', 835890, 846150], ['104', 1046910, 1059020],
  ['204', 1192510, 1202800], ['304', 1447260, 1462400], ['404', 764950, 772420], ['504', 1072520, 1084530],
  ['105', 1076290, 1085510], ['205', 824930, 836350], ['305', 1127830, 1137700], ['405', 820990, 831320],
  ['505', 864390, 872600], ['106', 937100, 946490], ['206', 714190, 721820], ['306', 748050, 750560],
  ['406', 1200730, 1218260], ['506', 1322860, 1337810],
];

// Final TOTAL column as printed on the sheet - used to check the re-creation.
const printedTotals: Record<string, number> = {
  '101': 1653, '201': 1736, '301': 1749, '401': 1977, '501': 1756, '102': 1909, '202': 1946, '302': 1559,
  '402': 1756, '502': 1680, '103': 1782, '203': 1651, '303': 1742, '403': 1680, '503': 1707, '104': 1758,
  '204': 1708, '304': 1843, '404': 1629, '504': 1756, '105': 1678, '205': 1739, '305': 1696, '405': 1709,
  '505': 1650, '106': 1682, '206': 1633, '306': 1491, '406': 1920, '506': 1838,
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

const rows: unknown[][] = [
  ['*******NARAYANADRI RESIDENCY OCT 26 MAINTAINANCE REPORT*******************', null, null, null, null, null, R1, R2],
  [
    'FLAT\nNO.', 'PREVIOUS\nREADING ', 'PRESENT', 'Total TARE IN\nLTRS ', 'SLAB I Ltrs ( Up to 15k)', 'SLB II Ltrs( Above 15k)',
    'Per Ltr in NP Slab I ( Actual Cost)', 'Per Ltr in NP Slab II ( 15% on SLB I)', 'Slab I Charges', 'Slab II Charges',
    'FLAT\nNO. maintaince stataus', 'Total WATER\nCHARGES (Rounded)', 'Manjeera Water Bill per Flat', 'Repair Manjeera',
    'MNTS\nCHARGES', 'TOTAL', 'Status', null,
  ],
];
for (const [flat, prev, present] of readings) {
  const used = present - prev;
  const s1 = Math.min(used, SLAB);
  const s2 = Math.max(0, used - SLAB);
  const a1 = r3(s1 * R1);
  const a2 = r3(s2 * R2);
  const water = Math.ceil(a1 + a2);
  const total = water + MANJEERA + MNTS;
  if (total !== printedTotals[flat]) throw new Error(`Flat ${flat}: computed ${total}, sheet shows ${printedTotals[flat]}`);
  // Status left blank: payments are recorded in the app, not taken from this sample.
  rows.push([Number(flat), prev, present, used, s1, s2, R1, R2, a1, a2, Number(flat), water, MANJEERA, null, MNTS, total, null, Number(flat)]);
}
const billed = Object.values(printedTotals).reduce((a, b) => a + b, 0);
rows.push([]);
rows.push([null, null, 'Total Water Readings', readings.reduce((a, [, p, q]) => a + q - p, 0), null, null, null, 'Amount to be collected:', null, billed]);
rows.push([null, null, null, null, null, null, null, 'Collected Amount', null, 0]);
rows.push([null, null, 'Tanker Charges', 1500, null, null, null, 'Pending Amount', null, billed]);
rows.push(['Common water usage', null, null, null]);

mkdirSync('samples', { recursive: true });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'OCT 2026');
XLSX.writeFile(wb, 'samples/Oct-2026.xlsx');

// Parse it back exactly like the admin screen does.
const read = XLSX.read(readFileSync('samples/Oct-2026.xlsx'), { type: 'buffer' });
const aoa = XLSX.utils.sheet_to_json(read.Sheets[read.SheetNames[0]], { header: 1, raw: true, defval: null });
const draft = parseSheet(aoa, NARAYANADRI_TEMPLATE);
const month = draft.detectedMonth ?? '2026-10';
const now = '2026-11-01T00:00:00.000Z';
const bill = {
  month,
  title: 'Narayanadri Residency - October 2026 Maintenance',
  columns: draft.columns,
  flats: draft.flats,
  source: { fileName: 'Oct-2026.xlsx', sheetName: 'OCT 2026', kind: 'excel' as const, importedAt: now },
  publishedAt: now,
  publishedBy: 'seed',
  version: 1,
};
const v = validateBill(bill);
if (v.errors.length) throw new Error(v.errors.join('\n'));
if (v.warnings.length) console.warn(v.warnings.join('\n'));

const record: MonthRecord = {
  bill,
  payments: [],
  audit: [{ at: now, actor: 'seed', action: 'publish', month, details: 'Seeded from samples/Oct-2026.xlsx' }],
};
mkdirSync('public/data', { recursive: true });
writeFileSync(`public/data/${month}.json`, JSON.stringify(record, null, 2) + '\n');
writeFileSync('public/data/index.json', JSON.stringify({ months: [{ month, title: bill.title }] }, null, 2) + '\n');
console.log(`Wrote samples/Oct-2026.xlsx and public/data/${month}.json (${bill.flats.length} flats, month ${month}).`);
