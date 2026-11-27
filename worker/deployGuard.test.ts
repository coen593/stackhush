import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import exampleConfig from '../stackhush.config.example.ts';
import { defineConfig, type Config } from './config.ts';
import { deployProblems, installedConfigProblem } from './deployGuard.ts';

// A copy of the wrangler.jsonc this repo ships, not the installed one: a fork fills in its own.
// scripts/check-templates.ts keeps the two identical upstream.
const TEMPLATE = readFileSync(
  join(import.meta.dirname, 'testing', 'wrangler.template.jsonc'),
  'utf8',
);

const config: Config = defineConfig({
  dashboardUrl: 'https://status.mysite.test',
  alertTo: 'Owner@mysite.test',
  alertFrom: 'stackhush@alerts.mysite.test',
  groups: ['All'],
  projects: [
    { id: 'site', name: 'Site', group: 'All', productionUrls: ['https://www.mysite.test'] },
  ],
});

/** A wrangler.jsonc as an installation would have it, comments and trailing commas included. */
function wrangler(overrides: { route?: string | null; destination?: string } = {}): string {
  const route = overrides.route === undefined ? 'status.mysite.test' : overrides.route;
  return `// The Worker. See https://example.com/docs for "routes".
{
  "name": "stackhush",
  /* pinned */ "account_id": "0123456789abcdef0123456789abcdef",
  "d1_databases": [
    { "binding": "DB", "database_id": "11111111-2222-3333-4444-555555555555", },
  ],
  ${route === null ? '' : `"routes": [{ "pattern": "${route}", "custom_domain": true }],`}
  "send_email": [
    {
      "name": "ALERT_EMAIL",
      // "destination_address": "someone-else@mysite.test",
      "destination_address": "${overrides.destination ?? 'owner@mysite.test'}",
    },
  ],
}
`;
}

/** The same file with its routes line replaced by the given JSONC. */
function wranglerWith(routes: string): string {
  return wrangler({ route: null }).replace('"send_email"', `${routes}\n  "send_email"`);
}

describe('the installed config', () => {
  const example = '// the example\nexport default {};\n';

  it('is refused for deploys and remote sign-in links when there is none', () => {
    expect(installedConfigProblem(null, example)).toContain('there is no stackhush.config.ts');
  });

  it('is refused when it is still the example, byte for byte', () => {
    expect(installedConfigProblem(example, example)).toContain('still the example');
  });

  it('is accepted once it differs from the example', () => {
    expect(installedConfigProblem(`${example}// mine\n`, example)).toBeNull();
  });

  it('is checked by the remote sign-in script before it loads the config or calls wrangler', () => {
    const script = readFileSync(
      join(import.meta.dirname, '..', 'scripts', 'signin-link.ts'),
      'utf8',
    );
    const guard = script.indexOf('installedConfigProblem(');
    expect(guard).toBeGreaterThan(-1);
    // Run for every --remote call, and it stops the script.
    expect(script).toMatch(
      /if \(values\.remote\) \{\s+const problem = installedConfigProblem\([^;]+;\s+if \(problem !== null\) \{\s+console\.error\([^\n]+\n\s+process\.exit\(1\);/,
    );
    expect(script).not.toMatch(/^import .*stackhush\.config/m);
    expect(guard).toBeLessThan(script.indexOf('await import(CONFIG_FILE)'));
    expect(guard).toBeLessThan(script.indexOf('execFileSync('));
    expect(guard).toBeLessThan(script.indexOf('generateToken()'));
  });

  it('is not put in place by a pre-hook of the remote sign-in script', () => {
    const scripts = (
      JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['presignin-link']).toBeUndefined();
    expect(scripts['signin-link']).toBe('node scripts/signin-link.ts --remote');
    expect(scripts['presignin-link:local']).toBe('npm run check-config');
  });
});

describe('the deploy guard', () => {
  it('lets a filled-in installation through', () => {
    expect(deployProblems(config, wrangler())).toEqual([]);
  });

  it('lets an installation without a custom domain through', () => {
    expect(deployProblems(config, wrangler({ route: null }))).toEqual([]);
  });

  it('refuses the files a fresh clone starts from, naming everything still to fill in', () => {
    const problems = deployProblems(exampleConfig, TEMPLATE).join('\n');
    expect(problems).toContain('all-zero account or database id');
    expect(problems).toContain('still has example.com values');
    expect(problems).toContain('https://status.example.com');
    expect(problems).toContain('example.com route');
  });

  it('refuses an alert address the email binding cannot send to', () => {
    expect(deployProblems(config, wrangler({ destination: 'other@mysite.test' }))).toEqual([
      'alertTo in stackhush.config.ts is not the destination_address of the ALERT_EMAIL binding in wrangler.jsonc.',
    ]);
  });

  it('refuses a dashboard URL that is not the custom domain', () => {
    expect(deployProblems(config, wrangler({ route: 'status.other.test' }))).toEqual([
      'dashboardUrl (status.mysite.test) is not served by any route in wrangler.jsonc (status.other.test).',
    ]);
  });

  it.each([
    [
      'a zone route with a path',
      '"routes": [{ "pattern": "status.mysite.test/*", "zone_name": "mysite.test" }],',
    ],
    ['routes written as strings', '"routes": ["other.mysite.test/*", "Status.MySite.test/*"],'],
    ['the singular route key', '"route": "status.mysite.test/*",'],
    [
      'a singular route object',
      '"route": { "pattern": "https://status.mysite.test/*", "zone_name": "mysite.test" },',
    ],
    [
      'a wildcard subdomain route',
      '"routes": [{ "pattern": "*.mysite.test/*", "zone_name": "mysite.test" }],',
    ],
    ['a wildcard that includes the apex', '"routes": ["*mysite.test/*"],'],
  ])('accepts %s that serves the dashboard host', (_, routes) => {
    expect(deployProblems(config, wranglerWith(routes))).toEqual([]);
  });

  it.each([
    [
      'a zone route for another host',
      '"routes": [{ "pattern": "other.mysite.test/*", "zone_name": "mysite.test" }],',
      'is not served by any route',
    ],
    [
      'string routes for another host',
      '"routes": ["other.mysite.test/*"],',
      'is not served by any route',
    ],
    ['a wildcard of another zone', '"routes": ["*.other.test/*"],', 'is not served by any route'],
    [
      'a wildcard that only covers subdomains of the host',
      '"route": "*.status.mysite.test/*",',
      'is not served by any route',
    ],
    [
      'a string route still on the example domain',
      '"routes": ["status.example.com/*"],',
      'example.com route',
    ],
    [
      'a singular route still on the example domain',
      '"route": "status.example.com/*",',
      'example.com route',
    ],
    [
      'a wildcard route on the example domain',
      '"routes": [{ "pattern": "*.example.com/*", "zone_name": "example.com" }],',
      'example.com route',
    ],
  ])('refuses %s', (_, routes, expected) => {
    const problems = deployProblems(config, wranglerWith(routes));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it('refuses a real config deployed with the template wrangler.jsonc', () => {
    const problems = deployProblems(config, TEMPLATE).join('\n');
    expect(problems).toContain('all-zero');
    expect(problems).toContain('not the destination_address');
    expect(problems).toContain('example.com route');
  });

  it('refuses a config that still watches the example sites', () => {
    const withExample = { ...config, projects: exampleConfig.projects };
    expect(deployProblems(withExample, wrangler()).join('\n')).toContain(
      'https://recipes.example.com',
    );
  });

  it('refuses a wrangler.jsonc it cannot read rather than guessing', () => {
    expect(deployProblems(config, '{ "name": ')).toEqual([
      'wrangler.jsonc could not be read as JSON with comments.',
    ]);
  });
});
