// What is checked before anything touches a live installation: `npm run deploy`
// (scripts/check-config.ts --deploy) and `npm run signin-link` (scripts/signin-link.ts --remote).
// That wrangler.jsonc and the config are no longer the templates, and that the two files agree
// where they must. Pure, so it is tested; it is not part of the Worker.

import type { Config } from './config.ts';

// The ids wrangler.jsonc ships with, until a real account and database are filled in.
const PLACEHOLDER_IDS: readonly string[] = [
  '00000000000000000000000000000000',
  '00000000-0000-0000-0000-000000000000',
];
// Every made-up address in the templates is on this domain, which nobody can own.
const EXAMPLE_DOMAIN = 'example.com';

/**
 * Why the installed config cannot be used against a live installation: there is none, or it is
 * still the example. `installed` is the text of stackhush.config.ts, null when the file does not
 * exist. Null when it is the owner's own config. Deploying and making a remote sign-in link
 * both check this first, so neither ever acts on the made-up example.
 */
export function installedConfigProblem(installed: string | null, example: string): string | null {
  if (installed === null) {
    return 'there is no stackhush.config.ts. Copy stackhush.config.example.ts and describe your own projects first.';
  }
  if (installed === example) {
    return 'stackhush.config.ts is still the example. Describe your own projects first.';
  }
  return null;
}

/** Removes // and block comments from JSONC, leaving strings (which may hold '//') alone. */
function stripComments(jsonc: string): string {
  let output = '';
  let index = 0;
  while (index < jsonc.length) {
    const char = jsonc[index] ?? '';
    const pair = jsonc.slice(index, index + 2);
    if (char === '"') {
      // Copy the whole string, minding escaped quotes.
      let end = index + 1;
      while (end < jsonc.length && jsonc[end] !== '"') end += jsonc[end] === '\\' ? 2 : 1;
      output += jsonc.slice(index, end + 1);
      index = end + 1;
    } else if (pair === '//') {
      const end = jsonc.indexOf('\n', index);
      index = end === -1 ? jsonc.length : end;
    } else if (pair === '/*') {
      const end = jsonc.indexOf('*/', index + 2);
      index = end === -1 ? jsonc.length : end + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The objects in a list field of the wrangler config; empty when the field is not a list. */
function records(wrangler: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const list = wrangler[field];
  return Array.isArray(list) ? (list as unknown[]).filter(isRecord) : [];
}

/** A field that should hold text; anything else reads as empty, which matches nothing. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Every route pattern of the config. wrangler takes `routes` (a list) and `route` (one), and
 * each entry is either the pattern itself or an object with a `pattern`.
 */
function routePatterns(wrangler: Record<string, unknown>): string[] {
  const list = wrangler['routes'];
  const entries: unknown[] = [
    ...(Array.isArray(list) ? (list as unknown[]) : []),
    wrangler['route'],
  ];
  return entries
    .map((entry) => (isRecord(entry) ? text(entry['pattern']) : text(entry)))
    .filter((pattern) => pattern !== '');
}

/** The host part of a route pattern: 'https://Status.mine.dev/*' -> 'status.mine.dev'. */
function routeHost(pattern: string): string {
  const withoutScheme = pattern.replace(/^[a-z]+:\/\//i, '');
  return (withoutScheme.split('/')[0] ?? '').toLowerCase();
}

/** Whether a route host, which may start with a `*` wildcard, covers the dashboard's host. */
function routeServes(routeHostPattern: string, host: string): boolean {
  if (!routeHostPattern.startsWith('*')) return routeHostPattern === host;
  // '*.mine.dev' is any subdomain; '*mine.dev' is those and mine.dev itself.
  return host.endsWith(routeHostPattern.slice(1));
}

function isExampleHost(host: string): boolean {
  return host === EXAMPLE_DOMAIN || host.endsWith(`.${EXAMPLE_DOMAIN}`);
}

function hostOfAddress(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** The reasons not to deploy; empty when there are none. */
export function deployProblems(config: Config, wranglerJsonc: string): string[] {
  let wrangler: unknown;
  try {
    // wrangler.jsonc may also end lists and objects with a comma.
    wrangler = JSON.parse(stripComments(wranglerJsonc).replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return ['wrangler.jsonc could not be read as JSON with comments.'];
  }
  if (!isRecord(wrangler)) return ['wrangler.jsonc is not an object.'];
  const problems: string[] = [];

  const databaseIds = records(wrangler, 'd1_databases').map((database) => database['database_id']);
  if ([wrangler['account_id'], ...databaseIds].some((id) => PLACEHOLDER_IDS.includes(text(id)))) {
    problems.push('wrangler.jsonc still has the all-zero account or database id.');
  }

  const dashboardHost = new URL(config.dashboardUrl).hostname;
  const exampleValues = [
    ...(isExampleHost(dashboardHost) ? [`dashboardUrl ${config.dashboardUrl}`] : []),
    ...[config.alertTo, config.alertFrom].filter((address) =>
      isExampleHost(hostOfAddress(address)),
    ),
    ...config.projects
      .flatMap((project) => project.productionUrls)
      .filter((url) => isExampleHost(new URL(url).hostname)),
  ];
  if (exampleValues.length > 0) {
    problems.push(
      `stackhush.config.ts still has ${EXAMPLE_DOMAIN} values: ${exampleValues.join(', ')}.`,
    );
  }

  // The binding can only send to its destination_address, so a different alertTo would mean no
  // alert and no sign-in email ever arrives.
  const destinations = records(wrangler, 'send_email')
    .filter((binding) => binding['name'] === 'ALERT_EMAIL')
    .map((binding) => text(binding['destination_address']));
  const [destination] = destinations;
  if (destination === undefined || destinations.length > 1) {
    problems.push('wrangler.jsonc must have exactly one send_email binding named ALERT_EMAIL.');
  } else if (destination.toLowerCase() !== config.alertTo.toLowerCase()) {
    problems.push(
      'alertTo in stackhush.config.ts is not the destination_address of the ALERT_EMAIL binding in wrangler.jsonc.',
    );
  }

  // With routes, emails must link to a host one of them serves. Without routes the Worker is
  // served at its workers.dev address, which this file does not know.
  const patterns = routePatterns(wrangler);
  const hosts = patterns.map(routeHost);
  if (hosts.some((host) => isExampleHost(host.replace(/^\*\.?/, '')))) {
    problems.push(`wrangler.jsonc still has an ${EXAMPLE_DOMAIN} route.`);
  } else if (hosts.length > 0 && !hosts.some((host) => routeServes(host, dashboardHost))) {
    problems.push(
      `dashboardUrl (${dashboardHost}) is not served by any route in wrangler.jsonc (${patterns.join(', ')}).`,
    );
  }
  return problems;
}
