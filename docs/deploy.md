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
database migrations every time it starts, and the daily sync runs inside the
app, so there is no cron to set up.

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

If the domain is on Cloudflare, set both records to **DNS only** (grey cloud),
so Caddy can obtain the certificates itself.

### 2. Find Caddy's network

The app joins the Docker network your Caddy container watches:

```bash
docker ps                                            # find your Caddy container's name
docker inspect <caddy-container> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

If it is called something other than `caddy`, set `CADDY_NETWORK` to that name
in step 4.

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

```bash
docker compose up -d --build        # the first build takes a few minutes
docker compose logs -f app          # Ctrl+C to stop watching
```

Wait for `migrate: database is up to date`, then `Ready`. Caddy requests the
two certificates as soon as the app container appears; with DNS already
pointing here that takes a few seconds.

### 7. Check

- `https://hub.resellpiacenza.shop` → password → the Hub with every tab.
- `https://vetrina.resellpiacenza.shop` → password → the Vetrina, with no link
  back to the Hub.
- `https://vetrina.resellpiacenza.shop/catalog` → sends you back to the Vetrina.
- In the Vetrina, open a section: its products load from the live site.

On a phone, open the Vetrina's address and choose *Add to Home Screen*.

## Day to day

From `store-hub/deploy`:

```bash
git pull && docker compose up -d --build     # update to the latest code
docker image prune -f                        # clear old builds
docker compose logs -f app                   # logs
docker compose ps                            # health
docker compose exec -T postgres pg_dump -U kicks -Fc kicks > ~/hub-$(date +%F).dump   # backup
```

Run a single app container: the daily sync runs inside it, so a second copy
would run every sync twice.

## Troubleshooting

- **`set APP_PASSWORD in deploy/.env`** (or another variable): that line is
  missing from `deploy/.env`.
- **`Invalid environment configuration`** in the app's logs: a value is
  malformed, or a line has nothing after `=`. Comment it out instead.
- **No certificate / the browser can't connect:** check that DNS points at the
  VPS, that port 80 is reachable, and that Cloudflare is set to DNS only.
  Caddy's own log says why: `docker logs <caddy-container>`.
- **502 from Caddy:** the app is still starting, or it stopped.
  `docker compose ps` and `docker compose logs app` show which.
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
