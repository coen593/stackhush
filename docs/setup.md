# Setup

One-time steps, in order. Type every secret value yourself when wrangler asks for it; nothing
here puts a token in a file or on a command line.

Two files describe your installation (every config field is in
[configuration.md](configuration.md)):

- `stackhush.config.ts`: the projects you watch, the GitHub owners and Cloudflare accounts they
  live on, the dashboard URL and the alert addresses. Copy `stackhush.config.example.ts` and edit
  it (or let `npm run dev` make the copy). It is git-ignored; in a private fork, remove it from
  `.gitignore` and commit it.
- `wrangler.jsonc`: the Worker itself. Four placeholders to replace: `account_id`, the D1
  `database_id`, the custom domain under `routes`, and `destination_address` of the email binding.

`npm run deploy` stops before touching anything remote when (`scripts/check-config.ts --deploy`):

- `stackhush.config.ts` is still identical to the example;
- `wrangler.jsonc` still has the all-zero `account_id` or a `database_id` that is all zeros;
- the config still has an `example.com` value (or a subdomain of it) in `dashboardUrl`,
  `alertTo`, `alertFrom` or a `productionUrls` entry, or `wrangler.jsonc` has one as a route;
- `wrangler.jsonc` does not have exactly one `send_email` binding named `ALERT_EMAIL`, or its
  `destination_address` is not `alertTo` (letter case aside);
- `routes` lists hostnames but none of them is the host of `dashboardUrl`. Without `routes` this
  check is skipped: the Worker then only has its workers.dev address, which the file does not
  name.

It does not check your tokens, your DNS or whether the domain is on the account. Once the config
is no longer the example, it lists every other reason at once, so one run shows what is left.

### Checklist before the first deploy

`wrangler.jsonc`:

- [ ] `account_id` (step 0)
- [ ] the custom domain under `routes` (step 0)
- [ ] `destination_address` of the `ALERT_EMAIL` binding (step 0)
- [ ] the D1 `database_id` (step 3)

`stackhush.config.ts`:

- [ ] `dashboardUrl`, on the host of the route
- [ ] `alertTo`, the same address as `destination_address`
- [ ] `alertFrom`, an address on your email subdomain (step 2)
- [ ] `github`, `cloudflare`, `groups` and `projects`: your own

`npm run deploy` refuses while a template value from the first two lists is left. It cannot tell
whether your projects are right, so check those yourself.

## 0. Log in and fill in wrangler.jsonc

```bash
npx wrangler login
npx wrangler whoami      # lists the accounts you can use, with their ids
```

Before any step below that talks to Cloudflare, replace these placeholders in `wrangler.jsonc`.
`wrangler d1 create` and the email commands act on the account pinned there.

- `account_id`: the id `whoami` shows for the account that holds your domain.
- `routes`, `pattern`: the dashboard's hostname, the same host as `dashboardUrl` in the config
  (for example `status.example.com`; see step 1).
- `send_email`, `destination_address`: the address that gets alerts and sign-in codes, the same
  as `alertTo` in the config.

The D1 `database_id` is filled in step 3, before the first `npm run db:migrate`.

## 1. Put your domain on Cloudflare

The dashboard needs a hostname on a zone that is active in your Cloudflare account (add the domain
under Websites and switch its nameservers). Email Sending needs the same zone. Without a domain you
can leave out `routes` in `wrangler.jsonc` and use the workers.dev address, but then there is no
sender domain for email, so no alerts and no email sign-in: only the terminal link
(`npm run signin-link`, step 7) signs you in. `npm run deploy` still refuses an `alertFrom` on
`example.com`, so set it to an address on a domain you control even then.

## 2. Email sending and a verified destination

Use a subdomain for sending, such as `alerts.example.com`, and make `alertFrom` in the config an
address on it (`stackhush@alerts.example.com`). It is required: the sending records then live on
the subdomain and your domain's normal mail is left alone.

```bash
npx wrangler email sending enable alerts.example.com
npx wrangler email routing addresses create you@example.com
```

1. The first command onboards the subdomain for Email Sending on the zone of your domain (in the
   dashboard: Compute, Email Service, Email Sending, Onboard Domain).
2. The second adds the alert address (`alertTo`) as a verified destination. It is an account
   setting and changes no zone. Cloudflare sends a verification email to that address; click the
   link in it. The Free plan sends only to verified addresses.

Do not enable Email Routing for the domain itself: it replaces its existing MX records. Neither
command above needs it.

The binding in `wrangler.jsonc` (`ALERT_EMAIL`) is pinned to that one destination, so the Worker
cannot send mail to anyone else; `destination_address` there and `alertTo` in the config must be
the same address.

## 3. Create the database

```bash
npx wrangler d1 create stackhush --binding DB
```

With `--binding DB` wrangler writes the new id into the existing `DB` entry of `wrangler.jsonc`
without asking. Without it, wrangler asks in a terminal whether to add the database to
`wrangler.jsonc`. Only after a yes does it ask for a binding name (it suggests `stackhush`, which
would add a second entry and leave `DB` on the all-zero placeholder) and then "For local dev, do
you want to connect to the remote resource" (default no; keep it). With no terminal it adds
nothing. Check that `database_id` under
`DB` is no longer all zeros, then:

```bash
npm run db:migrate
```

## 4. Create the tokens

All tokens are read-only, and every one is optional: a source without its token shows as "not
configured" on the dashboard and is not checked. Give each the shortest expiry you can live with
and put the expiry in your calendar.

### GitHub: one token per entry in `github`

The secret is named after the entry's `key`: `GITHUB_TOKEN_<KEY>`, upper case, with `_` for `-`
(key `personal` gives `GITHUB_TOKEN_PERSONAL`, key `acme-inc` gives `GITHUB_TOKEN_ACME_INC`).

GitHub, Settings, Developer settings, Fine-grained personal access tokens, Generate new token.

- Resource owner: the entry's `owner` (for an organisation: it must allow fine-grained tokens,
  and an owner may need to approve the token)
- Repository access: the repos in your config, or All repositories (a new project is then covered
  without editing the token; the trade-off is that a leaked token can read Actions logs and pull
  requests of every repo, not only the watched ones)
- Repository permissions, all Read-only: Actions, Deployments, Pull requests (Metadata is added
  automatically)
- Nothing else

Review requests count as yours when they name one of the entry's `logins`. Create the token while
signed in as an account that can see those requests.

Why these permissions: GitHub has no "Checks" permission for fine-grained tokens, so check runs
cannot be read. CI state comes from Actions workflow runs (Actions: Read), deploys that a host
such as Vercel reports to GitHub from Deployments (Deployments: Read), review requests from Pull
requests (Pull requests: Read). Do not add Contents: nothing reads it. The branch whose CI is
watched is written in the config (`defaultBranch`) because reading it from the API would need
Contents.

### Supabase (secret `SUPABASE_TOKEN`)

Supabase dashboard, Account, Access Tokens, Generate new token, scoped (not a full-access token):
the one permission Projects (account-wide): Read. The "Organization Projects" permission does
not cover the call stackhush makes. Supabase may also offer to limit the token to some
organizations; that is fine to use, but we have not verified what it restricts.

### Cloudflare (secret `CF_TOKEN`)

One token for every account in `cloudflare`. Create it while signed in with a login that is a
member of all of them: My Profile, API Tokens, Create Token, Custom token.

- Permissions: Account / Account Analytics / Read and Account / Workers Scripts / Read
- Account Resources: include exactly the accounts in your config, nothing else
- No zone resources, no other permissions

## 5. First deploy

```bash
npm run deploy
```

`npm run deploy` first applies any database migrations that are not applied yet, then builds
and deploys. In a terminal wrangler asks before migrating (without one it applies them without
asking). If you answer no or a migration fails, nothing is deployed: the deploy only goes ahead
when no migration is left to apply. Use it for every later release too, never `wrangler deploy`
on its own.

The deploy creates the custom domain under `routes`. The first cron run, within five minutes,
records the current state without sending email. The dashboard's "checked N min ago" should reset
every five minutes. The Worker is also reachable at its workers.dev address (`workers_dev` is on,
preview URLs are off).

## 6. Secrets

Each command asks for the value; paste the token there. One `GITHUB_TOKEN_<KEY>` per entry in
`github`:

```bash
npx wrangler secret put GITHUB_TOKEN_PERSONAL
npx wrangler secret put SUPABASE_TOKEN
npx wrangler secret put CF_TOKEN
```

This step comes after the first deploy on purpose. Without a deployed Worker, wrangler 4.152
offers to create an empty placeholder Worker to hold the secret (the default answer is yes); the
first real deploy then replaces it. That works, but deploying first avoids the detour.

Until a secret is set its source is "not configured", which is not a failure and sends nothing;
the first run after it is set records what it finds without email. Deleting a secret later
freezes its source: the checks it stored are kept as they were and left off the dashboard until
the secret is back, and the run after that reports only what changed in the meantime.

## 7. Sign in

Open the dashboard on your phone, add the page to the home screen, and in the home-screen app
press "Email me a sign-in code". The email goes to the alert address, so step 2 must be done.
Type the code from the email (like `ABCD-2345`; lower case and leaving out the dash are fine) on
the same screen. It works once, for 15 minutes, and only in the browser that asked for it: on an
iPhone the home-screen app and Safari are separate browsers, so ask for the code in the one you
want signed in.

The email also has a link. It signs in the browser that opens it, which is handy on a laptop but
not for the home-screen app. Using either the code or the link makes the other one void.

Limits: 5 wrong codes per email, 5 emails an hour and 20 a day for everyone together. When the
page says "Try again later", wait, or use the terminal.

### From the terminal (fallback)

When no email arrives or the limit is reached:

```bash
npm run signin-link
```

It refuses to run without a `stackhush.config.ts` of your own (missing, or still the example).
Open the printed link in the browser that needs signing in (it works once, for 15 minutes). The
link points at `dashboardUrl`; to sign in at another address of the same Worker, add
`-- --url https://<that address>`.

## 8. Switch off the platform emails

Once a test alert has arrived (for example after a deliberate failure), turn off the GitHub,
Vercel, Cloudflare and Supabase notification emails at the source. Billing, domain renewal and
account security emails stay on.

## 9. Push notifications (optional)

The dashboard can also send a push notification to your phone whenever it sends an alert email.
Without this step nothing changes: the dashboard says push is not set up, and email works as
before.

Push needs a key pair of its own (a VAPID pair, RFC 8292) that proves to the phone's push
service that a message comes from your Worker. Make it once, after the first deploy:

```bash
npm run push-keys
```

It makes the pair in memory and hands each key to `wrangler secret put` on standard input, as
the secrets `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. The private key is never shown and
never written to a file, so there is nothing to keep safe or to paste. Like `signin-link`, it
refuses to run without a `stackhush.config.ts` of your own. `npm run push-keys -- --dry-run`
makes a pair, shows its public key and stores nothing.

- `VAPID_PUBLIC_KEY` is the 65-byte uncompressed P-256 public key and `VAPID_PRIVATE_KEY` the
  32-byte private scalar, both as unpadded base64url. That is the form other Web Push tools
  use, so a pair you already have works too: set both with `npx wrangler secret put`.
- Set both or neither. With one missing, or values that are not such keys, the dashboard shows
  the problem "Push keys are not valid" and sends no notifications. If the script stops after
  the first key, run it again.
- Running the script again replaces the pair. Subscriptions belong to the pair they were made
  with, so afterwards every device has to turn notifications off and on again. To drop the old
  ones at once:
  `npx wrangler d1 execute DB --remote --command "DELETE FROM push_subscriptions"`.
- To switch push off, delete both secrets (`npx wrangler secret delete VAPID_PUBLIC_KEY`, and
  the same for `VAPID_PRIVATE_KEY`). Stored subscriptions are kept and simply not used.

Each device that has notifications on costs one subrequest in a run, see the next section. At
most 10 devices are kept; an eleventh replaces the oldest.

Upgrading an installation from 0.1: `npm run deploy` applies the new migration
(`0003_push.sql`) before it deploys. Nothing else is needed, and nothing changes until the keys
are set.

## 10. Notifications on the phone

After step 9, open the dashboard on the phone and sign in.

- **iPhone and iPad:** open it in Safari, choose Share, then Add to Home Screen, and open the
  new icon. Notifications and the badge only work in that Home Screen app (iOS 16.4 or later).
- **Android and desktop Chrome:** the browser works as it is; installing the page also works.

At the bottom of the page, under Notifications, tap "Turn on notifications" and allow them when
asked. "Send test notification" checks the whole path (5 an hour). "Turn off" and signing out
both remove this device. If the page says push is not set up, step 9 is missing; if
notifications are blocked, allow them in the browser or phone settings and reload.

If you run `npm run push-keys` again, every device has to turn notifications off and on again
(a device notices the new key by itself and subscribes again when the page is open).

## Bigger setups: the subrequest budget

stackhush makes every check in every run. The Workers Free plan allows 50 subrequests per cron
run; `subrequestBudget` is how many a run may make, 45 unless the config says otherwise, and a
run never makes more.

A run needs one subrequest per uptime URL, one per repo plus six per GitHub token (one batched
call and room for five workflow lookups), one for Supabase and two per Cloudflare account with
Workers. Calls to D1 and the email service have their own limit and are not counted. A config
that needs more than the budget is refused, at build, at Worker start and by `npm run deploy`,
with a message that says how many it needs. The way out is fewer checks or, on Workers Paid,
where the per-run limit is much higher, a higher `subrequestBudget`. On Workers Free, keep it at
50 or below.

What the budget has left after those calls pays for the redirects of uptime checks, which
stackhush follows itself (up to 5) and counts. A redirect there is no subrequest left for is not
followed: the site keeps the state it had, and the dashboard shows "Over the subrequest budget"
for that URL until it fits (see [limits.md](limits.md)).

Push notifications come out of the same budget: one subrequest per device with notifications
on, set aside in every run after the redirects that are already known. A setup that plans 43
of a budget of 50 and follows 3 redirects has room for 4 devices. Devices that do not fit get
no notification (the email is sent all the same) and the dashboard says "Over the subrequest
budget: no push notification for N devices".

Checks that take turns across runs, so that a big setup fits the Free plan, are not in this
version. They may come later.

## Local development

See also [CONTRIBUTING.md](../CONTRIBUTING.md).

```bash
npm run db:migrate:local
npm run seed:local          # synthetic state: problems, review requests, a paused Supabase, events
npm run dev                 # http://localhost:5173
npm run signin-link:local   # then open the printed link
```

Without a `stackhush.config.ts` the npm scripts that read it (`seed:local`, `dev`,
`signin-link:local`) copy the example config first. No tokens are needed: local development runs
on the seeded state.

Without tokens, the local dashboard lists the GitHub, Supabase and Cloudflare sources as "not
configured" and hides their checks, so a project with only a repo has no card. Recent changes
still lists the seeded events for them. `npm run screenshots` shows the configured view: it starts
the dev server with placeholder tokens, which are never sent anywhere.

`npm run dev` always uses port 5173 and refuses to pick another, so the local sign-in link
(which points at `localhost:5173`) always matches. If another server holds only 127.0.0.1:5173,
open `http://localhost:5173`. To use another port, pass it to both:
`npm run dev -- --port 5174` and `node scripts/signin-link.ts --local --url http://localhost:5174`.

Push notifications are off locally unless you give the local Worker keys of its own: put
`VAPID_PUBLIC_KEY=...` and `VAPID_PRIVATE_KEY=...` in a `.dev.vars` file (git-ignored), in the
form described in step 9. Never use the keys of a real installation there.

"Email me a sign-in code" also works locally: no email is sent, the local email binding prints
the path of a text file with the message to the dev server's output. The link in it points at
`dashboardUrl`; use the typed code.
