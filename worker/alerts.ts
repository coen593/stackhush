// The alert email: composing it (pure) and sending it through the Cloudflare Email Service
// binding. Nothing here logs a header or a message body.

import type { Config } from './config.ts';

export interface AlertEvent {
  id: string;
  title: string;
  linkUrl: string | null;
  occurredAt: string;
}

export interface AlertEmail {
  subject: string;
  text: string;
  html: string;
}

const MAX_SUBJECT_LENGTH = 120;

/** One email for everything that changed. Titles can hold PR titles, so everything is escaped. */
export function composeAlertEmail(events: readonly AlertEvent[], dashboardUrl: string): AlertEmail {
  const textItems = events.map((event) => {
    const lines = [`- ${event.title}`, `  ${event.occurredAt}`];
    if (event.linkUrl) lines.push(`  ${event.linkUrl}`);
    return lines.join('\n');
  });
  const text = `${textItems.join('\n\n')}\n\nDashboard: ${dashboardUrl}\n`;

  const htmlItems = events.map((event) => {
    const title = escapeHtml(event.title);
    const heading = event.linkUrl ? `<a href="${escapeHtml(event.linkUrl)}">${title}</a>` : title;
    return `<li style="margin-bottom:12px">${heading}<br><span style="color:#666">${escapeHtml(event.occurredAt)}</span></li>`;
  });
  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">` +
    `<ul style="padding-left:20px">${htmlItems.join('')}</ul>` +
    `<p><a href="${escapeHtml(dashboardUrl)}">Open the dashboard</a></p></body></html>`;

  return { subject: composeSubject(events), text, html };
}

/**
 * Names the single change, or counts them and lists as many as fit, newest first. After failed
 * sends one email can carry hours of changes, and the subject must not read as if the oldest
 * one (a site that has long been back up) were the news.
 */
export function composeSubject(events: readonly AlertEvent[]): string {
  const titles = [...events]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .map((event) => event.title);
  const [first] = titles;
  if (first === undefined) throw new Error('No events to put in an alert');
  const subject = titles.length === 1 ? first : `${titles.length} changes: ${titles.join(', ')}`;
  // Titles come from outside (PR titles): no line breaks may reach a header.
  const singleLine = [...subject].map((char) => (char.charCodeAt(0) < 32 ? ' ' : char)).join('');
  return singleLine.length > MAX_SUBJECT_LENGTH
    ? `${singleLine.slice(0, MAX_SUBJECT_LENGTH - 3)}...`
    : singleLine;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Sends the email to the config's alertTo. Throws if it was not accepted; the caller keeps the
 * alerts unsent.
 */
export async function sendAlertEmail(env: Env, config: Config, email: AlertEmail): Promise<void> {
  await env.ALERT_EMAIL.send({
    from: config.alertFrom,
    to: config.alertTo,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}
