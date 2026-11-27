// The sign-in email (pure). Sent through the same binding as alert emails, which is pinned to
// the owner's address, so it cannot go to anyone else.

import { formatSigninCode } from '../shared/signinCode.ts';
import { escapeHtml, type AlertEmail } from './alerts.ts';

// Never the code: subjects show on lock screens and in notification previews.
const SUBJECT = 'stackhush sign-in code';

/**
 * The words come first and the codes last, so a notification preview of the body shows the
 * explanation rather than a code. linkUrl carries the long code in its fragment.
 */
export function composeSigninEmail(shortCode: string, linkUrl: string): AlertEmail {
  const code = formatSigninCode(shortCode);
  const intro =
    'Someone pressed "Email me a sign-in code" on stackhush. If that was not you, ignore this ' +
    'email: nobody can sign in without it. The code and the link below work once and expire in ' +
    '15 minutes.';
  const codeLine = 'Type this code on the screen that asked for it:';
  const linkLine =
    'Or, if you are reading this in the browser you want to sign in, open this link instead:';

  const text = `${intro}\n\n${codeLine}\n\n    ${code}\n\n${linkLine}\n${linkUrl}\n`;
  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">` +
    `<p>${escapeHtml(intro)}</p>` +
    `<p>${escapeHtml(codeLine)}</p>` +
    `<p style="font-family:ui-monospace,monospace;font-size:28px;letter-spacing:2px">${escapeHtml(code)}</p>` +
    `<p>${escapeHtml(linkLine)}<br><a href="${escapeHtml(linkUrl)}">Sign in to stackhush</a></p>` +
    `</body></html>`;

  return { subject: SUBJECT, text, html };
}
