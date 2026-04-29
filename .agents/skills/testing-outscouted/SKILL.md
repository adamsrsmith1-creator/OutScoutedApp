# Testing OutScouted App

## Local Development Server

Serve the app locally from the repo root:
```bash
cd /path/to/OutScoutedApp
python3 -m http.server 8080
```

Then access pages at `http://localhost:8080/`.

## App Structure

| File | Auth Required | Notes |
|------|--------------|-------|
| `outscouted_landing.html` | No | Marketing site, demo request form |
| `outscouted_login.html` | No | Email/password + Google sign-in |
| `outscouted_dashboard.html` | Yes (any user) | Redirects to login if unauthenticated |
| `outscouted_admin.html` | Yes (admin only) | Checks `adamsrsmith1@gmail.com`; redirects to login if unauthenticated |
| `OutScoutedAppv2.html` | No | Standalone scouting report generator |

## Firebase Integration

- **Project**: `outscouted-app`
- **Auth**: Email/password + Google sign-in via Firebase Auth
- **Database**: Firestore with collections: `users`, `reports`, `requests`, `preferences`, `demo_requests`
- **Auth guard**: Dashboard and admin pages use `onAuthStateChanged` to redirect unauthenticated users to `outscouted_login.html`

## Testing Constraints

### What you CAN test without credentials
- Landing page: full UI, demo request form submission (writes to `demo_requests` Firestore collection), navigation links
- Login page: UI renders, form validation (empty/invalid email)
- Auth guard behavior: dashboard and admin redirect to login when not authenticated
- Source code verification: grep for expected patterns, function existence, HTML structure
- Console error checks: open pages in browser and verify no JS errors before redirect

### What REQUIRES Firebase Auth credentials
- Dashboard sidebar navigation (e.g., verifying single Preferences entry visually)
- Dashboard report viewing, request creation, preference saving
- Admin panel: user management, demo request list, badge counts, report sending
- Any Firestore read/write operations behind auth

### Workaround: Source Verification
When UI testing is blocked by auth, verify changes via source code inspection:
```bash
# Check for specific elements
grep -n 'id="nav-prefs"' outscouted_dashboard.html

# Count occurrences of a pattern
grep -c 'Preferences' outscouted_dashboard.html

# Verify function existence
grep -n 'function escapeHtml' outscouted_admin.html
```

## Testing Checklist

1. **Start local server** and verify it serves files
2. **Landing page**: loads, links work, demo form validates and submits
3. **Login page**: loads, form validation works
4. **Auth guards**: dashboard and admin redirect to login
5. **Source verification**: check HTML structure and JS functions match expectations
6. **Console errors**: open each page in browser, check for JS errors
7. **Post results**: one comment on the PR with pass/fail for each assertion

## Common Issues

- **Firestore rules**: The `demo_requests` collection may need rules allowing unauthenticated writes for the landing page form to work
- **XSS risk**: Any user-writable Firestore data rendered via `innerHTML` should be sanitized with `escapeHtml()` — the `demo_requests.email` field is an example since unauthenticated users can write to it
- **Duplicate UI elements**: The app has evolved through multiple preference systems; watch for orphaned HTML/JS from older versions
- **Variable scoping**: `const` declarations inside `try` blocks are not accessible in `catch`/`finally` or after the block — use `let` before the `try` instead

## Devin Secrets Needed

No secrets are currently configured for testing. Full UI testing would benefit from:
- Firebase Auth credentials (email/password) for a test user account
- Admin access requires the `adamsrsmith1@gmail.com` account specifically
