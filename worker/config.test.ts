import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import exampleConfig from '../stackhush.config.example.ts';
import {
  DEFAULT_SUBREQUEST_BUDGET,
  defineConfig,
  githubTokenSecretName,
  listSources,
  plannedSubrequests,
  type StackhushConfig,
} from './config.ts';

function valid(): StackhushConfig {
  return {
    dashboardUrl: 'https://status.example.test',
    alertTo: 'owner@example.test',
    alertFrom: 'stackhush@alerts.example.test',
    github: [{ key: 'my-org', owner: 'Acme-Org', logins: ['octo-me'] }],
    cloudflare: [{ key: 'main', accountId: '11111111111111111111111111111111' }],
    groups: ['Work'],
    projects: [
      {
        id: 'shop',
        name: 'Shop',
        group: 'Work',
        github: { owner: 'my-org', repo: 'shop.web' },
        productionUrls: ['https://shop.example.test'],
        supabaseRef: 'abcdefghijklmnopqrst',
        cloudflare: { account: 'main', scripts: ['shop-api'] },
      },
    ],
  };
}

function problemsOf(change: (config: StackhushConfig) => void): string {
  const config = valid();
  change(config);
  try {
    defineConfig(config);
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
  return '';
}

describe('defineConfig', () => {
  it('fills in the defaults and builds the repo name from the owner', () => {
    const config = defineConfig(valid());
    expect(config.subrequestBudget).toBe(DEFAULT_SUBREQUEST_BUDGET);
    expect(config.projects[0]).toEqual({
      id: 'shop',
      name: 'Shop',
      group: 'Work',
      github: {
        fullName: 'Acme-Org/shop.web',
        ownerKey: 'my-org',
        defaultBranch: 'main',
        watchDeployments: false,
      },
      productionUrls: ['https://shop.example.test'],
      supabaseRef: 'abcdefghijklmnopqrst',
      cloudflare: { accountKey: 'main', scripts: ['shop-api'] },
    });
  });

  it('accepts a project with nothing but a name and a group', () => {
    const config = defineConfig({
      ...valid(),
      github: undefined,
      cloudflare: undefined,
      projects: [{ id: 'idea', name: 'Idea', group: 'Work' }],
    });
    expect(config.projects[0]).toMatchObject({
      github: null,
      productionUrls: [],
      supabaseRef: null,
      cloudflare: null,
    });
  });

  it('keeps URLs exactly as written, because they are part of stored check keys', () => {
    const config = defineConfig({
      ...valid(),
      projects: [
        { id: 'a', name: 'A', group: 'Work', productionUrls: ['https://Example.test/Path/'] },
      ],
    });
    expect(config.projects[0]?.productionUrls).toEqual(['https://Example.test/Path/']);
  });

  it('names the secret of a GitHub owner after its key', () => {
    expect(githubTokenSecretName('personal')).toBe('GITHUB_TOKEN_PERSONAL');
    expect(githubTokenSecretName('my-org')).toBe('GITHUB_TOKEN_MY_ORG');
    expect(githubTokenSecretName('team_2')).toBe('GITHUB_TOKEN_TEAM_2');
  });

  it('lists the sources with the keys stored in source_health', () => {
    expect(listSources(defineConfig(valid()))).toEqual([
      { source: 'uptime', label: 'Uptime checks' },
      { source: 'github:my-org', label: 'GitHub (Acme-Org)' },
      { source: 'supabase', label: 'Supabase' },
      { source: 'cloudflare:main', label: 'Cloudflare (main)' },
    ]);
  });

  it.each<[string, (config: StackhushConfig) => void, string]>([
    [
      'a dashboard URL with a path',
      (c) => (c.dashboardUrl = 'https://x.test/status'),
      'dashboardUrl',
    ],
    ['a dashboard URL without https', (c) => (c.dashboardUrl = 'http://x.test'), 'dashboardUrl'],
    ['a recipient that is no address', (c) => (c.alertTo = 'owner'), 'alertTo'],
    ['a sender that is no address', (c) => (c.alertFrom = 'alerts.example.test'), 'alertFrom'],
    [
      'a duplicate project id',
      (c) => c.projects.push({ ...c.projects[0]!, supabaseRef: undefined, cloudflare: undefined }),
      'project id "shop" is used twice',
    ],
    ['the reserved project id', (c) => (c.projects[0]!.id = 'unassigned'), 'reserved'],
    ['a project id with a separator', (c) => (c.projects[0]!.id = 'a|b'), 'must not be empty'],
    ['an unknown group', (c) => (c.projects[0]!.group = 'Nope'), 'group "Nope" is not in groups'],
    ['a group listed twice', (c) => c.groups.push('Work'), 'group "Work" is listed twice'],
    [
      'an unknown GitHub owner key',
      (c) => (c.projects[0]!.github!.owner = 'Acme-Org'),
      'is not a key in github (my-org)',
    ],
    [
      'a repo written with its owner',
      (c) => (c.projects[0]!.github!.repo = 'acme/shop'),
      'repo name only',
    ],
    ['an upper-case owner key', (c) => (c.github![0]!.key = 'MyOrg'), 'github key "MyOrg"'],
    [
      'two owner keys with one secret name',
      (c) => c.github!.push({ key: 'my_org', owner: 'x', logins: [] }),
      'GITHUB_TOKEN_MY_ORG',
    ],
    [
      'two entries for one GitHub owner',
      (c) => c.github!.push({ key: 'second', owner: 'acme-org', logins: [] }),
      'github owner "acme-org" has two entries',
    ],
    ['a key that ends in a separator', (c) => (c.github![0]!.key = 'my-org-'), '"my-org-"'],
    [
      'a key with a doubled separator',
      (c) => (c.github![0]!.key = 'my--org'),
      'with single - or _ between them',
    ],
    [
      'a login that cannot exist',
      (c) => (c.github![0]!.logins = ['not a login']),
      'is not a GitHub login',
    ],
    [
      'an unknown Cloudflare account key',
      (c) => (c.projects[0]!.cloudflare!.account = 'other'),
      'is not a key in cloudflare (main)',
    ],
    [
      'a malformed Cloudflare account id',
      (c) => (c.cloudflare![0]!.accountId = 'abc'),
      '32 hex characters',
    ],
    [
      'a URL that is not http(s)',
      (c) => (c.projects[0]!.productionUrls = ['shop.example.test']),
      'is not an http(s) URL',
    ],
    [
      'a URL listed twice',
      (c) => (c.projects[0]!.productionUrls = ['https://a.test', 'https://a.test']),
      'listed twice',
    ],
    [
      'a malformed Supabase ref',
      (c) => (c.projects[0]!.supabaseRef = 'https://x.supabase.co'),
      'supabaseRef',
    ],
    [
      'a config that plans one subrequest more than the budget',
      (c) => (c.subrequestBudget = 10),
      'this config needs 11 subrequests every run and subrequestBudget is 10: remove checks, or on Workers Paid raise subrequestBudget',
    ],
    [
      'a fractional budget',
      (c) => (c.subrequestBudget = 45.5),
      'subrequestBudget must be a whole number above 0',
    ],
    ['a budget of nothing', (c) => (c.subrequestBudget = 0), 'subrequestBudget must be a whole'],
  ])('refuses %s', (_, change, expected) => {
    expect(problemsOf(change)).toContain(expected);
  });

  it.each<[string, unknown, string]>([
    ['no projects', { projects: undefined }, '- projects is missing'],
    ['no groups', { groups: undefined }, '- groups is missing'],
    ['no alert address', { alertTo: undefined }, '- alertTo is missing'],
    ['projects that are not a list', { projects: {} }, '- projects must be a list'],
    ['a budget in quotes', { subrequestBudget: '45' }, '- subrequestBudget must be a number'],
    [
      'an owner without logins',
      { github: [{ key: 'my-org', owner: 'Acme-Org' }] },
      '- github[0].logins is missing',
    ],
    [
      'an account without an id',
      { cloudflare: [{ key: 'main' }] },
      '- cloudflare[0].accountId is missing',
    ],
    [
      'a project without a name',
      { projects: [{ id: 'shop', group: 'Work' }] },
      '- projects[0].name is missing',
    ],
    [
      'a repo without its owner key',
      { projects: [{ id: 'shop', name: 'Shop', group: 'Work', github: { repo: 'shop' } }] },
      '- projects[0].github.owner is missing',
    ],
    [
      'Worker scripts as one string',
      {
        projects: [
          { id: 's', name: 'S', group: 'Work', cloudflare: { account: 'main', scripts: 'api' } },
        ],
      },
      '- projects[0].cloudflare.scripts must be a list of strings',
    ],
    [
      'one URL instead of a list',
      { projects: [{ id: 's', name: 'S', group: 'Work', productionUrls: 'https://a.test' }] },
      '- projects[0].productionUrls must be a list of strings',
    ],
  ])('names what is wrong with %s instead of crashing', (_, change, expected) => {
    // What a config file can hold once its types are ignored, as plain JavaScript would.
    const broken: StackhushConfig = Object.assign(valid(), change);
    expect(() => defineConfig(broken)).toThrow('Invalid stackhush.config.ts');
    expect(() => defineConfig(broken)).toThrow(expected);
  });

  it('says so when the config is not an object at all', () => {
    expect(() => defineConfig(undefined as unknown as StackhushConfig)).toThrow(
      'Invalid stackhush.config.ts',
    );
  });

  it('accepts a config that plans exactly the budget', () => {
    // 1 URL + 1 repo + 6 for its token + 1 Supabase + 2 for the Cloudflare account = 11.
    const config = defineConfig({ ...valid(), subrequestBudget: 11 });
    expect(plannedSubrequests(config)).toBe(11);
  });

  it('plans one per URL and repo, six per token with repos, Supabase, two per account in use', () => {
    const config = defineConfig({
      ...valid(),
      github: [
        { key: 'one', owner: 'acme', logins: [] },
        { key: 'two', owner: 'acme-org', logins: [] },
        { key: 'unused', owner: 'nobody', logins: [] },
      ],
      cloudflare: [
        { key: 'main', accountId: '11111111111111111111111111111111' },
        { key: 'unused', accountId: '22222222222222222222222222222222' },
      ],
      projects: [
        {
          id: 'a',
          name: 'A',
          group: 'Work',
          github: { owner: 'one', repo: 'a' },
          productionUrls: ['https://a.example.test', 'https://admin.a.example.test'],
          cloudflare: { account: 'main', scripts: ['a-api', 'a-jobs'] },
        },
        { id: 'b', name: 'B', group: 'Work', github: { owner: 'one', repo: 'b' } },
        { id: 'c', name: 'C', group: 'Work', github: { owner: 'two', repo: 'c' } },
      ],
    });
    // 2 URLs + 3 repos + 2 tokens x 6 + 1 + 1 account x 2.
    expect(plannedSubrequests(config)).toBe(20);
    // A source without its token is not called.
    const tokens = { github: (key: string) => key === 'two', supabase: false, cloudflare: false };
    expect(plannedSubrequests(config, tokens)).toBe(2 + 1 + 6);
  });

  it('refuses the default budget for a config that is too big for it, and says what to do', () => {
    const projects = Array.from({ length: 45 }, (_, index) => ({
      id: `site-${index}`,
      name: `Site ${index}`,
      group: 'Work',
      productionUrls: [`https://site-${index}.example.test`],
    }));
    const tooBig = { ...valid(), github: undefined, cloudflare: undefined, projects };
    expect(() => defineConfig(tooBig)).toThrow(
      'this config needs 46 subrequests every run and subrequestBudget is 45: remove checks, or on Workers Paid raise subrequestBudget',
    );
    expect(defineConfig({ ...tooBig, subrequestBudget: 46 }).projects).toHaveLength(45);
  });

  it('reports every problem at once', () => {
    const message = problemsOf((config) => {
      config.alertTo = 'nobody';
      config.groups = [];
    });
    expect(message).toContain('Invalid stackhush.config.ts');
    expect(message).toContain('alertTo');
    expect(message).toContain('group "Work" is not in groups');
  });
});

describe('the files a fresh clone starts from', () => {
  it('has a valid example config that exercises every kind of entry', () => {
    expect(exampleConfig.githubOwners).toHaveLength(2);
    expect(exampleConfig.cloudflareAccounts).toHaveLength(1);
    expect(exampleConfig.projects.some((project) => project.supabaseRef !== null)).toBe(true);
    expect(exampleConfig.projects.some((project) => project.github === null)).toBe(false);
    for (const project of exampleConfig.projects) {
      for (const url of project.productionUrls)
        expect(new URL(url).hostname).toMatch(/\.example\.com$/);
    }
  });

  it('lets uptime checks reach Workers on the same account over the public internet', () => {
    // Without this flag a fetch to another Worker on the account's workers.dev subdomain fails
    // with error 1042.
    // The template copy (scripts/check-templates.ts keeps it equal to the shipped file).
    const wrangler = readFileSync(
      join(import.meta.dirname, 'testing', 'wrangler.template.jsonc'),
      'utf8',
    );
    expect(wrangler).toMatch(/"compatibility_flags":\s*\[[^\]]*"global_fetch_strictly_public"/);
  });
});
