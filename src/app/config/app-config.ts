import type { ImportTemplate } from '../core/excel-import';

/**
 * Dashboard visibility policy (SRS section 12 - open decision).
 *  - 'full'       : flat cards show amount due and payment status
 *  - 'amounts'    : flat cards show amount due only (no payment status)
 *  - 'flats-only' : flat cards show only flat numbers; details are shown after selecting a flat
 */
export type Visibility = 'full' | 'amounts' | 'flats-only';

/**
 * Column mapping for the Narayanadri Residency monthly sheet
 * (FLAT | PREVIOUS | PRESENT | Total | SLAB I | SLB II Ltrs | Per Ltr | Per Ltr |
 *  Slab I | Slab II | FLAT | Total | Manjeera | MNTS | TOTAL).
 * The sheet has three "Total" columns, so the final one is mapped explicitly
 * instead of assuming "last column = total" (SRS section 5).
 */
export const NARAYANADRI_TEMPLATE: ImportTemplate = {
  name: 'Narayanadri monthly maintenance sheet',
  rules: [
    { match: '^flat', occurrence: 1, role: 'flat', label: 'Flat' },
    { match: '^flat', occurrence: 2, role: 'ignore' },
    { match: '^previous', role: 'info', label: 'Previous Meter Reading' },
    { match: '^present', role: 'info', label: 'Present Meter Reading' },
    { match: '^total$', occurrence: 1, role: 'info', label: 'Water Consumed (Ltrs)' },
    { match: '^slab i$', occurrence: 1, role: 'info', label: 'Slab I Usage (Ltrs)' },
    { match: '^sla?b ii ltr', role: 'info', label: 'Slab II Usage (Ltrs)' },
    { match: '^per ltr', role: 'ignore' },
    { match: '^slab i$', occurrence: 2, role: 'info', label: 'Slab I Water Charge (₹)' },
    { match: '^slab ii$', occurrence: 1, role: 'info', label: 'Slab II Water Charge (₹)' },
    { match: '^total$', occurrence: 2, role: 'expense', label: 'Water Charges' },
    { match: '^manjeera', role: 'expense', label: 'Manjeera Water' },
    { match: '^(mnts|maint)', role: 'expense', label: 'Maintenance' },
    { match: '^total$', occurrence: 3, role: 'total', label: 'Total Due' },
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
  apiUrl: '',

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
    googleClientId: '',
  },

  /** Residents see only the most recent published month; the admin sees every month. */
  residentsSeeLatestMonthOnly: true,

  importTemplate: NARAYANADRI_TEMPLATE,
};
