# Playwright smoke tests

## Prerequisites

- Node 18+ with Playwright installed globally or via `npx`
- Google Chrome installed (used via `channel: 'chrome'`)
- Local dev server running at `http://plastischechirurgie-frankfurt.test`
- Test user `playwright@test.local` with password `PlaywrightTest123!` must exist (see setup below)

## One-time setup

```bash
# Install Playwright (if not already available)
npm install -g playwright

# Create the test user (run from the Laravel project root)
php artisan statamic:make:user playwright@test.local --super
# enter password: PlaywrightTest123!
```

## Run

```bash
node tests/playwright/smoke.mjs
```

## What it tests

1. CP login succeeds
2. Entry edit page loads and Statamic's publish store is populated
3. Section Tools floating panel is mounted
4. Chat textarea and Send button are present
5. Sending "PONG" prompt gets a reply containing "PONG"
6. `schemas` field is present in Vuex values (secondary-tab field coverage)
