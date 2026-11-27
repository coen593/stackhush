import { useEffect, useState } from 'react';
import type { GroupView, StatusResponse } from '../shared/api.ts';
import Attention from './components/Attention.tsx';
import CheckRow from './components/CheckRow.tsx';
import Events from './components/Events.tsx';
import Header from './components/Header.tsx';
import Notifications from './components/Notifications.tsx';
import ProjectCard, { hasProblem } from './components/ProjectCard.tsx';
import SignIn from './components/SignIn.tsx';
import { useNow } from './hooks/useNow.ts';
import { useStatus } from './hooks/useStatus.ts';
import { errorText, signOut, type SigninOutcome } from './lib/api.ts';
import { forgetPendingCode } from './lib/pendingCode.ts';
import { clearCaches, setBadge, unsubscribeThisDevice } from './lib/push.ts';

const SIGNIN_FAILURES: Partial<Record<SigninOutcome, string>> = {
  rejected: 'That sign-in link did not work: it was already used, expired or mistyped.',
  unreachable:
    'Signing in failed: could not reach the server. Open the link again, and ask for a new link if this keeps happening.',
};

interface AppProps {
  signinOutcome: SigninOutcome;
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wider text-muted">
      {children}
    </h2>
  );
}

function Group({ group, now }: { group: GroupView; now: number }) {
  // Cards with a problem first, otherwise the order of the config.
  const projects = [...group.projects].sort(
    (a, b) => Number(hasProblem(b)) - Number(hasProblem(a)),
  );
  return (
    <section>
      <SectionTitle>{group.group}</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} now={now} />
        ))}
      </div>
    </section>
  );
}

interface DashboardProps {
  status: StatusResponse;
  refreshFailed: boolean;
  offlineAt: number | null;
  now: number;
  reload: () => void;
}

function Dashboard({ status, refreshFailed, offlineAt, now, reload }: DashboardProps) {
  return (
    <>
      <Header
        checkedAt={status.checkedAt}
        problemCount={status.problems.length}
        refreshFailed={refreshFailed}
        offlineAt={offlineAt}
        now={now}
      />
      <SectionTitle>Needs attention</SectionTitle>
      <Attention problems={status.problems} now={now} />
      {status.groups.map((group) => (
        <Group key={group.group} group={group} now={now} />
      ))}
      {status.unassigned.length > 0 && (
        <section>
          <SectionTitle>Unassigned</SectionTitle>
          <ProjectCard
            project={{
              id: 'unassigned',
              name: 'Supabase projects not in the config',
              sites: [],
              deploy: null,
              ci: null,
              pullRequests: null,
              supabase: null,
              workers: status.unassigned,
            }}
            now={now}
          />
        </section>
      )}
      <SectionTitle>Recent changes</SectionTitle>
      <Events events={status.events} now={now} />
      <SectionTitle>Sources</SectionTitle>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {status.sources.map((source) => (
          <CheckRow key={source.label} check={source} now={now} />
        ))}
      </div>
      <SectionTitle>Notifications</SectionTitle>
      <Notifications push={status.push} onChanged={reload} />
    </>
  );
}

export default function App({ signinOutcome }: AppProps) {
  const { state, reload, markSignedOut } = useStatus();
  const now = useNow();
  const signinFailure = SIGNIN_FAILURES[signinOutcome];
  const [signOutError, setSignOutError] = useState('');

  // Signed out (also when the session ended elsewhere): no number stays on the app icon.
  let problemCount: number | null = null;
  if (state.kind === 'ready') problemCount = state.status.problems.length;
  if (state.kind === 'signed-out') problemCount = 0;
  useEffect(() => {
    if (problemCount !== null) setBadge(problemCount);
  }, [problemCount]);

  const handleSignOut = async () => {
    setSignOutError('');
    try {
      // This device stops getting notifications, and nothing of the session stays on it. Only
      // a server that cannot be reached, or fails on a live session, stops the sign-out here;
      // clearing the caches and the badge is best effort.
      await unsubscribeThisDevice();
      await clearCaches();
      setBadge(0);
      await signOut();
      // A status request that was in flight may have stored a copy again.
      await clearCaches();
      // The signed-out page starts at the button, not at a code field from before.
      forgetPendingCode(window.localStorage);
      markSignedOut();
    } catch (error: unknown) {
      console.error('Signing out failed', error);
      setSignOutError(`Not signed out. ${errorText(error)}`);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-4 pb-12">
      {state.kind === 'loading' && <p className="pt-8 text-muted">Loading...</p>}
      {signinFailure !== undefined && state.kind !== 'ready' && state.kind !== 'loading' && (
        <p className="pt-8" role="alert">
          {signinFailure}
        </p>
      )}
      {state.kind === 'error' && (
        <p className="pt-8 text-bad" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === 'signed-out' && (
        <div className="pt-8">
          <h1 className="text-xl font-semibold">stackhush</h1>
          <SignIn onSignedIn={() => void reload()} />
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <Dashboard
            status={state.status}
            refreshFailed={state.refreshFailed}
            offlineAt={state.offlineAt}
            now={now}
            reload={() => void reload()}
          />
          <footer className="mt-10 border-t border-line pt-4">
            <button
              type="button"
              className="min-h-11 rounded-lg border border-line bg-surface px-4 text-sm"
              onClick={() => void handleSignOut()}
            >
              Sign out
            </button>
            {signOutError !== '' && (
              <p className="mt-2 text-sm text-bad" role="alert">
                {signOutError}
              </p>
            )}
          </footer>
        </>
      )}
    </main>
  );
}
