# Server setup

Standing up performance-lab on the new box, and what runs there afterwards.

Everything below assumes a Debian/Ubuntu host with Docker Engine and the
Compose plugin installed, reachable on your LAN.

## How a deploy works

The server pulls; GitHub never pushes.

```
push to main ─→ CI: typecheck, test, migrations ─→ build 4 images ─→ ghcr.io
                                                                        │
                                    server timer, every 5 min ──────────┘
                                    pull → migrate → restart → healthcheck
```

The server sits behind NAT, so GitHub cannot open a connection to it anyway.
Having the server ask "anything new?" needs no inbound port, no deploy key on
a runner, and no tunnel. CI going green is the gate: a failing build publishes
no image, so there is nothing for the timer to find.

## One-time setup

**1. Clone to `/opt/performance-lab`.** The systemd units hardcode this path;
change both `.service` files together if you put it elsewhere.

```bash
sudo git clone https://github.com/ErikPillon/performance-lab.git /opt/performance-lab
sudo chown -R "$USER" /opt/performance-lab
cd /opt/performance-lab
```

**2. Write `.env`.** Start from the template and fill in every value.

```bash
cp .env.example .env
```

Three of them decide whether this deployment is sound:

| Variable | What it must be |
|---|---|
| `POSTGRES_PASSWORD`, `S3_SECRET_KEY` | Long random strings, not the placeholders. Nothing else guards the database. |
| `BETTER_AUTH_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` — rotating it logs everyone out. |
| `SITE_ADDRESS` | Where the browser reaches the app, e.g. `https://192.168.40.101`. Must match `AUTH_BASE_URL` exactly, port included, or the session cookie is scoped to the wrong origin and login silently fails. |

Set `AUTH_ALLOW_SIGNUP=true` for the first run, create your account, then set it
to `false` and redeploy. Otherwise anyone reaching the box can register.

**3. Log in to the registry.** Only needed if the images are private — a public
repo publishes public packages and `docker pull` works unauthenticated.

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u ErikPillon --password-stdin
```

**4. First deploy.** Run it by hand once, so you see it work before a timer
owns it.

```bash
./scripts/deploy.sh
```

**5. Install the timers.**

```bash
sudo cp deploy/performance-lab-*.service deploy/performance-lab-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now performance-lab-deploy.timer
sudo systemctl enable --now performance-lab-backup.timer
systemctl list-timers 'performance-lab-*'
```

## What is exposed

`docker-compose.prod.yml` publishes ports 80 and 443 and nothing else. In the
base (development) file Postgres, Redis and MinIO bind the host so you can
reach them from a local shell; on a LAN box that same line offers the database
to every device on the network. In production they talk over the compose
network only.

To reach the MinIO console or run `psql` against the server, tunnel in:

```bash
ssh -L 9101:localhost:9101 -L 5433:localhost:5432 <server>
```

## Day to day

| Task | Command |
|---|---|
| Deploy now, don't wait for the timer | `sudo systemctl start performance-lab-deploy.service` |
| Watch a deploy | `journalctl -u performance-lab-deploy -f` |
| Pin one build | `./scripts/deploy.sh sha-<commit>` |
| Undo the last deploy | `./scripts/deploy.sh --rollback` |
| What is running | `cat .deploy-state` |
| Back up now | `./scripts/backup.sh` |
| **Rehearse a restore** | `./scripts/restore.sh --verify backups/<stamp>` |
| Restore for real | `./scripts/restore.sh backups/<stamp>` |

## Backups

`backup.sh` snapshots the two things that cannot be recomputed: the Postgres
database, and the MinIO objects holding the original FIT files. Everything
else is derived — drop the analytics tables and a recompute rebuilds them;
lose the FIT files and every number in the system is gone permanently.

Snapshots land in `backups/`, 14 daily by default.

**Set `BACKUP_REMOTE`.** Until you do, the snapshots sit on the same disk as
the data they protect, which defends against deleting the wrong row and
against nothing else. Point it at the other box:

```
BACKUP_REMOTE=erik@192.168.40.100:/srv/backups/performance-lab
```

**Rehearse quarterly.** `./scripts/restore.sh --verify <snapshot>` restores
into a throwaway container, counts the rows, and destroys it — it never touches
anything live. An untested backup is a guess, and a restore is not the moment
to find out the dumps have been empty for months.

## When a deploy fails

`deploy.sh` rolls back on its own if the API does not pass its healthcheck, so
a bad image leaves the previous version serving. The two cases worth knowing:

**Migration failed.** Nothing was restarted; the old version is still up. The
migration ran against the new image but the old containers never stopped. Fix
the migration, push, and the next pull retries.

**Healthcheck failed.** The script logged the last 40 lines of the API log and
restarted the previous tag. `journalctl -u performance-lab-deploy -n 100` has
the detail.

Both leave `.deploy-state` pointing at the version that is actually running.
