# Sign-in: Authelia in front of the Hub and the Vetrina

The app has no login of its own. [Authelia](https://www.authelia.com) signs
people in before any request reaches it. Everyone has their own account and
signs in with its name (not the email) and password. Five wrong passwords lock
that name for 15 minutes. Each account opens only its own shop:

| Account | Authelia group | Opens |
| --- | --- | --- |
| the admin | `operators` | every shop's Hub and Vetrina |
| a shop's account | the shop's group, e.g. `resellpiacenza` | that shop's `HUB_HOST` and `VETRINA_HOST`, nothing of another shop |

Authelia can also ask for a second factor (an authenticator app or a passkey),
for the admin only or for everyone. It's off; turning it on takes a few lines
of its settings ([its README, "A second factor"](https://github.com/FrancescoCorbosiero/prd-web-eu1-01-authelia#a-second-factor-optional)).

This replaces the shared password (`APP_PASSWORD`), which opened both
addresses, every Hub tab included, for anyone who knew it, and the same for
every shop that used it. To switch a running
server over, see [Moving from the shared password](#moving-from-the-shared-password).

## Why Authelia, not Authentik

Both do forward auth with Caddy, and both can add passkeys and authenticator
apps. For one VPS,
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
     was asked for in `rd`: not signed in yet.
     After signing in, the browser lands back on that page.
   - **403**: signed in, but this address is not theirs (one shop's account on
     another shop's address).
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

The cost: each address asks once. Signed in on the Hub is not signed in on
the Vetrina, and a session can belong to a different account on each address.
To try another account, use a private window, or sign out first at
`/authelia/logout` on that address.

## What is where

| Where | What it is |
| --- | --- |
| [prd-web-eu1-01-authelia](https://github.com/FrancescoCorbosiero/prd-web-eu1-01-authelia), cloned to `/srv/authelia` | Authelia itself, once per server: its settings, people, secrets and scripts. Its README covers installing it, adding people, lost devices and sign-ins that fail (`bin/check-login`) |
| `deploy/docker-compose.yml` | the shop's stack: its Caddy labels send every request through Authelia |
| `src/proxy.ts` | the app's side: the secret and the identity checks |

## Before the shop: Authelia and Caddy

Authelia runs once per server, from its own repo cloned to `/srv/authelia`,
like Caddy runs from `/srv/caddy`. Never from a shop's checkout: a second copy
started by mistake would take the sign-in of every site down with it. Install
it by following [its README](https://github.com/FrancescoCorbosiero/prd-web-eu1-01-authelia#install). This shop's addresses are already
in its `config/configuration.yml`; a new shop adds its own there
([Protect another site](https://github.com/FrancescoCorbosiero/prd-web-eu1-01-authelia#protect-another-site)).

### Caddy's version

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
- Signed in with the shop's account, both `https://<HUB_HOST>` and
  `https://<VETRINA_HOST>` open (each address asks once). Another shop's
  addresses answer **403** to it.
- Signed in as the admin, both open too.

People and bans are managed in Authelia's repo, on the server in
`/srv/authelia` ([its README](https://github.com/FrancescoCorbosiero/prd-web-eu1-01-authelia#add-a-person)).

## External scheduler

The Hub schedules its own syncs. If you turn that off and call `/api/cron/*`
from outside instead (`SCHEDULER=off` and `CRON_SECRET`, see the README),
uncomment the cron rule in Authelia's `config/configuration.yml`: those calls
carry `CRON_SECRET`, not a session.

## Moving from the shared password

On a server that runs the Hub with `APP_PASSWORD`:

1. [Install Authelia](https://github.com/FrancescoCorbosiero/prd-web-eu1-01-authelia#install) in `/srv/authelia`, with yourself in
   `operators` and the shop's account in the shop's group. Check each with
   `bin/check-login <name>`. Until step 3 the old password still guards the
   app.
2. In the shop's checkout, `git pull`; the running app is untouched until it
   is rebuilt.
3. In `deploy/.env`, delete the `APP_PASSWORD` line (or comment it out, to roll
   back later) and add `AUTH_PROXY_SECRET`.
4. From `deploy/`, run `docker compose up -d --build`.
5. Everyone signs in once with their own name and password. Sessions of the
   old password stop working.

Until `AUTH_PROXY_SECRET` is in `deploy/.env`, `docker compose up` refuses to
start, and the running app is left as it is.

## Troubleshooting

- **Someone can't sign in:** first, the name is the account's key in
  `users.yml`, not its email. Then, on the server, `cd /srv/authelia &&
  bin/check-login <name>`. It checks the name, the password against its hash,
  bans and Authelia's logs.
- **502 on every page:** Authelia is not running, or not on Caddy's network.
  Check `docker compose ps` in `/srv/authelia`; `docker compose logs authelia`
  says why it stopped.
- **403 after signing in:** the account signed in on this address doesn't
  open it. `docker compose logs authelia | grep forbidden` in `/srv/authelia`
  names it. Often it's another account still signed in on that address: sign
  out at `/authelia/logout` and sign in again. Otherwise, its group in
  `users.yml` doesn't match the shop's rule in Authelia's settings.
- **A plain "Forbidden", and the app's log says `came through Caddy without a
  user`:** the `forward_auth` labels are missing from the app's container.
  Compare them with `deploy/docker-compose.yml`.
- **A page with only a password box, no username:** that's the app's old
  login. The address isn't switched to Authelia yet (steps 3–4 above).
- **The sign-in page comes back after signing in:** the address is missing from
  `session.cookies` in Authelia's configuration, or the request did not arrive
  over https.
