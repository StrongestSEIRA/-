# SHIORI Codex development instructions

## Source of truth
- Read `SPEC.md`, `TASKS.md`, and the existing source before changing anything.
- Treat implementation and automated tests as evidence; README claims and test names are not proof that production currently works.
- Never infer production Supabase/Render configuration from committed examples.
- Keep all user-facing copy in Japanese unless requested otherwise.

## Safety
- Preserve existing user data. Never run `db/schema.sql` against an existing database; it is a historical snapshot, not an idempotent migration.
- No production DB mutations, user creation/deletion, password resets, live-email sends, storage cleanup, deployment changes, or secret rotation without explicit approval.
- Never commit credentials, access tokens, personal reading notes, real email addresses, or snapshots. Avoid printing secrets.
- Keep `SUPABASE_SECRET_KEY` server-only; confirm all user data is scoped to an authenticated account.
- The app currently creates accounts without email-ownership verification. Do not silently change or extend this policy; flag the account-takeover/ownership risks and request a security review before public rollout.
- Do not use live Supabase/Render for routine tests. Prefer isolated mock or local tests.

## Development workflow
1. Read the relevant code and specify the user-visible success criteria.
2. Create a scoped branch from `develop`, not from the empty `main`.
3. Make the smallest change consistent with `SPEC.md`.
4. Add or update tests for success, failure, permissions, and data integrity.
5. Execute relevant tests; report exact commands and pass/fail. Do not claim a test was run if it was not.
6. Inspect the diff for leaked secrets, destructive operations, and unrelated changes.
7. Update `SPEC.md` if an approved decision changes, and `TASKS.md` when status changes.
8. Open a pull request to `develop`; do not merge until review and applicable checks pass.

## Current architecture
- Node.js 24.5+ HTTP server in `server.mjs`, static UI in `public/`.
- Local single-user data is JSON on disk. Cloud data uses Supabase Auth, a server-side gateway RPC, and storage for JPEG covers.
- Default snapshot API transfers a `books` array with revision; optional `LIBRARY_STORAGE=records` uses independently versioned books/notes after approved migration. See docs/record-storage.md.
- Existing tests include Node tests and Playwright-core browser tests that require a Chromium executable at `CHROMIUM_PATH` or `/usr/bin/chromium`.

## Completion report
Include: changed files, behavior, risks, commands actually run, results, untested paths, required human approvals, and a rollback plan.
