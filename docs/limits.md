# Known limits

Things stackhush does not do, or does only partly. The subrequest budget is described in
[setup.md](setup.md#bigger-setups-the-subrequest-budget).

**A workflow deleted or switched off while it was failing can stay red.** CI stays red for a
workflow until a newer run of it succeeds. A deleted workflow never runs again, so stackhush
looks such workflows up on GitHub. One that is gone is forgotten and remembered as gone: its old
runs are ignored from then on, without another lookup, until it has a new run (re-running an old
run does not count: if you switch a workflow back on, its failure shows again at its next fresh
run, from a push or its schedule). The lookup does not happen in two cases:

- More than 5 failing workflows under one GitHub token that all need a lookup at the same time.
  Only 5 are looked up per run (by repo name, then workflow id), to stay inside the request
  limit of the Workers Free plan. A deleted workflow further down the list stays red until it is
  among the first 5: when workflows ahead of it are fixed, get a newer run, or are themselves
  found gone (those no longer take a lookup). Once it has had its lookup it stays forgotten,
  whatever the other workflows do afterwards. One exception: while every run listed for that repo
  is cancelled, skipped or still running, the row stays red (and takes a lookup each run, without
  emails); it clears as soon as any workflow in the repo finishes a run.
- The deleted workflow still has a cancelled or skipped run that is newer than its failed run
  among the repo's 15 most recent runs on the default branch. That newer run makes it look alive.
  It clears by itself once newer runs push that run out of the 15; to clear it right away, delete
  that cancelled or skipped run in GitHub (Actions, the run, "Delete workflow run"). It is
  looked up and forgotten on the next run.

**A removed Vercel project keeps its Deploy row red.** Its last failed deployment stays on
GitHub. The reliable way to clear it is to set `watchDeployments` to `false` for that repo in
the config and deploy. Deleting the environment in the repo's settings (Settings, Environments)
may also work, but that is not verified: GitHub's documentation only says that deleting an
environment removes its secrets and protection rules, not its deployments.

**Without its token a source is frozen, not forgotten.** A source whose secret is missing or
deleted is "not configured": it is not called, it never counts as failing, and it sends nothing.
Its checks stay in the database exactly as they were and are left off the dashboard (the source is
listed as not configured under "Sources"). When the secret is set again the checks carry on from
there: what changed in the meantime is reported, what did not is not. While a source is not
configured, a project or repo taken out of the config keeps that source's rows too; they are
removed in the first run in which the source works again after its token is back (a run in which
it fails removes nothing).

**Every check runs every run, so the setup must fit the budget.** A run makes one subrequest per
uptime URL, one per repo plus six per GitHub token, one for Supabase and two per Cloudflare account
with Workers. A config that needs more than `subrequestBudget` (45 by default; the Workers Free
limit is 50) is refused with a message saying how many it needs. Bigger setups need Workers Paid
and a higher `subrequestBudget`. Spreading checks over several runs is not in this version; it may
come later.

**Redirects count, and one that does not fit is not followed.** Every redirect an uptime check
follows is a subrequest, so stackhush follows them itself (up to 5; a longer chain is a failed
check, "too many redirects"), counts them, and remembers per URL how many it took. They are paid
from what the budget has left after the planned calls: first the chains that were followed to the
end last time, then URLs whose last check ran short, then any new redirects (the first two in the
order of the config; redirects nobody knew about yet are paid from what is left in the order the
answers arrive, and from the next run on the config order applies). A chain that is known to
work is paid for as long as it fits, whatever other URLs start doing. A run never makes more
subrequests than `subrequestBudget`; calls to D1 and the email service have their own limit and
are not counted.

When a redirect has no subrequest left, it is not followed in that run. The site keeps the state
it had: it is not marked down or up, and no email is sent. The dashboard shows a problem, "Over the
subrequest budget: <url> needs at least N more; raise subrequestBudget or remove checks", for as
long as that is so. N is a lower bound: the rest of a chain that was never followed is not known.
Until then that site is not really being checked, so act on it: raise the budget (on
Workers Free up to 50), remove a check, or point the URL at where it redirects to.

When several URLs are over budget, the one earliest in the config is served first, even if a
later one would fit on its own; fix or remove the first one listed, or raise the budget. A URL
that ran short stays behind the chains that work until its own chain has been followed to the
end once; not being reachable in between does not change that. A run in which the redirect could
not be followed does not reset the count of failed checks, so two failures with such a run between
them count as two in a row.
