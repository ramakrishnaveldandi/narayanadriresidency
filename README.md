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
| History | Every published month, for one flat or the whole apartment. **Admin only.** Admins can **delete a month** (with a reason and typed confirmation) to fix it and upload it again. Payments are kept. Residents always see the newest remaining month | FR-07 |
| Admin import | Upload Excel/CSV (or pick from Google Drive). Header and month are detected automatically. Column roles are mapped with a template, the grid can be edited, the data is validated, then published. Re-publishing needs a correction reason and is logged | FR-01, FR-08, §5 |
| Payments | Record verified payments (full or partial, several per month). Verify or reject resident submissions. Void with a reason. Duplicate UTRs are blocked | FR-06 |
| Reconcile | Upload a bank or UPI statement. Credits are matched to flats by UTR or by the flat number in the narration, then recorded or verified line by line | FR-06 |
| Reports & backup | Monthly `.xlsx` report (bill, balances, payments, meter details) and a full JSON backup | FR-08, NFR |
| Audit trail | Every publish, correction, payment, verification and void | §5, NFR |

**Business rules** (`src/app/core/billing.ts`)

- Outstanding = total due − verified, non-voided payments.
- Status is **Paid** when the outstanding amount is ≤ ₹1 (`paidTolerance`), **Partially Paid** when something has been paid,
  and **Pending** otherwise.
- Resident-submitted payments never count until an administrator verifies them.

## Monthly Excel import

Upload the association's workbook (`NR-WaterMeterReadings_2026.xlsx`, one sheet per month) or a single-sheet file. The app always reads **the file you upload**:

- **The latest month's sheet is selected automatically.** The month comes from the sheet name, e.g. `OCT 2026`. Every sheet is listed with its month, so you can pick an older one.
- **Columns are mapped by header name.** FLAT NO., PREVIOUS READING, PRESENT, TARE IN LTRS, the slab columns, rates, Total WATER CHARGES (Rounded), Manjeera Water Bill per Flat, MNTS CHARGES, `TOTAL` and `Status`. The 2019-20 layout is supported too.
- **Extra charges are picked up automatically.** Any column between the water charges and `TOTAL` becomes a bill line item, e.g. Septic Tank Expenses or Repair Manjeera. Columns to the right of `TOTAL` are ignored.
- **`TOTAL` is the amount due.** It is never "the last column". If the line items don't add up to it, you get a warning.
- **Notes and the summary block are skipped.** Rows below the table (Total Water Readings, Amount to be collected, Common water usage, Note:) are not treated as flats.
- **Status "P" means paid.** On publish, you can tick an option to mark those flats as Paid.
- **Month mismatches are flagged.** If the sheet name and the title row disagree on the month, you get a warning.

The column rules are in `NARAYANADRI_TEMPLATE` (`src/app/config/app-config.ts`). Keep the workbook itself out of this public repository; `.gitignore` excludes `NR-WaterMeterReadings*.xlsx`.

## Getting started

```bash
npm install
npm start            # http://localhost:4200
npm test -- --watch=false
npm run seed         # rebuilds samples/Oct-2026.xlsx and public/data/2026-10.json
```

## Who sees what

| User | Sees |
| --- | --- |
| Residents (no login) | Only the **latest** published month: the dashboard, flat details and Pay. No history and no month selector |
| Admin (`nrassociation123@gmail.com`, signed in with Google) | All months, history, and every admin screen |

The account is set in `admin.allowedEmail`, and the rule in `residentsSeeLatestMonthOnly` (both in
`src/app/config/app-config.ts`).

## Admin sign-in (Google), one-time setup

Do these steps signed in as **nrassociation123@gmail.com**:

1. Open https://console.cloud.google.com/ and create a project, for example *NR Maintenance*.
2. Go to **APIs & Services → OAuth consent screen** (also called *Google Auth Platform*).
   - App name: *Narayanadri Residency*. Support email: nrassociation123@gmail.com. Audience: **External**.
   - Under **Audience → Test users**, add `nrassociation123@gmail.com`. Testing mode is fine because only this one account
     signs in.
3. Go to **Credentials** (or **Clients**) → **Create credentials → OAuth client ID** → application type **Web application**.
   - **Authorized JavaScript origins**: `https://ramakrishnaveldandi.github.io` and `http://localhost:4200`
   - Leave the redirect URIs empty.
4. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). Paste it into `admin.googleClientId` in
   `src/app/config/app-config.ts`, then commit and push. A client ID is not a secret, so it's safe in a public repo.
5. Open the site → **Admin login** → **Sign in with Google**. Any other Google account is refused.

If you use the Apps Script backend, also set `GOOGLE_CLIENT_ID` (the same value) in its script properties.

## Data modes

**Static mode** (default, `apiUrl: ''`)

- Published months are `public/data/index.json` and `public/data/YYYY-MM.json`, committed to the repo.
- The admin's changes (imports and payments) are saved in that admin's browser. They go live after **Reports & backup →
  Download data files**, committing the files to `public/data/`, and pushing.
- This mode needs zero setup and costs nothing. **Limitation:** the Google sign-in check and the latest-month-only rule run
  in the browser. Residents never see older months in the app. But every month's file sits on the public site
  (`data/2026-10.json`), so someone who knows the URL can download it. A static site cannot hide files (SRS §6).

**API mode** (`apiUrl` set to a Google Apps Script web app). See [`backend/apps-script/README.md`](backend/apps-script/README.md).

- Data lives in a Google Sheet. The server verifies the admin's Google sign-in on every admin request and only gives older
  months to the admin, so the restriction is real. Residents can submit UTRs, and you can import from Google Drive.

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
- Months are imported from the **Excel sheet** only. Image upload and OCR were removed because Excel is exact and faster. Keep the same column layout each month; if it changes, adjust the column mapping on the import screen.

## Project layout

```
src/app/config/app-config.ts    apartment, UPI, visibility, import template
src/app/core/                   models, billing rules, Excel parsing, UPI URI, data and auth services
src/app/pages/                  dashboard, flat detail, pay, history
src/app/pages/admin/            login, import, payments, reconcile, reports, audit
public/data/                    published months (static mode)
backend/apps-script/            optional Google Sheets + Drive backend
samples/Oct-2026.xlsx           October 2026 sheet (sample for testing the import)
scripts/seed-oct-2026.ts        builds the sample and the seed JSON
```
