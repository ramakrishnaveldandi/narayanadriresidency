import type { ImportTemplate } from '../core/excel-import';

/**
 * Dashboard visibility policy (SRS section 12 - open decision).
 *  - 'full'       : flat cards show amount due and payment status
 *  - 'amounts'    : flat cards show amount due only (no payment status)
 *  - 'flats-only' : flat cards show only flat numbers; details are shown after selecting a flat
 */
export type Visibility = 'full' | 'amounts' | 'flats-only';

/**
 * Column mapping for the Narayanadri monthly maintenance sheet (NR-WaterMeterReadings workbook).
 * Rules match the normalised header text (lower case, punctuation removed), e.g.
 *   FLAT NO. | PREVIOUS READING | PRESENT | Total TARE IN LTRS | SLAB I Ltrs ( Up to 15k) |
 *   SLB II Ltrs( Above 15k) | Per Ltr in NP Slab I | Per Ltr in NP Slab II | Slab I Charges |
 *   Slab II Charges | FLAT NO. maintaince stataus | Total WATER CHARGES (Rounded) |
 *   Manjeera Water Bill per Flat | <extra charges…> | MNTS CHARGES | TOTAL | Status
 * Older sheets (2019-20: SERVICE NO., TARE IN LTRS, one rate, WATER CHARGES) match too.
 * Columns not listed here that sit between the water charges and TOTAL become extra
 * charges automatically (Septic Tank Expenses, Repair Manjeera, …); columns right of
 * TOTAL are ignored. The final total is the column headed exactly "TOTAL".
 */
export const NARAYANADRI_TEMPLATE: ImportTemplate = {
  name: 'Narayanadri monthly maintenance sheet',
  rules: [
    { match: '^flat', occurrence: 1, role: 'flat', label: 'Flat' },
    { match: '^flat', occurrence: 2, role: 'ignore' },
    { match: '^service', role: 'info', label: 'Service No.' },
    { match: '^previous', role: 'info', label: 'Previous Meter Reading' },
    { match: '^present', role: 'info', label: 'Present Meter Reading' },
    { match: '^(total )?tare', role: 'info', label: 'Water Consumed (Ltrs)' },
    { match: '^slab i ltrs', role: 'info', label: 'Slab I Usage (Ltrs, up to 15k)' },
    { match: '^sla?b ii ltrs', role: 'info', label: 'Slab II Usage (Ltrs, above 15k)' },
    { match: '^per ltr', occurrence: 1, role: 'info', label: 'Rate - Slab I (₹ per Ltr)' },
    { match: '^per ltr', occurrence: 2, role: 'info', label: 'Rate - Slab II (₹ per Ltr)' },
    { match: '^slab i charges', role: 'info', label: 'Slab I Water Charge (₹)' },
    { match: '^slab ii charges', role: 'info', label: 'Slab II Water Charge (₹)' },
    { match: '^(total )?water charges', role: 'expense', label: 'Water Charges' },
    { match: '^manjeera', role: 'expense', label: 'Manjeera Water' },
    { match: '^(mnts|maint)', role: 'expense', label: 'Maintenance' },
    { match: '^total$', occurrence: 1, role: 'total', label: 'Total Due' },
    { match: '^status$', occurrence: 1, role: 'status', label: 'Status' },
  ],
};

export const APP_CONFIG = {
  apartmentName: 'Narayanadri Residency',

  upi: {
    /** Must be confirmed by the association before production use (SRS section 9). */
    payeeVpa: 'Narayanadriassociation@oktgb',
    payeeName: 'Narayanadri Residency',
    bankName: 'Telangana Grameena Bank',
    /** Short prefix for the UPI transaction note, e.g. "NR Maint Oct-2026 Flat 101". */
    notePrefix: 'NR Maint',
    /** Association's printed QR (no amount) - shown as a fallback. File lives in /public. */
    staticQrImage: 'upi-qr.jpeg',
  },

  /** WhatsApp number (country code, no +) residents can send payment references to. Empty to hide. */
  contactWhatsApp: '917382148944',

  visibility: 'full' as Visibility,

  /**
   * Google Apps Script web-app URL (see backend/apps-script/README.md).
   * Empty = "static mode": data is read from /public/data/*.json and admin
   * changes are kept in the browser until exported and committed.
   */
  apiUrl: 'https://script.google.com/macros/s/AKfycbwUZFKv7ydb9QtaHYsOoIKwlNwrf65tXWvcGBz-nlEBnQsmSax1Zd8EsBPwWM0wroRwWg/exec',

  /** Folder under /public holding static month files. */
  dataPath: 'data',

  /** Outstanding amounts at or below this many rupees count as Paid. */
  paidTolerance: 1,

  admin: {
    /** The only account allowed into the admin area ("Sign in with Google"). */
    allowedEmail: 'nrassociation123@gmail.com',
    /**
     * OAuth 2.0 Web client ID from Google Cloud Console (see README "Admin sign-in").
     * Client IDs are public identifiers - safe to commit. Empty = sign-in disabled.
     */
    googleClientId: '676920536127-mns7efgbh83rg768ro6ebom4uiufukoa.apps.googleusercontent.com',
  },

  /** Residents see only the most recent published month; the admin sees every month. */
  residentsSeeLatestMonthOnly: true,

  importTemplate: NARAYANADRI_TEMPLATE,
};
