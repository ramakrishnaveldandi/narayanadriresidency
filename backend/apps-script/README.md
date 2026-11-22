# Apps Script backend (optional)

The web app works without this backend ("static mode": published months are JSON files in `public/data/`).
Connect the backend when you want:

- residents to submit UPI transaction references from the Pay screen,
- several administrators to record and verify payments from any device,
- admin access protected by a passphrase that is checked on the server,
- importing files straight from a Google Drive folder.

It is free: a Google Sheet plus Google Apps Script, both within the normal Google account quotas.

## Setup (about 10 minutes)

1. Sign in with the association's Google account and create a new Google Sheet, for example **NR Maintenance Data**.
2. In the sheet open **Extensions → Apps Script**.
3. Replace `Code.gs` with [`Code.gs`](Code.gs) from this folder. In **Project Settings** tick *Show "appsscript.json"* and
   replace it with [`appsscript.json`](appsscript.json).
4. **Project Settings → Script properties**, add:
   - `ADMIN_KEY`: a long passphrase for administrators. Share it only with committee members.
   - `DRIVE_FOLDER_ID`: (optional) the ID of the Drive folder that holds the monthly Excel files and images. The ID is the
     last part of the folder URL.
5. Run the `setup` function once from the editor. It creates the `Months`, `Bills`, `Payments` and `Audit` tabs. Approve the
   permissions prompt.
6. **Deploy → New deployment → Web app**. Set *Execute as*: **Me**, *Who has access*: **Anyone**. Copy the web app URL.
7. Put that URL in `src/app/config/app-config.ts` → `apiUrl`, commit and push. The GitHub Pages workflow redeploys the site.
8. Log in to **Admin** with the `ADMIN_KEY` and publish the first month. To bring October 2026 across, import
   `samples/Oct-2026.xlsx`.

After you edit `Code.gs`, use **Deploy → Manage deployments → Edit → New version**. That keeps the same URL.

## Security notes

- The frontend never contains the admin passphrase. Every write action checks `ADMIN_KEY` on the server.
- `submitPayment` is the only public write. It stores an **unverified** entry, which never reduces a balance until an
  administrator verifies it. Duplicate transaction references are rejected.
- Month data (amounts and statuses) can be read by anyone who has the URL. This matches the "public access" choice in the
  SRS. If you later restrict visibility, add a check to `doGet`.
- Nothing is ever deleted. Corrections bump the month version, voids keep the original row, and every change is written to
  `Audit`.
- Back up regularly with **File → Download → .xlsx** on the sheet, or **Admin → Reports & backup → Download full backup**.
