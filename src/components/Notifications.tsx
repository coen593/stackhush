import type { PushStatus } from '../../shared/api.ts';
import { useNotifications } from '../hooks/useNotifications.ts';

const BUTTON = 'min-h-11 rounded-lg border border-line bg-surface px-4 text-sm disabled:opacity-60';

interface NotificationsProps {
  /** From GET /api/status. */
  push: PushStatus;
  /** Reloads the status, so the device count follows a change made here. */
  onChanged: () => void;
}

function deviceCount(devices: number): string {
  return devices === 1 ? '1 device' : `${devices} devices`;
}

export default function Notifications({ push, onChanged }: NotificationsProps) {
  const { mode, busy, message, turnOn, turnOff, test } = useNotifications(push, onChanged);

  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-sm">
      {mode === 'checking' && <p className="text-muted">Checking...</p>}
      {mode === 'unsupported' && (
        <p>This browser cannot show notifications. The alert emails still arrive.</p>
      )}
      {mode === 'ios-install' && (
        <div className="flex flex-col gap-2">
          <p>
            Add to Home Screen first, then open it from there. On iPhone and iPad, notifications and
            the badge only work in the Home Screen app: in Safari choose Share, then Add to Home
            Screen.
          </p>
          <p>
            The Home Screen app signs in on its own, apart from Safari. Inside it, choose "Email me
            a sign-in code" and type the code from the email there; the link in the email opens
            Safari instead.
          </p>
        </div>
      )}
      {mode === 'not-set-up' && (
        <p>
          Push is not set up on this installation. See step 9 in docs/setup.md (
          <code>npm run push-keys</code>). The alert emails are not affected.
        </p>
      )}
      {mode === 'invalid-keys' && (
        <p>
          The push keys on the server are not a valid pair, so no notifications are sent. Run{' '}
          <code>npm run push-keys</code> again (step 9 in docs/setup.md). The alert emails are not
          affected.
        </p>
      )}
      {mode === 'denied' && (
        <p>
          Notifications are blocked for this site. Allow them in your browser or phone settings
          (site settings in a browser, the app's entry in Settings on a phone), then reload this
          page.
        </p>
      )}
      {mode === 'off' && (
        <div className="flex flex-col items-start gap-3">
          <p>Get a notification on this device when an alert email is sent.</p>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void turnOn()}>
            Turn on notifications
          </button>
        </div>
      )}
      {mode === 'on' && (
        <div className="flex flex-col items-start gap-3">
          <p>Notifications are on for this device.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void test()}>
              Send test notification
            </button>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
        </div>
      )}
      {push.keys === 'ready' && push.devices > 0 && (
        <p className="mt-3 text-muted">
          Notifications are on for {deviceCount(push.devices)}. One you do not recognise means
          another browser is signed in.
        </p>
      )}
      {message !== '' && (
        <p className="mt-3 text-muted" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
