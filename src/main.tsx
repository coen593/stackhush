import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { signIn, takeSigninCode } from './lib/api.ts';
import { forgetPendingCode } from './lib/pendingCode.ts';
import { registerServiceWorker } from './lib/push.ts';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// The code is used once, before React renders, so a re-run effect cannot spend it twice.
const code = takeSigninCode();
const signinOutcome = code === null ? 'none' : await signIn(code);
// Signed in through a link: a code asked for earlier in this browser is no longer waiting.
if (signinOutcome === 'signed-in') forgetPendingCode(window.localStorage);

registerServiceWorker();
createRoot(root).render(
  <StrictMode>
    <App signinOutcome={signinOutcome} />
  </StrictMode>,
);
