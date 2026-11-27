import { useNotifications } from '../hooks/useNotifications.ts';

const BUTTON = 'min-h-11 rounded-lg border border-line bg-surface px-4 text-sm disabled:opacity-60';

interface NotificationsProps {
  /** From GET /api/status; null when push is not set up on the server. */
  vapidPublicKey: string | null;
}

export default function Notifications({ vapidPublicKey }: NotificationsProps) {
  const { mode, busy, message, turnOn, turnOff, test } = useNotifications(vapidPublicKey);

  return (
    <div className="rounded-xl border border-line bg-surface p-4 text-sm">
      {mode === 'checking' && <p className="text-muted">Checking...</p>}
      {mode === 'unsupported' && (
        <p>This browser cannot show notifications. The alert emails still arrive.</p>
      )}
      {mode === 'ios-install' && (
        <p>
          Add to Home Screen first, then open it from there. On iPhone and iPad, notifications and
          the badge only work in the Home Screen app: in Safari choose Share, then Add to Home
          Screen.
        </p>
      )}
      {mode === 'not-set-up' && (
        <p>
          Push is not set up on this installation. See step 9 in docs/setup.md (
          <code>npm run push-keys</code>). The alert emails are not affected.
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
      {message !== '' && (
        <p className="mt-3 text-muted" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
