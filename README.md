# Field Attendance V2 — Functional Web/PWA Edition

## What works

- PostgreSQL database initialization and migration at API startup, preserving the existing Docker named volume when the original Compose project name is `field-attendance-starter`.
- Administrator account bootstrap from `.env`, user signup/login/logout, session cookies, password change, role-based access, account activation, admin user editing.
- User check-in and check-out, GPS capture, before/after multi-photo upload, notes, attendance history.
- IndexedDB offline queue for check-in/out actions and compressed photos, retry on network restoration, manual submit button, duplicate-safe UUID records and photo IDs.
- Admin dashboard metrics, user management, site creation, attendance records, photos, map links, search, CSV export, audit events.
- Responsive installable web app for Android/iOS, Windows/macOS browsers, service-worker app-shell caching.

## Important limitations

This is a **working source implementation**, not a verified production release. The environment used to assemble this ZIP does not have Docker and could not run the end-to-end database or mobile-browser tests. No Android APK or native iOS app is included; mobile access is via a PWA. Native app-store distribution, production email password recovery, full background sync on iOS, push alerts, scheduled backups, sophisticated photo malware scanning, and automated high-load testing are NOT included. Do not expose it publicly without a security review and HTTPS configuration.

Offline capture requires that the user has logged in at least once on the device and installed/opened the web app previously. **After logout, offline capture is unavailable**. Mobile browsers may clear offline data under storage pressure. Keep the app installed and never clear its site data while uploads are pending. iOS may suspend background activity; foreground or manual sync is supported.

## Updated workflow in this release

- Check-in and check-out are separate steps. A new point is blocked until the active point is checked out.
- GPS and at least one live camera photo are required for both actions; notes are optional. The app opens the device camera through `getUserMedia` and does not offer a gallery/file-picker upload for these fields. Camera and GPS require HTTPS on phones.
- A Check Out button is displayed beside every active check-in. Attendance details present the complete check-in section before the check-out section.
- The API rejects submissions without GPS, check-in location, or check-out location; the client validates photos before queueing. Existing PostgreSQL data is migrated automatically with new check-out location and separate notes columns.
- Static app assets are cached for offline reopening after a device has visited the app once. This does not make a PC-hosted server available when the PC is powered off.

## Windows 11: update your existing starter without losing PostgreSQL data

1. **Back up first:** In the old starter folder run `docker compose exec -T db pg_dump -U attendance_app -d attendance > attendance-backup.sql` if those are your actual database user/name. Also back up `storage/uploads`.
2. In the old project folder run `docker compose down` (**NEVER use `-v`**). This preserves named volumes.
3. Extract V2 into a NEW folder. Copy the old `.env` file into the new folder; add `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ chars) and `COOKIE_SECURE=false`. Set `API_PORT=8080` or your existing port. Avoid changing database credentials when reusing the existing volume.
4. This Compose file declares `name: field-attendance-starter`, which matches the old default project name if its directory was `field-attendance-starter`. Verify the old volume with `docker volume ls` before starting. If the old project had a different Compose project name, **STOP and adjust the new Compose name** or use the old folder name before starting. Otherwise a fresh empty database volume will be created.
5. Run `powershell -ExecutionPolicy Bypass -File .\scripts\INSTALL_WINDOWS.ps1` from the V2 folder, or `docker compose up -d --build`.
6. Check `docker compose ps`, `docker compose logs api --tail=100`, and `http://localhost:8080/health`.
7. Visit `http://localhost:8080`, sign in using your configured admin credentials. Create a separate worker using Sign Up and test check-in/out. No fake demo records are inserted.

## macOS

Install and start Docker Desktop. Copy `.env.example` to `.env`, replace placeholders, then `sh scripts/INSTALL_MAC.sh`. Open `http://localhost:8080`.

## Make the phone app work while the PC is off

The current Docker deployment runs the API and PostgreSQL on the PC. If that PC is shut down, the server and database are unavailable; cached app files may open on devices that visited before, but records cannot be loaded or synced. A first-time user cannot load the app shell from a powered-off PC. **The real fix is to host the app and database on an always-on server** (a cloud VPS or managed hosting), configure a domain and HTTPS, and point the phone users to that URL. Keep PostgreSQL private; expose only HTTPS through a reverse proxy, and back up the database and uploads. Do not simply expose port 8080 to the public internet.

For a temporary office-only setup, keep the PC on, disable sleep, use a stable LAN IP and HTTPS reverse proxy, and ensure phones have network access. This is not an internet-accessible or power-off solution.

## iOS / Android PWA

For mobile installation and location permissions, the app **must be served over HTTPS** from a stable, secure endpoint (localhost is a desktop development exception). Safari on iOS: Share > Add to Home Screen. Android Chrome: Install app / Add to Home Screen. Do not forward port 8080 directly to the internet. Configure TLS, access controls, security review, and a stable tunnel/reverse proxy first. The app does not ask users to enter a LAN IP.

## Database and backup

The database SQL is applied at every API startup using `CREATE TABLE IF NOT EXISTS` and compatible `ALTER TABLE` statements. Data persists in the Docker `pgdata` named volume. Photos persist in `storage/uploads`. Both must be backed up together. Passwords are hashed with scrypt. Session tokens are stored as SHA-256 hashes. Never share `.env` or publicize the dashboard before reviewing deployment security.

## Known technical constraints

- Server API must be reachable for the initial login; cached user state is used for later offline form capture.
- The current client queue processes actions in timestamp order. Offline photos upload after the parent record is confirmed. Background sync is best effort when the PWA is open, not guaranteed when it is closed.
- The upload endpoint accepts JPEG/PNG/WebP up to 8 MB each. Client compression targets a few hundred KB but complex images can exceed this.
- Administrator password changes in `.env` do not reset an existing admin's password. Use the account Settings page while signed in.
- Cross-platform support is for Docker server and web/PWA. This ZIP does not contain a Flutter project or native APK.

## Useful commands

```powershell
docker compose ps
docker compose logs api --tail=100
docker compose exec db pg_isready -U attendance_app -d attendance
docker compose down   # preserves database volume
```

## Acceptance checks

1. Login as admin and verify summary, user list, sites, and CSV export.
2. Sign up a worker, check in with GPS and two photos, then check out with two more photos.
3. Confirm the record and images are visible in Admin > Attendance Records.
4. Turn off connectivity after signing in, save a new record, confirm Pending status, reconnect and press Submit to Database.
5. Refresh the admin view and confirm record/photo synchronization.
6. Restart Docker and confirm existing records persist.

Do not enter real employee personal data until all tests pass and your security/privacy review is complete.


## R6 UI and database update

This revision simplifies the mobile Check In / Check Out forms, adds a View action to each attendance row, promotes dashboard Check In / Check Out actions, resets failed queue/photo status to Pending when the app starts, and expands startup `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migrations for attendance fields.

### Rebuild safely

1. Back up PostgreSQL and `storage/uploads` before deployment.
2. Keep the existing `.env` and existing Docker Compose project/volume names.
3. Run `docker compose up -d --build` from this project folder. The backend runs idempotent schema migrations at startup.
4. Check `docker compose logs --tail=200 app` (or the backend service name in your Compose file) and verify `/health` before testing a new check-in and check-out.
5. Do not use `docker compose down -v` during an update; it can delete the database volume.
#   f i e l d - a t t e n d a n c e  
 