# Apps Script backend (Google Sheet + Google Drive)

Everything runs in the association's Google account, **nrassociation123@gmail.com**, and is free.

## What it gives you

- **Data that is never lost.** Monthly bills live in Google Drive. Payments, the audit trail and analytics live in a Google
  Sheet. Redeploying the website never touches them.
- **Monthly files in Drive.** When the admin publishes a month from the app, the uploaded Excel file and the reviewed data
  (`<month>.json`) are saved in `NR Maintenance/Latest`, and the previous month's files move to `NR Maintenance/History`.
  **The residents' screens are served from these Drive files.**
- **Residents see only the latest month.** This is enforced on the server. Residents can also download the original Excel
  sheet from the dashboard.
- **Admin access checked through Google sign-in.** Only nrassociation123@gmail.com is accepted.
- **Instant updates.** Residents can submit payment references, and admin payments and verifications are saved immediately
  from any device.
- **Analytics.** The `BillLines` tab holds one row per flat per line item per month, ready for pivot tables or Looker Studio.

## Where things are stored

```
Google Drive of nrassociation123@gmail.com
└── My Drive
    ├── NR Maintenance Data          ← Google Sheet (bills, payments, audit, analytics)
    └── NR Maintenance/              ← created automatically by setup()
        ├── (drop files here)        ← optional: import from the app with "Browse Google Drive"
        ├── Latest/                  ← newest month: "2026-11 Nov-2026.xlsx" + "2026-11.json"
        └── History/                 ← older months:  "2026-10 Oct-2026.xlsx" + "2026-10.json", …
```

- `<month> <name>.xlsx` is the Excel sheet exactly as the admin uploaded it, kept as the original record.
- `<month>.json` is the reviewed data the admin confirmed in the app. This is what residents see. Don't edit or rename these
  files by hand; publish a correction from the app instead.

Sheet tabs: `Payments`, `Audit`, `BillLines`.

## Setup (about 15 minutes, signed in as nrassociation123@gmail.com)

1. **Create the Google client ID** for "Sign in with Google" (main README → *Admin sign-in*). You need this value in steps 4
   and 7.
2. In Google Drive, choose **New → Google Sheets** and name it **NR Maintenance Data**.
3. In the sheet, open **Extensions → Apps Script**.
   - Replace the contents of `Code.gs` with [`Code.gs`](Code.gs).
   - Go to **Project Settings (gear)**, tick *Show "appsscript.json" manifest file in editor*, then replace that file with
     [`appsscript.json`](appsscript.json).
4. Go to **Project Settings → Script properties → Add script property**:
   - `GOOGLE_CLIENT_ID`: the client ID from step 1.
   - `ADMIN_EMAIL`: `nrassociation123@gmail.com`.
5. Back in the editor, choose the **`setup`** function in the toolbar and click **Run**. Approve the permissions (Sheets,
   Drive, external requests). If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. It's your
   own script. `setup` creates the sheet tabs and the `NR Maintenance / Latest / History` folders, and prints their links
   under **Execution log**.
6. Click **Deploy → New deployment**, select type **Web app**, set *Execute as*: **Me (nrassociation123@gmail.com)** and
   *Who has access*: **Anyone**, then **Deploy**. Copy the **Web app URL**. It ends with `/exec`.
7. Send that URL and the client ID to the developer, or put them yourself in `src/app/config/app-config.ts`: `apiUrl` and
   `admin.googleClientId`. Commit and push to `main`. GitHub Pages redeploys in a few minutes.
8. On the website, go to **Admin login → Sign in with Google (nrassociation123@gmail.com) → Import month** and upload
   `samples/Oct-2026.xlsx` to publish October 2026 into Drive.

After any later change to `Code.gs`, use **Deploy → Manage deployments → Edit (pencil) → Version: New version →
Deploy**. That keeps the same URL.

## Monthly routine for the admin

1. Go to **Admin → Import month** and upload the new month's Excel file. You can also put it in
   `NR Maintenance` in Drive and use **Pick from Google Drive**.
2. Check the figures and click **Publish**. The file goes to `Latest`, last month's file moves to `History`, and residents
   immediately see the new month.
3. As money arrives, use **Admin → Payments** to record payments or verify UTRs from residents, or upload the bank
   statement in **Reconcile**.

## Deleting a month

Admin → History → **Delete** (asks for a reason and for the month to be typed) does the following:
- moves that month's `<month>.json` and Excel file to the **Google Drive Trash**, where they can be restored for 30 days
- keeps its payments and audit entries in the sheet; they come back when the month is uploaded again
- if it was the latest month, moves the previous month's files from `History` back to `Latest`, so residents see the newest remaining month

## Security notes

- Every admin request carries the Google ID token. The server checks it with Google (`tokeninfo`): it must be issued to
  `GOOGLE_CLIENT_ID`, unexpired, and belong to `ADMIN_EMAIL`. No passwords are stored anywhere.
- Without admin sign-in, the API returns **only the latest month**. Residents can submit payment references only for the
  latest month, and these stay **unverified** until the admin verifies them. Duplicate UTRs are rejected.
- Drive files are only read from or moved within the `NR Maintenance` folder. The script runs as the association account,
  so the folders are never shared publicly. Residents get the latest month through the script only.
- Nothing is ever deleted. Corrections bump the month version, voids keep the original row, every change is written to
  `Audit`, and old source files stay in `History`.
- Backups: on the sheet, use **File → Download → .xlsx**, or in the app use **Admin → Reports & backup → Download full
  backup**.
