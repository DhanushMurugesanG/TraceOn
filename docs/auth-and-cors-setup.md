# Auth-protected backends + traceparent CORS

Two setup gotchas that surface when TraceOn meets a real-world app for the
first time. Both fail silently — the test "looks" like it ran, but TraceOn
never gets the evidence it needs. This doc tells you how to recognise each
case, fix it, and what we tell the agent (via [`skills/traceon-verify/SKILL.md`](../skills/traceon-verify/SKILL.md))
to do on its own.

Audience: anyone setting up TraceOn against an existing web app where the
sample-app conventions (no auth, same-origin backend) don't apply.

---

## 1. Auth-protected backends

### The symptom

The Playwright test navigates to a protected route, then times out
waiting for a selector that should be on that page. A saved screenshot
shows the login form, not your feature.

If you let the agent iterate on it blindly, it will spend its three
attempts adjusting selectors instead of solving the actual problem.

### Why TraceOn can't auto-solve this

Auth shape is project-specific:

- **Token store** — could be a Keycloak adapter writing `kc-token`, a
  custom JWT store writing `access_token`, an axios-interceptor reading
  from cookies, or something entirely bespoke.
- **Required user shape** — many auth contexts won't consider the user
  "authenticated" with just a token; they also need a serialized
  `user` / `account` object in `localStorage` or context state.
- **Refresh-token flow** — some stores will eagerly trigger a refresh on
  page load and log the user out if it fails, even with a valid access
  token present.
- **Route guards** — some apps check the token expiry on every
  navigation, others on first load only.

There's no general "log in for me" Playwright primitive. You have to
match the specific app's expectations.

### The workflow

1. **Get a non-expired token from the app.**
   Easiest: log in via the real UI in your browser, open DevTools, copy
   the JWT out of `localStorage` (or wherever the app stores it).
   The agent should ask you for this token — not invent it.

2. **Find the localStorage keys the app reads on session restore.**
   Grep the app's auth context / token-storage helper:

   ```sh
   grep -rn "localStorage.setItem\|getStoredAccessToken" \
       packages/shell-app/src/context/ \
       packages/shell-app/src/utils/
   ```

   Common patterns we've seen:
   - `kc-token`, `kc-refreshToken` — Keycloak JS adapter
   - `access_token`, `refresh_token` — generic OIDC / JWT stores
   - `user`, `account` — serialized session objects some auth contexts
     require alongside the raw token

3. **Seed those keys in the Playwright test BEFORE the first navigation.**
   Use `page.addInitScript` so the seed runs in the page context before
   any app code:

   ```typescript
   import { test, expect } from './traceon-fixture.js';

   const AUTH_TOKEN = '<paste-real-jwt-here>';

   if (!AUTH_TOKEN || AUTH_TOKEN.length < 20) {
     throw new Error('Auth token required — paste a fresh JWT into the test.');
   }

   test.beforeEach(async ({ context }) => {
     // Decode the JWT once so we can derive the user/account fields some
     // auth contexts require. Keep this synchronous — no network.
     const payload = JSON.parse(
       Buffer.from(AUTH_TOKEN.split('.')[1]!, 'base64url').toString('utf-8'),
     );

     await context.addInitScript(({ token, payload }) => {
       localStorage.setItem('kc-token', token);
       localStorage.setItem('kc-refreshToken', token); // ok to reuse for local dev
       localStorage.setItem('access_token', token);
       localStorage.setItem('user', JSON.stringify({
         user_uuid: payload.user_id,
         email: payload.email,
         name: payload.name,
       }));
       localStorage.setItem('account', JSON.stringify({
         account_id: payload.account_id,
       }));
     }, { token: AUTH_TOKEN, payload });
   });

   test('my feature', async ({ page }) => {
     await page.goto('/protected/page');
     // ...
   });
   ```

   Adjust the keys to whatever your app actually reads. The point of the
   one-time investigation is finding those keys; once you have them,
   future tests can copy this block verbatim.

4. **Pick how the token reaches the test.** Three options, in order of
   preference:

   **a. Recommended (v0.0.7+) — `.traceon/auth.json`.** Add the token
   to a flat JSON file at `<projectRoot>/.traceon/auth.json`:

   ```json
   { "AUTH_TOKEN": "ey...the_jwt..." }
   ```

   Then read it in the test via `process.env.AUTH_TOKEN`. TraceOn
   loads the file once per run and forwards every entry as an env var
   to the Playwright subprocess. When the token expires, update the
   file once and every iteration picks it up — no editing the test.

   **Gitignore `.traceon/`** — the directory holds both this secret
   file and all per-run evidence dumps.

   **b. `extra_env` for one-off runs (v0.0.7+).** When calling
   `traceon_verify` you can pass:

   ```json
   { "extra_env": { "AUTH_TOKEN": "ey..." } }
   ```

   The agent will do this automatically when it has just been given a
   token for the current call. `extra_env` overrides `auth.json` on
   key collision.

   **c. Inlined in the test file (legacy).** Still works but avoid it
   on new projects: every token rotation means editing the test, and
   a fat-finger commit leaks the JWT. Pre-v0.0.7 this was the only
   path because env vars weren't reliably forwarded; v0.0.7+ closes
   that gap.

5. **Add a fail-fast guard.** When the token expires (every JWT does),
   you want the test to fail with `Auth token required — paste a fresh
   JWT` rather than "selector not visible after 20s." Five seconds saved
   per expired-token retry adds up.

### What the agent does on its own

[`skills/traceon-verify/SKILL.md`](../skills/traceon-verify/SKILL.md)
has an "Authenticated apps (token required)" section under Special cases.
On a fresh project where the test times out on a protected route, Claude
will:

- Recognize the pattern (selectors missing on a protected route, no
  CORS errors)
- Stop and prompt you for a JWT
- On v0.0.7+, write it to `.traceon/auth.json` so the next iteration
  picks it up automatically; on older versions, inline it in the test
- Seed the common localStorage keys
- Add the fail-fast guard

If your app needs unusual keys, tell Claude where the auth helper lives
and it can grep for them.

---

## 2. `traceparent` CORS

### The symptom

The test fires real backend requests (you can see them in the dev-tools
network tab if you watch the run), but `traceon_verify` returns
`evidence_summary.no_trace_activity: true`. The backend never saw the
request — so no spans, no logs, no evidence.

Browser console (visible in Tier 2 / Tier 3 of the evidence) will
contain something like:

> Access to fetch at 'http://localhost:8001/api/cycles/list' from origin
> 'http://localhost:3004' has been blocked by CORS policy: Request
> header field `traceparent` is not allowed by Access-Control-Allow-Headers
> in preflight response.

### Why this happens

TraceOn's Playwright fixture
([`packages/playwright-fixture`](../packages/playwright-fixture))
injects a `traceparent` header on every outgoing request via
`context.setExtraHTTPHeaders`. That's how the browser-side test and the
backend traces get correlated — same trace ID end-to-end.

When frontend and backend are on different origins (a very common dev
setup: Vite on `:3004`, Go API on `:8001`), the browser sends a CORS
preflight. The backend's preflight response lists the headers it allows
in actual requests via `Access-Control-Allow-Headers`. If `traceparent`
isn't on that list, the browser refuses to send the actual request.

The fixture can't work around this — by the time the browser is
preflighting, the request hasn't gone out yet. The fix has to live in
the backend's CORS policy.

### The fix

Add `traceparent` (and `tracestate` if your app uses W3C trace context's
secondary header) to your backend's CORS allow-headers config.

**Go (gofiber/cors):**

```go
import "github.com/gofiber/fiber/v2/middleware/cors"

app.Use(cors.New(cors.Config{
    AllowOrigins: "http://localhost:3004",
    AllowHeaders: "Origin, Content-Type, Accept, Authorization, traceparent, tracestate",
    AllowCredentials: true,
}))
```

**Go (rs/cors):**

```go
import "github.com/rs/cors"

c := cors.New(cors.Options{
    AllowedOrigins: []string{"http://localhost:3004"},
    AllowedHeaders: []string{"Authorization", "Content-Type", "traceparent", "tracestate"},
    AllowCredentials: true,
})
```

**Node (cors middleware):**

```ts
import cors from 'cors';

app.use(cors({
  origin: 'http://localhost:3004',
  allowedHeaders: ['Authorization', 'Content-Type', 'traceparent', 'tracestate'],
  credentials: true,
}));
```

**Python (FastAPI):**

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3004"],
    allow_headers=["Authorization", "Content-Type", "traceparent", "tracestate"],
    allow_credentials=True,
)
```

**Nginx (if you proxy through a layer that strips headers):**

```nginx
add_header Access-Control-Allow-Headers
  "Authorization, Content-Type, traceparent, tracestate" always;
```

After applying the change, restart the backend (or rely on its hot
reload), and re-run `traceon_verify`. You should now see real spans in
the evidence.

### Verifying the fix

Quick check that the backend really allows the header now:

```sh
curl -i -X OPTIONS \
  -H "Origin: http://localhost:3004" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: traceparent" \
  http://localhost:8001/api/cycles/list \
  | grep -i access-control-allow-headers
```

If the response includes `traceparent` in the allow-headers line, the
browser will let the actual request through.

### What the agent does on its own

The skill's decision rule "When the test fires backend requests but
`no_trace_activity` is still true" tells Claude to:

- Look for `blocked by CORS policy` or `Access-Control-Allow-Headers` in
  the browser console events (Tier 2 / Tier 3)
- Surface the specific fix (add `traceparent` to backend allow-headers)
- NOT modify the backend's CORS config itself — that's
  security-sensitive infrastructure the user owns

So you'll get a clear pointer to the fix, not a generic "no evidence
captured" message.

---

## When you can ignore both

If your project is the TraceOn sample app (`traceon-spike`) or any other
app that's:

- Unauthenticated, and
- Frontend and backend on the same origin (or proxied to look like it)

…neither gotcha applies. `traceon init` and the default Playwright
fixture work out of the box. The setup pain only shows up when you
point TraceOn at a real production-shaped app.
