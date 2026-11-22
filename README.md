# Narayanadri Residency – Maintenance Payment System

An Angular web app for monthly apartment maintenance. Residents can see their flat's bill, pay over UPI with an app
hand-off or a QR code, and track payments. It is built from
[`Apartment_Maintenance_Payment_System_SRS.pdf`](Apartment_Maintenance_Payment_System_SRS.pdf) and hosted free on
GitHub Pages.

## Features

| Area | What it does | SRS |
| --- | --- | --- |
| Dashboard | Month selector, flats grouped by floor, totals for billed, collected and outstanding, paid/partial/pending counts, flat search | FR-03 |
| Flat details | Bill breakdown (water, Manjeera, maintenance), meter-reading details, total due, verified payments, balance, link back to the source row | FR-04 |
| Pay | UPI deep link (`upi://pay`) with payee, amount and note pre-filled. QR code generated for that amount. Copy the UPI ID. Association's printed QR as a fallback. Partial amounts allowed | FR-05 |
| Payment proof | Resident enters the UTR. It goes to the backend (API mode) or into a pre-filled WhatsApp message (static mode). Stays "awaiting verification" until an admin checks it | FR-05/06, §9 |
| History | Every published month, for one flat or the whole apartment | FR-07 |
| Admin import | Upload Excel/CSV (or pick from Google Drive). Header and month are detected automatically. Column roles are mapped with a template, the grid can be edited, the data is validated, then published. Re-publishing needs a correction reason and is logged | FR-01, FR-08, §5 |
| Image months | Upload the sheet photo and enter the figures beside it, starting from the previous month's flats and fixed charges. OCR is not enabled yet | FR-02 (partial) |
| Payments | Record verified payments (full or partial, several per month). Verify or reject resident submissions. Void with a reason. Duplicate UTRs are blocked | FR-06 |
| Reconcile | Upload a bank or UPI statement. Credits are matched to flats by UTR or by the flat number in the narration, then recorded or verified line by line | FR-06 |
| Reports & backup | Monthly `.xlsx` report (bill, balances, payments, meter details) and a full JSON backup | FR-08, NFR |
| Audit trail | Every publish, correction, payment, verification and void | §5, NFR |

**Business rules** (`src/app/core/billing.ts`)

- Outstanding = total due − verified, non-voided payments.
- Status is **Paid** when the outstanding amount is ≤ ₹1 (`paidTolerance`), **Partially Paid** when something has been paid,
  and **Pending** otherwise.
- Resident-submitted payments never count until an administrator verifies them.

## How the Oct-2026 sheet is read

The sheet has three columns called "Total": litres used, the water charge, and the final **TOTAL**. The import does not
assume that the last column is the total. A column template (`NARAYANADRI_TEMPLATE` in `src/app/config/app-config.ts`) maps
the columns like this:

| Source column | Used as |
| --- | --- |
| FLAT (1st) | Flat number |
| PREVIOUS, PRESENT, Total (1st), SLAB I, SLB II Ltrs, Slab I ₹, Slab II ₹ | Info (shown under "Water meter & calculation details") |
| Total (2nd) | Expense: Water Charges |
| Manjeera | Expense: Manjeera Water |
| MNTS | Expense: Maintenance |
| TOTAL (3rd) | Total due |
| Per Ltr, FLAT (2nd) | Ignored |

For the rows where all three exist, the importer warns when the line items do not add up to the total. The water charge
works out to `ceil(min(litres, 15000) × 0.0279 + max(0, litres − 15000) × 0.0321)`. The seed script checks that rule against
all 30 flats on the sheet.

Other layouts still work. When there is no template match, the importer looks for a "Flat" header and a single "Total"-like
column, and the admin can change any column's role on the import screen.

## Getting started

```bash
npm install
npm start            # http://localhost:4200
npm test -- --watch=false
npm run seed         # rebuilds samples/Oct-2026.xlsx and public/data/2026-10.json
```

Admin login in static mode: passphrase `narayanadri-admin`. **Change it before you go live.** Put the SHA-256 of the new
passphrase in `staticAdminPassphraseSha256`:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('YOUR-PASSPHRASE').digest('hex'))"
```

## Data modes

**Static mode** (default, `apiUrl: ''`)

- Published months are `public/data/index.json` and `public/data/YYYY-MM.json`, committed to the repo.
- The admin's changes (imports and payments) are saved in that admin's browser. They go live after **Reports & backup →
  Download data files**, committing the files to `public/data/`, and pushing.
- This mode needs zero setup and costs nothing. The admin passphrase here is only a convenience gate, because static hosting
  cannot keep a secret (SRS §6).

**API mode** (`apiUrl` set to a Google Apps Script web app). See [`backend/apps-script/README.md`](backend/apps-script/README.md).

- Data lives in a Google Sheet, admin writes are checked on the server, residents can submit UTRs, and you can import from
  Google Drive.

## Deploying to GitHub Pages

`.github/workflows/deploy.yml` tests, builds and deploys every push to `main`.

1. Repository **Settings → Pages → Source: GitHub Actions**.
2. Merge to `main`. The site is published at `https://<user>.github.io/narayanadriresidency/`.

The app uses hash URLs (`#/flat/101`), so deep links work on Pages without any 404 workaround.

## Configuration (`src/app/config/app-config.ts`)

| Setting | Current value |
| --- | --- |
| `upi.payeeVpa` | `Narayanadriassociation@oktgb` (from the association QR poster) |
| `upi.payeeName` | `Narayanadri Residency` |
| `contactWhatsApp` | `917382148944` (number printed on the QR poster). Empty hides the button |
| `visibility` | `full` (amounts and status on the dashboard). Other options: `amounts`, `flats-only` |
| `paidTolerance` | `1` rupee |
| `apiUrl` | empty (static mode) |

## Important limitations (SRS §9)

- A UPI link or QR code only **starts** a payment. The app is never told whether it succeeded. Balances change only when an
  administrator records or verifies a payment.
- Some UPI apps limit pre-filled amounts when paying a personal (non-merchant) UPI ID. If that happens, residents can scan
  the printed QR and type the amount. Test with Google Pay, PhonePe and Paytm before launch.
- OCR for photographed sheets is not included yet (phase 6). Image months are entered by hand beside the image.

## Project layout

```
src/app/config/app-config.ts    apartment, UPI, visibility, import template
src/app/core/                   models, billing rules, Excel parsing, UPI URI, data and auth services
src/app/pages/                  dashboard, flat detail, pay, history
src/app/pages/admin/            login, import, payments, reconcile, reports, audit
public/data/                    published months (static mode)
backend/apps-script/            optional Google Sheets + Drive backend
samples/Oct-2026.xlsx           October 2026 sheet rebuilt from Oct-2026.jpeg
scripts/seed-oct-2026.ts        builds the sample and the seed JSON
```
