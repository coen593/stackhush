import { useState, type FormEvent } from 'react';
import { normalizeSigninCode } from '../../shared/signinCode.ts';
import { requestSigninCode, verifySigninCode } from '../lib/api.ts';
import { forgetPendingCode, hasPendingCode, rememberPendingCode } from '../lib/pendingCode.ts';

interface SignInProps {
  onSignedIn: () => void;
}

interface Notice {
  tone: 'info' | 'bad';
  text: string;
}

const TRY_LATER = 'Try again later.';
const UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

const PRIMARY_BUTTON =
  'min-h-14 w-full rounded-xl bg-accent px-4 text-lg font-semibold text-bg disabled:opacity-60';
const SECONDARY_BUTTON =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-4 text-sm disabled:opacity-60';

export default function SignIn({ onSignedIn }: SignInProps) {
  const [step, setStep] = useState<'ask' | 'enter-code'>(() =>
    hasPendingCode(window.localStorage, Date.now()) ? 'enter-code' : 'ask',
  );
  const [typed, setTyped] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const backToAsk = (text: string) => {
    forgetPendingCode(window.localStorage);
    setTyped('');
    setStep('ask');
    setNotice({ tone: 'bad', text });
  };

  const handleRequest = async () => {
    setNotice(null);
    setIsBusy(true);
    try {
      const outcome = await requestSigninCode();
      if (outcome === 'sent') {
        const isResend = step === 'enter-code';
        rememberPendingCode(window.localStorage, Date.now());
        setTyped('');
        setStep('enter-code');
        if (isResend) {
          setNotice({ tone: 'info', text: 'A new code is on its way. The earlier one is void.' });
        }
        return;
      }
      setNotice({ tone: 'bad', text: outcome === 'try-later' ? TRY_LATER : UNREACHABLE });
    } finally {
      setIsBusy(false);
    }
  };

  const handleVerify = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    const code = normalizeSigninCode(typed);
    if (code === null) {
      setNotice({ tone: 'bad', text: 'The code is 8 letters and digits, like ABCD-2345.' });
      return;
    }
    setIsBusy(true);
    try {
      const outcome = await verifySigninCode(code);
      if (outcome === 'signed-in') {
        forgetPendingCode(window.localStorage);
        onSignedIn();
      } else if (outcome === 'wrong-code') {
        setNotice({ tone: 'bad', text: 'That code is not right. Check the email and try again.' });
      } else if (outcome === 'too-many-attempts') {
        backToAsk('Too many wrong codes. Ask for a new code.');
      } else if (outcome === 'closed') {
        backToAsk('That code has expired or was already used. Ask for a new code.');
      } else {
        setNotice({ tone: 'bad', text: UNREACHABLE });
      }
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="mt-6 max-w-sm">
      {step === 'ask' && (
        <>
          <p className="text-muted">You are signed out.</p>
          <button
            type="button"
            className={`mt-4 ${PRIMARY_BUTTON}`}
            disabled={isBusy}
            onClick={() => void handleRequest()}
          >
            {isBusy ? 'Sending...' : 'Email me a sign-in code'}
          </button>
        </>
      )}
      {step === 'enter-code' && (
        <form onSubmit={(event) => void handleVerify(event)}>
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="mt-1 text-muted">
            Type the code from the email here. It works for 15 minutes.
          </p>
          <label htmlFor="signin-code" className="mt-4 block text-sm font-medium">
            Sign-in code
          </label>
          <input
            id="signin-code"
            name="code"
            className="mt-1 min-h-14 w-full rounded-xl border border-line bg-surface px-3 text-center font-mono text-2xl uppercase tracking-widest"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="XXXX-XXXX"
            maxLength={12}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-describedby={notice ? 'signin-notice' : undefined}
            aria-invalid={notice?.tone === 'bad'}
          />
          <button type="submit" className={`mt-3 ${PRIMARY_BUTTON}`} disabled={isBusy}>
            {isBusy ? 'One moment...' : 'Sign in'}
          </button>
          <button
            type="button"
            className={`mt-3 ${SECONDARY_BUTTON}`}
            disabled={isBusy}
            onClick={() => void handleRequest()}
          >
            Send a new code
          </button>
        </form>
      )}
      {notice && (
        <p
          id="signin-notice"
          className={`mt-4 text-sm ${notice.tone === 'bad' ? 'text-bad' : 'text-muted'}`}
          role={notice.tone === 'bad' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
      <p className="mt-8 text-sm text-muted">
        No email? Run npm run signin-link in the project and open the link it prints.
      </p>
    </div>
  );
}
