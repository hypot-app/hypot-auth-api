# Browser smoke test

A manual check that a real browser can run the whole Auth flow against the local stack: signup, confirm from a mail link, login, preflight, wrong-origin block, two-tab refresh, logout, forgot and reset, and no cookies. Run it in Chromium, Firefox and Safari before the pilot app goes live. The automated suite cannot prove browser behaviour (CORS enforcement, the address bar, DevTools storage), which is why this exists.

**Status: awaiting a run by the maintainer.** Record the results in the table at the end and in the `auth-service` apply-progress.

## Quick path

1. Start the stack (see the README): `docker compose up -d --build`. Mailpit is at http://localhost:8025.
2. Register the smoke app. The email URLs carry the page in the query because a static server has no `/confirm` route; Auth appends `#token=...` after it.

   ```bash
   docker compose run --rm api dist/cli.js app create --name "Smoke SPA" \
     --origin http://localhost:5173 \
     --email-confirmation-url "http://localhost:5173/index.html?page=confirm" \
     --password-reset-url "http://localhost:5173/index.html?page=reset"
   ```

   Copy the printed `client_id`.
3. Serve the page: `python -m http.server 5173 --directory docs/smoke` (any static file server works).
4. Open http://localhost:5173/index.html, paste the `client_id` and follow the checklist below with DevTools open (Network and Application tabs, "Preserve log" on).

## Checklist

Run the steps in order, with a fresh email address per browser (`smoke-chromium@example.com`, and so on).

| # | Step | Expected |
|---|------|----------|
| 1 | Press **Signup** | `202` with the fixed message. Mailpit shows one confirmation email. |
| 2 | Open the link in the email | The address bar shows `index.html?page=confirm` with **no** `#token=...`. The page says the link token was captured and removed. |
| 3 | Press **Confirm** | `200 Your email address has been confirmed.` Mailpit shows a welcome email. Press **Confirm** again: `400 invalid_or_expired_link`. |
| 4 | Press **Login** | `200` with `access_token`, `refresh_token`, `expires_in: 3600`. Press **GET /me**: `200` with exactly `id`, `email`, `email_verified`, `created_at`. |
| 5 | In Network, find the `OPTIONS` call before the first `POST` | `204`, with `Access-Control-Allow-Origin: http://localhost:5173`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`, `Access-Control-Max-Age: 600`, `Vary: Origin`. No `Access-Control-Allow-Credentials`. |
| 6 | Open http://127.0.0.1:5173/index.html (same server, a different origin), paste the `client_id`, press **Login** | The browser blocks it: the log shows `NETWORK/CORS ERROR` and the console shows a CORS error. No token appears. |
| 7 | Back on the `localhost` page, open a **second tab** of it (same browser). In both tabs press **Refresh x5 (parallel)** at about the same time | Every call is `200`. The session survives (**GET /me** still works afterwards, and **Refresh** is still `200`). The lock serializes the refreshes across tabs. |
| 8 | Press **Logout** | `204`. Press **Refresh**: `401 invalid_grant`. |
| 9 | Press **Forgot password** (logged out) | `202`. Mailpit shows a reset email whose link is `index.html?page=reset#token=...`. |
| 10 | Open the reset link, press **Reset** | `204`. **Login** with the old password: `401 invalid_credentials`. Log in again with the new password (edit the Password field): `200`. |
| 11 | DevTools, Application, Cookies, for `localhost:3000` and `localhost:5173`; and Network, response headers of every call | No cookies. No `Set-Cookie` header on any response. |

## What each step proves

| Steps | Property |
|-------|----------|
| 2 | The token in the fragment never reaches a server, and the app clears it before anything else runs |
| 5, 6 | CORS is bound to the app: a registered origin is allowed and any other origin is blocked by the browser itself |
| 7 | One refresh in flight across tabs, so rotation never presents a used token |
| 8, 10 | Logout and password reset end the session |
| 11 | The API is cookie-free |

## Browser notes

| Browser | Watch for |
|---------|-----------|
| Chromium | Console CORS errors name the missing header. Use them to confirm step 6. |
| Firefox | Same checks. Strict tracking protection does not affect these calls. |
| Safari | `navigator.locks` needs Safari 15.4 or newer. A private window clears `localStorage` when closed. Use the Develop menu for the Network tab. |

## Results

Fill in one row per browser and keep the file in the PR.

| Browser and version | Date | Steps 1-11 | Failures and notes |
|---------------------|------|------------|--------------------|
| Chrome 154.0.8037.98 (64-bit), Windows 11 | 2026-10-09 | 1-11 passed | Step 6 showed the expected CORS block (401 with no allow header). Step 7 overlapped the two tabs with a delayed click from the console. |
| Firefox | | | |
| Safari | | | |

## Clean up

Stop the static server, then `docker compose down -v` to discard the database and the dev keys. Deactivate the smoke app first if you ran this against a shared instance: `docker compose run --rm api dist/cli.js app deactivate <client_id>`.
