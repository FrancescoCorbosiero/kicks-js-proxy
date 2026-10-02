# Production: Docker behind Caddy (labels)

One VPS runs the whole Store Hub: the app (the Next.js standalone server),
Postgres and Redis, behind the [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy)
you already run. Caddy reads the app container's labels and serves both
addresses over HTTPS, certificates included:

| Address | What it serves |
| --- | --- |
| `HUB_HOST` (e.g. `hub.resellpiacenza.shop`) | the operator Hub, every tab |
| `VETRINA_HOST` (e.g. `vetrina.resellpiacenza.shop`) | the Vetrina only, at `/` |

Same app, same container. The app tells the two addresses apart by the Host
header, which Caddy passes through. Both ask for the same password, but each
address keeps its own session, so you sign in once on each.

Everything lives in `deploy/`: `docker-compose.yml` and the settings template
`.env.example`. The image (`Dockerfile`, repo root) applies the pending
database migrations every time it starts. The scheduled syncs (store pull,
feeds, orders) run inside the app, so there is no cron to set up.

## What you need

- A VPS with Docker and the Compose plugin (`docker compose version`).
- caddy-docker-proxy running, with ports 80 and 443 open.
- About 2 GB of RAM for the first build. With less, add swap first (see
  *Troubleshooting*).

## Go live, step by step

### 1. DNS

Add two **A records** pointing at the VPS's IP: `hub` and `vetrina` (under
`resellpiacenza.shop`). Then check them:

```bash
dig +short hub.resellpiacenza.shop
dig +short vetrina.resellpiacenza.shop      # both print the VPS's IP
```

If the domain is on Cloudflare, set both records to **DNS only** (grey cloud)
for now, so Caddy can obtain its certificates. Step 8 turns the proxy back on
and hides the server's IP again.

### 2. Find Caddy's network

The app must join a Docker network your Caddy container is **already on**:

```bash
docker ps                                            # find your Caddy container's name
docker inspect <caddy-container> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
docker inspect <caddy-container> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep CADDY_INGRESS_NETWORKS
```

If the last command prints `CADDY_INGRESS_NETWORKS`, use one of the networks
it lists. If it prints nothing, any network from the second command works.
If the network isn't called `caddy`, set `CADDY_NETWORK` to its name in step 4.

Don't create a new network for the app when you already run Caddy. The app
would start and report healthy, but Caddy couldn't reach it: both addresses
would answer 503, and Caddy's log would say `Container is not in same network
as caddy`.

**No Caddy container in `docker ps`?** Start caddy-docker-proxy once, then
continue. It serves every container on the `caddy` network that has `caddy`
labels:

```bash
docker network create caddy
docker run -d --name caddy --restart unless-stopped --network caddy \
  -p 80:80 -p 443:443 -e CADDY_INGRESS_NETWORKS=caddy \
  -v /var/run/docker.sock:/var/run/docker.sock:ro -v caddy_data:/data \
  lucaslorentz/caddy-docker-proxy:2.9-alpine
```

### 3. Get the code

```bash
git clone https://github.com/FrancescoCorbosiero/kicks-js-proxy.git store-hub
cd store-hub/deploy
```

(For a private repo, clone with a GitHub token or a deploy key.)

### 4. Settings

```bash
cp .env.example .env
openssl rand -hex 24          # copy the output into POSTGRES_PASSWORD
nano .env
```

Fill in `HUB_HOST`, `VETRINA_HOST`, `APP_PASSWORD`, `POSTGRES_PASSWORD`, the
`WOO_*` keys, and copy any optional secrets you use today (`KICKS_SECRET`,
`GS_FEED_*`, ...) from your current `.env`. Leave unused lines commented out.
A line with nothing after `=` stops the app at boot.

### 5. (Optional) Bring your current data

Skip this step to start with an empty Hub. To keep your catalog, margins and
price locks, copy the local database over **before the first start**.

On your PC, from the repo root, where the dev `docker-compose.yml` runs
Postgres:

```bash
docker compose exec -T postgres pg_dump -U kicks -Fc -f /tmp/hub.dump kicks
docker compose cp postgres:/tmp/hub.dump ./hub.dump
scp hub.dump <user>@<vps>:~/store-hub/deploy/
```

On the VPS, in `store-hub/deploy`:

```bash
docker compose up -d postgres                          # the database only
docker compose cp hub.dump postgres:/tmp/hub.dump
docker compose exec postgres pg_restore -U kicks -d kicks --no-owner /tmp/hub.dump
```

### 6. Start

From `store-hub/deploy`, not the repo root: the root's `docker-compose.yml`
starts only the databases for local development.

```bash
docker compose up -d --build        # the first build takes a few minutes
docker compose logs -f app          # Ctrl+C to stop watching
```

Wait for `migrate: database is up to date`, then `Ready`, then the scheduler's
line: `[scheduler] on — daily sync at 04:30 (Europe/Rome) …; orders every 15 min`.
On a fresh database it also says the last sync `never completed — running it in
a minute`. That first sync pulls the whole store, so expect
`[scheduler] store pull done: N products` within a few minutes.

Caddy requests the two certificates as soon as the app container appears.
With DNS already pointing here, that takes a few seconds.

### 7. Check

- `https://hub.resellpiacenza.shop` → password → the Hub with every tab.
- `https://vetrina.resellpiacenza.shop` → password → the Vetrina, with no link
  back to the Hub.
- `https://vetrina.resellpiacenza.shop/catalog` → sends you back to the Vetrina.
- In the Vetrina, open a section: its products load from the live site.
- Hub → Feeds: the *Sincronizzazione automatica* card shows the next run, the
  last one (products pulled from the store, SKUs, re-priced) and the orders
  cadence. Hub → Orders: the latest orders, refreshed every 15 minutes.

On a phone, open the Vetrina's address and choose *Add to Home Screen*.

### 8. Hide the server's IP again (Cloudflare)

Once both addresses open over HTTPS (step 7), Caddy has its certificates:

1. In Cloudflare → **SSL/TLS → Overview**, set the encryption mode to
   **Full (strict)**. Caddy's certificates are real ones, so Cloudflare can
   verify them.
2. In **DNS**, turn both records back to **Proxied** (orange cloud).

DNS now answers with Cloudflare's addresses, not the VPS's. Caddy keeps
renewing its certificates on its own: Let's Encrypt's check comes in through
Cloudflare like any visit, and Caddy answers it. A renewal that fails shows
up in Caddy's log weeks before the certificate expires. Switching the
records to DNS only for a few minutes then lets Caddy renew directly.
Two consequences of the proxy:

- **A click that takes over 100 seconds** gets an error page from Cloudflare
  (524), while the server finishes the job anyway. The scheduled syncs don't
  go through Cloudflare, so they aren't affected.
- **The IP may already be on record** from the hours it was public. To make it
  useless, allow ports 80 and 443 only from Cloudflare's IP ranges in your
  hosting provider's firewall. Use the provider's firewall rather than `ufw`,
  because Docker's published ports bypass `ufw`.

### 9. Be told if a sync doesn't happen

The daily sync and the orders pull run inside the app (see *Scheduled syncs*
below). To get an email when a daily sync fails or never runs:

1. Create a free check at [healthchecks.io](https://healthchecks.io): period
   **1 day**, grace **3 hours**.
2. Put its ping URL in `deploy/.env` as `SCHEDULER_HEARTBEAT_URL=…`, then run
   `docker compose up -d` (no rebuild needed: settings are read at start).

## Scheduled syncs

| What | When | Setting |
| --- | --- | --- |
| Store pull, GS sync, KicksDB re-pricing, housekeeping | every day at 04:30, Italian time | `SCHEDULER_TIMES` (e.g. `04:30,13:30`), `SCHEDULER_TIMEZONE` |
| Recent orders | every 15 minutes | `SCHEDULER_ORDERS_MINUTES` |

- **A failed step** doesn't stop the others. It is retried an hour later,
  twice at most.
- **A restart or a deploy** never loses a sync. If the server was down at
  04:30, or that run failed, the sync runs a minute after the next start. A
  deploy after a good run starts nothing.
- **Every run is kept** in the database (`scheduler_runs`), and the Feeds tab
  shows the last one.
- **Logs:** `docker compose logs app | grep scheduler`.

## Day to day

Everything runs from `store-hub/deploy`.

**Update to new code:**

```bash
git pull && docker compose up -d --build     # build, then swap the app (a few seconds offline)
docker image prune -f                        # clear old builds
```

No `npm`, no migrate command. The new image applies its migrations when it
starts. A schema change is made in development: change
`src/server/db/schema.ts`, run `npm run db:generate`, and commit the new
`drizzle/` files with the code.

**Change a setting** in `deploy/.env`, then `docker compose up -d`. No
rebuild: settings are read at start.

**Watch it:** `docker compose ps` for health, `docker compose logs -f app` for
the logs.

**Back up the database.** Nothing else does. Add a nightly crontab line on
the VPS (`crontab -e`). It keeps two weeks of dumps; copy them off the server
now and then:

```
15 3 * * * cd ~/store-hub/deploy && docker compose exec -T postgres pg_dump -U kicks -Fc kicks > ~/backups/hub-$(date +\%F).dump && find ~/backups -name 'hub-*.dump' -mtime +14 -delete
```

(Create `~/backups` first. In crontab, `%` must be written `\%`.) A dump goes
back with `pg_restore`, as in step 5.

Run a single app container per shop: the syncs run inside it, so a second
copy would run every sync twice.

## A second shop on the same server

The same stack can run again for another WooCommerce site with
golden-hive-blocks, next to the first one and behind the same Caddy:

1. Clone the repo into another folder, e.g. `git clone … store-hub-2`.
2. In `store-hub-2/deploy`, `cp .env.example .env` and fill it in for that
   shop: its own `HUB_HOST`, `VETRINA_HOST`, `WOO_*` keys, `APP_PASSWORD` and a
   new `POSTGRES_PASSWORD`.
3. Set **`COMPOSE_PROJECT_NAME=store-hub-2`** in that `.env`. Without it both
   stacks share one name, and the second `up` replaces the first one's
   containers and uses its database.
4. Add DNS records for the two new names, then `docker compose up -d --build`.

Each stack has its own containers, database and scheduler, and Caddy routes
by hostname. Any other container with `caddy` labels on the `caddy` network
gets its own HTTPS site the same way. The code-level settings
(`src/config/hub.config.ts`: tabs, Vetrina blocks) are built into the image,
so a shop that needs different ones needs its own branch.

## Troubleshooting

- **`set APP_PASSWORD in deploy/.env`** (or another variable): that line is
  missing from `deploy/.env`.
- **`Invalid environment configuration`** in the app's logs: a value is
  malformed, or a line has nothing after `=`. Comment it out instead.
- **`network caddy declared as external, but could not be found`:** your Caddy
  is on a network with another name. Set `CADDY_NETWORK` to that name (step 2)
  instead of creating a `caddy` network.
- **Both addresses answer 503 or a blank page, while the app is healthy:** the
  app is not on Caddy's network, and Caddy's log says `Container is not in same
  network as caddy`. From `deploy/`, compare the networks and look at the site
  Caddy generated:

  ```bash
  docker inspect <caddy-container> --format '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}'
  docker inspect $(docker compose ps -q app) --format '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}'
  docker exec <caddy-container> cat /config/caddy/Caddyfile.autosave
  ```

  In the block for your two addresses, a `reverse_proxy` line with no address
  after it confirms the problem. Set `CADDY_NETWORK` in `deploy/.env` to one
  of Caddy's networks (step 2), then run `docker compose up -d` (no rebuild
  needed). Caddy picks the app up within seconds.
- **No certificate / the browser can't connect:** check that DNS points at the
  VPS, that port 80 is reachable, and that Cloudflare is set to DNS only.
  Caddy's own log says why: `docker logs <caddy-container>`.
- **Cloudflare error 525 or 526:** Caddy has no certificate for that address,
  usually because the records were proxied before Caddy could get one. Set
  both records to DNS only, run `docker restart <caddy-container>` (your other
  sites pause for a few seconds), and wait until its log shows
  `certificate obtained successfully` for both names. Then go back to Proxied
  (step 8).
- **`ERR_TOO_MANY_REDIRECTS` through Cloudflare:** the SSL/TLS mode is Flexible.
  Set it to Full (strict).
- **502 from Caddy:** the app is still starting, or it stopped.
  `docker compose ps` and `docker compose logs app` show which.
- **The Feeds tab shows a sync error:** the message names the step (store
  pull, GS sync, ...). The step is retried an hour later. If it keeps
  failing, `docker compose logs app | grep scheduler` has the details.
- **The Vetrina says the site isn't ready:** install golden-hive-blocks 5.11.0
  on WordPress. If WordPress sits behind a firewall (Wordfence, Cloudflare
  WAF), allow the VPS's IP.
- **The build stops with `Killed` / exit code 137:** the VPS ran out of
  memory. Add swap and run the build again:

  ```bash
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
  sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
