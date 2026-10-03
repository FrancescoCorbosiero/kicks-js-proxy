# Sign-in: Authelia in front of the Hub and the Vetrina

The app has no login of its own. [Authelia](https://www.authelia.com) signs
people in before any request reaches it. Everyone has their own account, with
a password and a second factor: a passkey (Face ID, a fingerprint, a security
key) or an authenticator app. Each account opens only its own addresses:

| Address | Who can open it |
| --- | --- |
| `HUB_HOST` (the Hub, every tab) | operators (group `operators`) |
| `VETRINA_HOST` (the Vetrina) | the shop's own people (group `resellpiacenza`) and operators |

This replaces the shared password (`APP_PASSWORD`), which opened both
addresses, every Hub tab included, for anyone who knew it. To switch a running
server over, see [Moving from the shared password](#moving-from-the-shared-password).

## Why Authelia, not Authentik

Both do forward auth with Caddy, passkeys and authenticator apps. For one VPS,
a handful of people and caddy-docker-proxy, Authelia is the lighter fit:

| | Authelia | Authentik |
| --- | --- | --- |
| Runs as | one container (a 28 MB image), plus a small Redis for sessions | a server, a worker and PostgreSQL; its docs ask for 2 CPU cores and 2 GB of RAM |
| Configured in | YAML files next to these compose files | an admin web UI, stored in its database |
| People | a YAML file: add, disable, regroup by editing it | an admin UI, with invitations and self-service sign-up |
| With Caddy | `forward_auth` straight to it | `forward_auth` to its embedded outpost |
| Best for | a few people the operator sets up personally | many users who onboard themselves, or other apps over LDAP, SAML or SCIM |

The VPS already needs 2 GB of RAM to build the app, and the people who sign in
are the operator and the shop. Move to Authentik if that changes: dozens of
users, people who should sign themselves up, or other apps to put behind the
same login.

## How a request goes through

```
 phone / browser
      │  https://vetrina.resellpiacenza.shop/…
      ▼
 Cloudflare ──► Caddy (caddy-docker-proxy; the labels in deploy/docker-compose.yml)
                 │
                 ├─ /authelia/…  ─────────────────────────────►  Authelia: sign-in pages and API
                 │
                 └─ anything else:
                      0. drop any Remote-* header the visitor sent
                      1. GET /api/authz/forward-auth  ────────►  Authelia: is this session signed in,
                         (original host, path and method,           and allowed on this address?
                          the session cookie)
                      2. ◄── 200 + Remote-User, Remote-Groups,
                              Remote-Name, Remote-Email            → step 3
                         ◄── 302/303 to https://<same address>/authelia/?rd=<page>   (not signed in)
                         ◄── 403                                    (signed in, not allowed here)
                      3. copy Authelia's Remote-*,
                         add X-Auth-Proxy-Secret  ─────────────►  the app (src/proxy.ts)
```

1. Every request for the Hub or the Vetrina reaches Caddy. `/authelia/…` goes
   to Authelia, whose sign-in pages are served on each protected address.
2. For anything else, Caddy first deletes every `Remote-*` header the visitor
   sent: only Authelia may say who someone is. Then it asks Authelia, passing
   on the original request's address, path and method, and its session cookie.
   The request itself waits.
3. Authelia answers one of three ways:
   - **200**, with the person in `Remote-User`, `Remote-Groups`, `Remote-Name`
     and `Remote-Email`: Caddy forwards the request.
   - **A redirect to its sign-in page** on the same address, with the page that
     was asked for in `rd`: not signed in yet, or the second factor is missing.
     After signing in, the browser lands back on that page.
   - **403**: signed in, but this address is not theirs (the shop's account on
     the Hub).
4. Caddy sets Authelia's `Remote-*` headers, adds `X-Auth-Proxy-Secret`
   (`AUTH_PROXY_SECRET` from `deploy/.env`), and passes the request to the app.
5. The app checks both ([src/proxy.ts](../src/proxy.ts)). Without the right
   secret, a request did not come through Caddy (it came from another container
   on Caddy's network, say), and the app answers 403 whatever `Remote-User`
   says. A page with the secret but no `Remote-User` means the `forward_auth`
   labels are gone; the app answers 403 instead of serving the page open.

If Authelia is down, step 2 fails and Caddy answers 502: nothing gets through
unchecked.

Without a session, Authelia lets through only the home-screen app's install
files: the manifest and the icons. Phones fetch them without cookies, and they
hold no data. The app ignores any identity sent with them. The Hub's
`/api/cron/*` endpoints stay behind the sign-in unless you open them (see
[External scheduler](#external-scheduler)).

### Why the sign-in pages are on each address

Authelia could have an address of its own, such as `auth.resellpiacenza.shop`,
with one session for everything. Serving it under `/authelia` on each address
instead:

- **Keeps the Vetrina's home-screen app on its own address while signing in.**
  An installed web app opens any other address in a browser layer on top of
  itself, which is where sign-ins get lost.
- **Keeps the session cookie on that address only.** A session shared by both
  addresses would have to live on `resellpiacenza.shop` itself, and every
  request to the shop's WordPress site and to every other subdomain would carry
  it.
- **Keeps what you had:** each address signs in on its own.

The cost: an operator signs in on the Hub and on the Vetrina separately, and a
passkey belongs to the address it was registered on, so they register one on
each. An authenticator app's codes work on both.

## What is where

| File | What it is |
| --- | --- |
| `deploy/authelia/docker-compose.yml` | Authelia, and the Redis that keeps its sessions. Once per server |
| `deploy/authelia/config/configuration.example.yml` | the settings: copy it to `configuration.yml` (yours, not in git) |
| `deploy/authelia/config/users.example.yml` | the people: copy it to `users.yml` (yours, not in git) |
| `deploy/authelia/secrets/` | two random keys, made on the server (not in git) |
| `deploy/docker-compose.yml` | the shop's stack: its Caddy labels send every request through Authelia |
| `src/proxy.ts` | the app's side: the secret and the identity checks |

Authelia's database (registered passkeys and authenticator apps, bans) and
`notification.txt` live in the `authelia_data` volume. The sessions live in
`authelia_sessions`.

## Set up Authelia

Do this once per server, before the shop's stack, because the shop's labels
send every request to it. It runs from the first shop's checkout.

### 1. Caddy's version

The labels work with caddy-docker-proxy 2.9 (Caddy 2.9.1) and newer. Check
yours:

```bash
docker ps --format '{{.Names}}  {{.Image}}' | grep caddy   # the container's name and image
docker exec caddy caddy version
```

`caddy` comes twice in the second command: first the container's name (as the
first command printed it), then the program inside it.

Older than **v2.11.2**? Update it when convenient
([docs/deploy.md, "Update Caddy"](deploy.md#update-caddy)). Before v2.11.2,
Caddy's `forward_auth` passes a `Remote-User` the visitor sent themselves on to
the app whenever Authelia sets none (CVE-2026-30851). The labels don't depend
on that fix: they delete every `Remote-*` header a visitor sends before asking
Authelia, on any version. Updating still brings this fix, others since, and
everything else that is new.

### 2. Secrets

```bash
cd ~/store-hub/deploy/authelia
mkdir -p secrets
openssl rand -hex 64 > secrets/SESSION_SECRET
openssl rand -hex 64 > secrets/STORAGE_ENCRYPTION_KEY
chmod 600 secrets/*
```

Keep a copy of `STORAGE_ENCRYPTION_KEY` off the server: the database of
registered devices can't be read without it.

### 3. Addresses and rules

```bash
cp config/configuration.example.yml config/configuration.yml
nano config/configuration.yml
```

Change the addresses where the file says `CHANGE`: under `session.cookies`
(one entry per address) and in every `access_control` rule. They must match
`HUB_HOST` and `VETRINA_HOST` in `deploy/.env`. To give the shop's group a
different name than `resellpiacenza`, rename it here and in `users.yml`.

### 4. People

```bash
cp config/users.example.yml config/users.yml
docker run --rm -it authelia/authelia:4.39 authelia crypto hash generate argon2   # once per password
nano config/users.yml
```

For each person, set:

- the username they will type, their `displayname` and their `email` (Authelia
  needs one even without an email server);
- as `password`, the `Digest:` value the command printed;
- their groups: `operators`, or the shop's group.

Authelia does not start while any password is still the example's placeholder.

### 5. Start it

If Caddy's network is not called `caddy`, first put `CADDY_NETWORK=<its name>`
in `deploy/authelia/.env`. Then:

```bash
docker compose up -d
docker compose logs -f authelia        # wait for "Startup complete"; Ctrl+C stops watching
```

A warning that it could not reach the NTP server is harmless. A warning that
the clock is off is not: fix the server's time.

## Connect a shop

In the shop's `deploy/.env`, set `AUTH_PROXY_SECRET`:

```bash
openssl rand -hex 32        # copy the output into AUTH_PROXY_SECRET
```

Then, from `deploy/`, run `docker compose up -d --build`. Caddy picks up the new
labels by itself.

Check, in a private window:

- `https://<HUB_HOST>` shows Authelia's sign-in page, at
  `https://<HUB_HOST>/authelia/`.
- Signed in with the shop's account, `https://<VETRINA_HOST>` opens the
  Vetrina, and `https://<HUB_HOST>` answers **403**.
- Signed in as an operator, both open (each address asks once).

## Adding a person

1. Add them to `users.yml` (step 4 above). It applies at once, with no restart.
2. Give them the address, their username and the password. They can change it
   later in Authelia's settings, at `/authelia/settings`.
3. They sign in and tick **Remember me** (*Ricordami*). With it, the session
   lasts a month on the Hub and three months on the Vetrina, used or not.
   Without it, an idle hour or 12 hours sign them out.
4. Authelia asks them to register a device (*Registra dispositivo*). A
   **passkey** is the simplest: Face ID or a fingerprint, nothing to type.
   **Metodi** switches to an authenticator app (Google Authenticator,
   1Password, …).
5. Registering the first device asks for a one-time code "sent by email". There
   is no email server, so the code is written to a file. From
   `deploy/authelia`:

   ```bash
   docker compose exec authelia tail -n 25 /config/notification.txt
   ```

   The code is in the newest message, which also names the person. Pass it on:
   it is valid for 5 minutes.

From then on they sign in with their password and the device. With a passkey,
*Accedi con una chiave di accesso* (sign in with a passkey) saves typing the
username.

On the phone, the installed Vetrina app needs nothing new: it shows the sign-in
page once, inside the app.

## Day to day

From `deploy/authelia`:

| To | Do |
| --- | --- |
| Remove someone | delete their entry in `config/users.yml`, or add `disabled: true` to it. Their sessions end at their next click |
| Reset a forgotten password | make a new hash (step 4) and replace theirs in `users.yml` |
| Deal with a lost phone or passkey | `docker compose exec authelia authelia storage user webauthn delete <user> --all`, and for the app `docker compose exec authelia authelia storage user totp delete <user>`. They register a new device at the next sign-in |
| Unlock someone after wrong passwords | it lifts by itself after 15 minutes, or now: `docker compose exec authelia authelia storage bans user revoke <user>` |
| Sign everyone out | `docker compose exec redis redis-cli flushall` |
| Check the settings after an edit | `docker compose run --rm authelia authelia config validate` |
| See what happened | `docker compose logs authelia` |
| Update Authelia | `docker compose pull && docker compose up -d`. The `4.39` tag follows its fixes; read the release notes before moving to `4.40` |

Changes to `users.yml` apply at once. When someone changes their own password,
Authelia saves `users.yml` again in its own layout: comments are dropped and
every field is listed. Keep notes elsewhere. Changes to `configuration.yml`
need `docker compose restart authelia`, which signs nobody out: the sessions
are in Redis.

**Back up** the `authelia_data` volume (the registered devices) and the
`secrets/` folder now and then, together. Losing them is not a disaster, just a
chore: everyone registers their device again.

Five wrong passwords within ten minutes lock that username for 15 minutes. Bans
are per user, not per IP: behind Cloudflare every visitor arrives from
Cloudflare's addresses, and banning one of those would lock out everyone using
it.

## A second shop

The second stack (see [docs/deploy.md](deploy.md#a-second-shop-on-the-same-server))
uses the same Authelia, the one running from the first shop's folder. The
second checkout's `deploy/authelia` stays unused.

1. In `config/configuration.yml`, add the new shop's two addresses under
   `session.cookies` (copy the two entries) and three rules for them (copy the
   three), with the new shop's own group in place of `resellpiacenza`.
2. In `config/users.yml`, add its people with that group. Operators keep
   `operators`, which opens every shop.
3. Run `docker compose restart authelia`.
4. In the second shop's `deploy/.env`, set its own `AUTH_PROXY_SECRET`.

## Optional

### Email

With an SMTP server, people get their one-time codes by email and can reset a
forgotten password themselves. In `config/configuration.yml`, replace the
`notifier` block with:

```yaml
notifier:
  smtp:
    address: submission://smtp.example.com:587
    username: hub@example.com
    sender: Store Hub <hub@example.com>
```

and set `authentication_backend.password_reset.disable` to `false`. That needs
two more secrets: the SMTP password, and a key for the reset links
(`openssl rand -hex 64`). Put each in a file in `secrets/` and add both to
`docker-compose.yml` like the other two, as
`AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE` and
`AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE`. Then validate
and restart.

### External scheduler

The Hub schedules its own syncs. If you turn that off and call `/api/cron/*`
from outside instead (`SCHEDULER=off` and `CRON_SECRET`, see the README),
uncomment the last rule in `access_control`: those calls carry `CRON_SECRET`,
not a session.

## Moving from the shared password

On a server that runs the Hub with `APP_PASSWORD`:

1. In `~/store-hub`, run `git pull`. That brings `deploy/authelia`; the running
   app is untouched until it is rebuilt.
2. [Set up Authelia](#set-up-authelia), with yourself in `operators` and the
   shop's account in its group. Until the next step the old password still
   guards the app.
3. In `deploy/.env`, delete the `APP_PASSWORD` line and add `AUTH_PROXY_SECRET`.
4. From `deploy/`, run `docker compose up -d --build`.
5. Everyone signs in once and registers a device. Sessions of the old password
   stop working.

Until `AUTH_PROXY_SECRET` is in `deploy/.env`, `docker compose up` refuses to
start, and the running app is left as it is.

## Troubleshooting

- **502 on every page:** Authelia is not running, or not on Caddy's network.
  Check `docker compose ps` in `deploy/authelia`; `docker compose logs authelia`
  says why it stopped.
- **Authelia restarts in a loop:** its log names the problem, usually a
  password in `users.yml` that is not a hash yet, or a YAML indentation slip.
  `authelia config validate` (above) checks `configuration.yml`.
- **403 after signing in:** that account's groups don't open this address
  (`access_control`). On the Hub, for the shop's account, that is intended.
- **A plain "Forbidden", and the app's log says `came through Caddy without a
  user`:** the `forward_auth` labels are missing from the app's container.
  Compare them with `deploy/docker-compose.yml`.
- **The sign-in page comes back after signing in:** the address is missing from
  `session.cookies`, or the request did not arrive over https.
- **The one-time code never arrives:** it is in `notification.txt`, not in an
  inbox (see [Adding a person](#adding-a-person)).
