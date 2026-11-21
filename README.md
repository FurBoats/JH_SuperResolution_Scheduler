# JH Super Resolution — Scheduler (Vercel)

Dispatch service for the JHenTai remote super-resolution feature. The
client asks this scheduler for a backend; the scheduler checks every
Modal account (container stats via the Modal JS SDK + tunnel health
probe), reuses a running container when there is one, otherwise wakes
the account with the most monthly credit left, mints a session on the
backend, and hands the client the backend's tunnel address + session
id. Only one account's container is ever woken at a time.

**Why Vercel and not a Cloudflare Worker:** the Modal JS SDK speaks
gRPC (nice-grpc), which needs HTTP/2 bidirectional streaming —
Cloudflare Workers cannot do that (see modal-labs/modal-client#4124),
so `getCurrentStats()` cannot run in a Worker. Vercel's Node.js
runtime is a full Node process and runs the SDK fine. (Vercel's Edge
runtime has the same limitation as Workers — this project uses the
Node.js runtime, which is the default for `api/` functions.)

## Deploy (dashboard only, no CLI)

1. Vercel → Add New → Project → import this repo. Framework preset:
   **Other**. No build command, no output directory — just deploy.
2. Project → Settings → Environment Variables, add:
   - `CLIENT_KEY` — any long string you choose; the JHenTai client
     sends it as `X-Client-Key` (set the same value in the app's
     advanced settings).
   - `BACKEND_SECRET` — must match the `BACKEND_SECRET` in every
     Modal backend's `jh-sr-secrets` secret.
   - `ACCOUNT_1`, `ACCOUNT_2`, … — one JSON per Modal account:
     ```json
     {"id": "acc1",
      "tunnelBase": "https://ehsr-1.fur.boats",
      "wakeBase": "https://<workspace>--jh-super-resolution.modal.run",
      "monthlyCreditUsd": 30,
      "gpuRatePerSec": 0.000164,
      "modalTokenId": "ak-...",
      "modalTokenSecret": "as-...",
      "modalApp": "jh-super-resolution",
      "modalFunction": "Backend"}
     ```
     `gpuRatePerSec`: T4 = 0.000164, L4 = 0.000222, A10 = 0.000306.
     `modalApp` / `modalFunction` default to the values above and can
     be omitted. API tokens are created in each Modal account under
     Settings → API Tokens. Leaving the token fields out also works —
     stats are then unknown and the scheduler falls back to pure
     tunnel probing.
3. (Recommended) Project → Storage → create an Upstash Redis (the
   Vercel KV successor) and connect it to this project. The
   `*_REST_API_URL` / `*_REST_API_TOKEN` variables are injected
   automatically. The store holds only the per-account monthly
   GPU-seconds ledger used for "most credit left" ranking; without it
   the ranking degrades to account order.
4. Project → Settings → Domains → add `ehsr.fur.boats`. At
   Cloudflare, point the name at Vercel with a **DNS-only** record
   (CNAME to `cname.vercel-dns.com`) — do not enable the CF proxy on
   it.
5. Redeploy once after setting variables (Deployments → ⋯ →
   Redeploy) so the functions pick them up.

## Routes (rewrites in `vercel.json`)

| Public path | Purpose |
|---|---|
| `POST /resolution_img` | Ask for a backend: `200 {state:"ready", backendUrl, sessionId}` or `202 {state:"waking", dispatchId}` |
| `GET /resolution_img/status?dispatchId=…` | Poll a waking dispatch until `ready` / `error` |
| `GET /` | Plain-text status page: per-account runner count, tunnel state, remaining-credit estimate |

All dispatch routes require the `X-Client-Key` header.

## Hobby-plan notes

- Every request is short (parallel stats + health probes, one session
  mint). `maxDuration` is set to 60 s in `vercel.json`, the Hobby
  maximum. The wake request itself is fire-and-confirm (≤ 8 s): the
  container keeps starting on Modal's side, and status polls re-fire
  the wake idempotently, so a lost wake heals itself.
- Polling during one wake costs roughly one invocation every few
  seconds — far inside Hobby quotas at personal scale.

## Known unverified point

`getCurrentStats()` is queried on the backend's `Backend` class
function. If a future Modal SDK renames things, the stats call fails
soft (treated as "unknown") and dispatch continues on tunnel probing
alone — watch the `/` status page: `runners=?` for every account
means stats are not coming through.
