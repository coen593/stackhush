// Everything that differs between installations, as written in stackhush.config.ts at the repo
// root. defineConfig checks it and throws one error listing every problem, so a bad config stops
// the build (scripts/check-config.ts) and the Worker's start (worker/index.ts) rather than
// producing wrong checks. Server-side only: names, repos and URLs here are private and must
// never be imported from src/ (eslint enforces this).

/** A GitHub user or organisation whose repos are read with one fine-grained token. */
export interface GitHubOwner {
  /**
   * Short name used in project entries, in the source key ('github:<key>') and in the secret
   * that holds the token: GITHUB_TOKEN_<KEY in upper snake case>.
   */
  key: string;
  /** The login of the user or organisation that owns the repos, as in github.com/<owner>. */
  owner: string;
  /** Logins that are you: a review requested from one of them counts as requested from you. */
  logins: string[];
}

/** A Cloudflare account whose Workers are read with the one CF_TOKEN. */
export interface CloudflareAccount {
  /** Short name used in project entries and in the source key ('cloudflare:<key>'). */
  key: string;
  /** The 32-character account id, needed for the Analytics and Workers APIs. */
  accountId: string;
}

export interface ProjectConfig {
  /** Stable id, stored with every check. Changing it starts the project's state afresh. */
  id: string;
  name: string;
  /** One of `groups`. */
  group: string;
  github?: {
    /** The `key` of an entry in `github`. */
    owner: string;
    /** The repo name without the owner. */
    repo: string;
    /**
     * The branch whose CI is watched; 'main' when left out. Written here because a fine-grained
     * token without Contents permission cannot read a repo's default branch from the API.
     */
    defaultBranch?: string;
    /**
     * Whether GitHub Deployments say something useful about production (they do when a host
     * such as Vercel reports deploys to GitHub). False when left out.
     */
    watchDeployments?: boolean;
    /**
     * More branches whose CI is watched like the default branch, for example ['staging']. Each
     * gets a row and alerts of its own. Costs one more subrequest per run for the repo (shared
     * with `pullRequestChecks`).
     */
    extraBranches?: string[];
    /**
     * Whether the dashboard shows, on each open pull request, if the Actions runs on its head
     * commit are passing, failing or running. Shown only: it never alerts. False when left out.
     * Costs one more subrequest per run for the repo (shared with `extraBranches`).
     */
    pullRequestChecks?: boolean;
  };
  /** Checked for uptime. */
  productionUrls?: string[];
  /** The 20-character Supabase project ref. */
  supabaseRef?: string;
  cloudflare?: {
    /** The `key` of an entry in `cloudflare`. */
    account: string;
    /** Worker script names on that account. */
    scripts: string[];
  };
}

/** The shape of stackhush.config.ts. */
export interface StackhushConfig {
  /** Where the dashboard is served, for example 'https://status.example.com'. */
  dashboardUrl: string;
  /** Who gets the alert and sign-in emails. Must match the email binding in wrangler.jsonc. */
  alertTo: string;
  /** The sender, on a domain onboarded for Cloudflare Email Sending. */
  alertFrom: string;
  /**
   * How many subrequests a cron run may make. 45 when left out, which fits the Workers Free
   * limit of 50; raise it on Workers Paid. Every run makes every check, so a config that plans
   * more than this is refused.
   */
  subrequestBudget?: number;
  github?: GitHubOwner[];
  cloudflare?: CloudflareAccount[];
  /** Group names in the order the dashboard shows them. */
  groups: string[];
  projects: ProjectConfig[];
}

export interface GitHubRepo {
  /** 'owner/name'. */
  fullName: string;
  /** Which GitHubOwner (and so which token) reads it. */
  ownerKey: string;
  defaultBranch: string;
  watchDeployments: boolean;
  /** Branches besides the default one whose CI is watched; empty for most repos. */
  extraBranches: readonly string[];
  pullRequestChecks: boolean;
}

export interface CloudflareWorkers {
  accountKey: string;
  scripts: string[];
}

/** A project as the Worker uses it: every optional part of ProjectConfig filled in. */
export interface Project {
  /** Used as project_id in D1. Never 'unassigned', which is reserved. */
  id: string;
  name: string;
  group: string;
  github: GitHubRepo | null;
  /** Empty when the project has no public site. */
  productionUrls: string[];
  supabaseRef: string | null;
  cloudflare: CloudflareWorkers | null;
}

/** A checked StackhushConfig, in the shape the Worker uses. */
export interface Config {
  dashboardUrl: string;
  alertTo: string;
  alertFrom: string;
  subrequestBudget: number;
  githubOwners: readonly GitHubOwner[];
  cloudflareAccounts: readonly CloudflareAccount[];
  groups: readonly string[];
  projects: readonly Project[];
}

export const DEFAULT_SUBREQUEST_BUDGET = 45;
const DEFAULT_BRANCH = 'main';
/** project_id of Supabase projects the token sees that no project in the config names. */
export const UNASSIGNED_PROJECT_ID = 'unassigned';

/**
 * A failing workflow with no run newer than its failure is looked up, to notice that it was
 * deleted. Each lookup is a subrequest, so there are at most this many per token per run; a
 * workflow beyond that simply stays red (see docs/limits.md).
 */
export const MAX_WORKFLOW_LOOKUPS = 5;

// What a cron run costs in subrequests. Only fetches to other hosts count here: D1 and the
// email binding have a limit of their own. An uptime check is one request plus one for every
// redirect it follows; redirects are paid from what the budget has left after the plan.
const UPTIME_URL_COST = 1;
/** Redirects followed for one uptime check before it counts as failed. */
export const MAX_UPTIME_REDIRECTS = 5;
/** One call for a repo's workflow runs. */
const GITHUB_REPO_COST = 1;
/**
 * One more call, for the repo's recent runs on every branch, when the repo watches extra
 * branches or shows the checks of its pull requests (both read the same answer).
 */
const GITHUB_RECENT_RUNS_COST = 1;
/** Per token with at least one repo: the batched GraphQL call, and room for workflow lookups. */
const GITHUB_OWNER_COST = 1 + MAX_WORKFLOW_LOOKUPS;
const SUPABASE_COST = 1;
/** Analytics and the script list. */
const CLOUDFLARE_ACCOUNT_COST = 2;
// Every source's health row is named in one SQL statement, and D1 binds at most 100 values.
const MAX_GITHUB_OWNERS = 20;
const MAX_CLOUDFLARE_ACCOUNTS = 20;

// Lower-case words joined by single dashes or underscores, so the secret name is unambiguous.
const KEY_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
// A GitHub login: letters, digits and dashes, at most 39 characters.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO_PATTERN = /^[\w.-]+$/;
// A branch name as git allows it, without the rarer characters: parts of letters, digits, '.',
// '_' and '-' joined by single slashes, and no '..'. Stored in the check key ('ci:<branch>'), so
// no '|'.
const BRANCH_PATTERN = /^[A-Za-z0-9_-][\w.-]*(?:\/[A-Za-z0-9_-][\w.-]*)*$/;
const MAX_BRANCH_LENGTH = 100;
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const SUPABASE_REF_PATTERN = /^[a-z0-9]{20}$/;
// Stored in keys that are joined with '|', so no '|' and no white space.
const PROJECT_ID_PATTERN = /^[^\s|]+$/;
// Something@something.tld without spaces: enough to catch a typo, not a full address grammar.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The secret that holds the token of a GitHub owner: 'my-org' -> 'GITHUB_TOKEN_MY_ORG'. */
export function githubTokenSecretName(ownerKey: string): string {
  return `GITHUB_TOKEN_${ownerKey.toUpperCase().replaceAll('-', '_')}`;
}

export const UPTIME_SOURCE = 'uptime';
export const UPTIME_LABEL = 'Uptime checks';
export const SUPABASE_SOURCE = 'supabase';
export const SUPABASE_LABEL = 'Supabase';

export function githubSource(ownerKey: string): string {
  return `github:${ownerKey}`;
}

export function githubLabel(owner: GitHubOwner): string {
  return `GitHub (${owner.owner})`;
}

export function cloudflareSource(accountKey: string): string {
  return `cloudflare:${accountKey}`;
}

export function cloudflareLabel(account: CloudflareAccount): string {
  return `Cloudflare (${account.key})`;
}

export interface SourceName {
  /** Key in source_health, for example 'github:work'. */
  source: string;
  /** Names the source in alert titles and on the dashboard. */
  label: string;
}

/** Whether a run makes the extra call for the repo's recent runs on every branch. */
export function needsRecentRuns(repo: GitHubRepo): boolean {
  return repo.extraBranches.length > 0 || repo.pullRequestChecks;
}

/** Every source of a config, in the order the dashboard lists them. */
export function listSources(config: Config): SourceName[] {
  return [
    { source: UPTIME_SOURCE, label: UPTIME_LABEL },
    ...config.githubOwners.map((owner) => ({
      source: githubSource(owner.key),
      label: githubLabel(owner),
    })),
    { source: SUPABASE_SOURCE, label: SUPABASE_LABEL },
    ...config.cloudflareAccounts.map((account) => ({
      source: cloudflareSource(account.key),
      label: cloudflareLabel(account),
    })),
  ];
}

export function sourceLabel(config: Config, source: string): string {
  return listSources(config).find((item) => item.source === source)?.label ?? source;
}

/** Checks a config and returns it in the shape the Worker uses. Throws listing every problem. */
export function defineConfig(input: StackhushConfig): Config {
  // First that every field is there and of the right kind: the file may be plain JavaScript in
  // all but name, and the checks below would fail on a missing list with an error about
  // 'undefined' rather than about the config.
  const shape = shapeProblems(input);
  if (shape.length > 0) throw invalid(shape);

  const problems: string[] = [];
  const config: Config = {
    dashboardUrl: readDashboardUrl(input.dashboardUrl, problems),
    alertTo: input.alertTo,
    alertFrom: input.alertFrom,
    subrequestBudget: input.subrequestBudget ?? DEFAULT_SUBREQUEST_BUDGET,
    githubOwners: input.github ?? [],
    cloudflareAccounts: input.cloudflare ?? [],
    groups: input.groups,
    projects: input.projects.map((project) => resolveProject(project, input.github ?? [])),
  };
  if (!EMAIL_PATTERN.test(config.alertTo)) problems.push('alertTo is not an email address');
  if (!EMAIL_PATTERN.test(config.alertFrom)) problems.push('alertFrom is not an email address');
  checkGitHubOwners(config.githubOwners, problems);
  checkCloudflareAccounts(config.cloudflareAccounts, problems);
  checkGroups(config.groups, problems);
  checkProjects(config, input.projects, problems);
  checkBudget(config, problems);
  if (problems.length > 0) throw invalid(problems);
  return config;
}

function invalid(problems: readonly string[]): Error {
  return new Error(
    `Invalid stackhush.config.ts:\n${problems.map((line) => `- ${line}`).join('\n')}`,
  );
}

type Shape = 'string' | 'strings' | 'boolean' | 'number';

function hasShape(value: unknown, shape: Shape): boolean {
  if (shape === 'strings') {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
  return typeof value === shape;
}

/** Reports the fields of `value` that are missing or of the wrong kind. */
function fieldProblems(
  where: string,
  value: unknown,
  required: Readonly<Record<string, Shape>>,
  optional: Readonly<Record<string, Shape>> = {},
): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${where} must be an object`];
  }
  const fields: Record<string, unknown> = { ...value };
  const problems: string[] = [];
  const expect = (name: string, shape: Shape) => {
    const kind = shape === 'strings' ? 'a list of strings' : `a ${shape}`;
    if (!hasShape(fields[name], shape)) problems.push(`${where}${name} must be ${kind}`);
  };
  for (const [name, shape] of Object.entries(required)) {
    if (fields[name] === undefined) problems.push(`${where}${name} is missing`);
    else expect(name, shape);
  }
  for (const [name, shape] of Object.entries(optional)) {
    if (fields[name] !== undefined) expect(name, shape);
  }
  return problems;
}

function listProblems(
  name: string,
  value: unknown,
  isRequired: boolean,
  check: (where: string, item: unknown) => string[],
): string[] {
  if (value === undefined) return isRequired ? [`${name} is missing`] : [];
  if (!Array.isArray(value)) return [`${name} must be a list`];
  return (value as unknown[]).flatMap((item, index) => check(`${name}[${index}].`, item));
}

function shapeProblems(input: unknown): string[] {
  const top = fieldProblems(
    '',
    input,
    { dashboardUrl: 'string', alertTo: 'string', alertFrom: 'string', groups: 'strings' },
    { subrequestBudget: 'number' },
  );
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return top;
  const fields: Record<string, unknown> = { ...input };
  return [
    ...top,
    ...listProblems('github', fields['github'], false, (where, item) =>
      fieldProblems(where, item, { key: 'string', owner: 'string', logins: 'strings' }),
    ),
    ...listProblems('cloudflare', fields['cloudflare'], false, (where, item) =>
      fieldProblems(where, item, { key: 'string', accountId: 'string' }),
    ),
    ...listProblems('projects', fields['projects'], true, projectShapeProblems),
  ];
}

function projectShapeProblems(where: string, project: unknown): string[] {
  const problems = fieldProblems(
    where,
    project,
    { id: 'string', name: 'string', group: 'string' },
    { productionUrls: 'strings', supabaseRef: 'string' },
  );
  if (typeof project !== 'object' || project === null || Array.isArray(project)) return problems;
  const fields: Record<string, unknown> = { ...project };
  if (fields['github'] !== undefined) {
    problems.push(
      ...fieldProblems(
        `${where}github.`,
        fields['github'],
        { owner: 'string', repo: 'string' },
        {
          defaultBranch: 'string',
          watchDeployments: 'boolean',
          extraBranches: 'strings',
          pullRequestChecks: 'boolean',
        },
      ),
    );
  }
  if (fields['cloudflare'] !== undefined) {
    problems.push(
      ...fieldProblems(`${where}cloudflare.`, fields['cloudflare'], {
        account: 'string',
        scripts: 'strings',
      }),
    );
  }
  return problems;
}

/** The origin only: links are built from it, and a path or query would end up inside them. */
function readDashboardUrl(value: string, problems: string[]): string {
  if (!URL.canParse(value)) {
    problems.push(`dashboardUrl "${value}" is not a URL`);
    return value;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    problems.push(
      `dashboardUrl "${value}" must be https with no path, like https://status.example.com`,
    );
  }
  return url.origin;
}

function resolveProject(project: ProjectConfig, owners: readonly GitHubOwner[]): Project {
  const owner = owners.find((candidate) => candidate.key === project.github?.owner);
  return {
    id: project.id,
    name: project.name,
    group: project.group,
    github: project.github
      ? {
          // An unknown owner key is reported by checkProjects; the key stands in until then.
          fullName: `${owner?.owner ?? project.github.owner}/${project.github.repo}`,
          ownerKey: project.github.owner,
          defaultBranch: project.github.defaultBranch ?? DEFAULT_BRANCH,
          watchDeployments: project.github.watchDeployments ?? false,
          extraBranches: project.github.extraBranches ?? [],
          pullRequestChecks: project.github.pullRequestChecks ?? false,
        }
      : null,
    productionUrls: project.productionUrls ?? [],
    supabaseRef: project.supabaseRef ?? null,
    cloudflare: project.cloudflare
      ? { accountKey: project.cloudflare.account, scripts: project.cloudflare.scripts }
      : null,
  };
}

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function checkKeys(what: string, keys: readonly string[], problems: string[]): void {
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) {
      problems.push(
        `${what} key "${key}" must be lower-case letters and digits, with single - or _ between them`,
      );
    }
  }
  for (const key of duplicates(keys)) problems.push(`${what} key "${key}" is used twice`);
}

function checkGitHubOwners(owners: readonly GitHubOwner[], problems: string[]): void {
  checkKeys(
    'github',
    owners.map((owner) => owner.key),
    problems,
  );
  // 'my-org' and 'my_org' are different keys with the same secret.
  for (const name of duplicates(owners.map((owner) => githubTokenSecretName(owner.key)))) {
    problems.push(`two github keys share the secret name ${name}`);
  }
  // One token reads one owner; a second entry would also show up as a second source with the
  // same name. GitHub logins do not differ by case.
  for (const login of duplicates(owners.map((owner) => owner.owner.toLowerCase()))) {
    problems.push(`github owner "${login}" has two entries; give each owner one`);
  }
  if (owners.length > MAX_GITHUB_OWNERS) {
    problems.push(`at most ${MAX_GITHUB_OWNERS} github owners are supported`);
  }
  for (const owner of owners) {
    for (const login of [owner.owner, ...owner.logins]) {
      if (!GITHUB_LOGIN_PATTERN.test(login)) {
        problems.push(`github "${owner.key}": "${login}" is not a GitHub login`);
      }
    }
  }
}

function checkCloudflareAccounts(accounts: readonly CloudflareAccount[], problems: string[]): void {
  checkKeys(
    'cloudflare',
    accounts.map((account) => account.key),
    problems,
  );
  if (accounts.length > MAX_CLOUDFLARE_ACCOUNTS) {
    problems.push(`at most ${MAX_CLOUDFLARE_ACCOUNTS} cloudflare accounts are supported`);
  }
  for (const account of accounts) {
    if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(account.accountId)) {
      problems.push(`cloudflare "${account.key}": accountId must be 32 hex characters`);
    }
  }
}

function checkGroups(groups: readonly string[], problems: string[]): void {
  if (groups.some((group) => group.trim() === '')) problems.push('a group has an empty name');
  for (const group of duplicates(groups)) problems.push(`group "${group}" is listed twice`);
}

function checkProjects(config: Config, inputs: readonly ProjectConfig[], problems: string[]): void {
  const ownerKeys = config.githubOwners.map((owner) => owner.key);
  const accountKeys = config.cloudflareAccounts.map((account) => account.key);
  for (const id of duplicates(config.projects.map((project) => project.id))) {
    problems.push(`project id "${id}" is used twice`);
  }
  for (const project of config.projects) {
    const where = `project "${project.id}"`;
    if (!PROJECT_ID_PATTERN.test(project.id)) {
      problems.push(`${where}: the id must not be empty or contain spaces or |`);
    }
    if (project.id === UNASSIGNED_PROJECT_ID) problems.push(`${where}: this id is reserved`);
    if (project.name.trim() === '') problems.push(`${where}: the name is empty`);
    if (!config.groups.includes(project.group)) {
      problems.push(`${where}: group "${project.group}" is not in groups`);
    }
    checkProjectUrls(where, project.productionUrls, problems);
    if (project.supabaseRef !== null && !SUPABASE_REF_PATTERN.test(project.supabaseRef)) {
      problems.push(`${where}: supabaseRef must be the 20-character project ref`);
    }
    if (project.cloudflare) {
      if (!accountKeys.includes(project.cloudflare.accountKey)) {
        problems.push(
          `${where}: cloudflare account "${project.cloudflare.accountKey}" is not a key in cloudflare (${accountKeys.join(', ')})`,
        );
      }
      if (project.cloudflare.scripts.some((script) => script.trim() === '')) {
        problems.push(`${where}: a Worker script name is empty`);
      }
    }
  }
  for (const input of inputs) {
    if (!input.github) continue;
    const where = `project "${input.id}"`;
    if (!ownerKeys.includes(input.github.owner)) {
      problems.push(
        `${where}: github owner "${input.github.owner}" is not a key in github (${ownerKeys.join(', ')})`,
      );
    }
    if (!GITHUB_REPO_PATTERN.test(input.github.repo)) {
      problems.push(`${where}: github repo "${input.github.repo}" must be the repo name only`);
    }
    if (input.github.defaultBranch?.trim() === '')
      problems.push(`${where}: defaultBranch is empty`);
    checkExtraBranches(where, input.github, problems);
  }

  const refs = config.projects.flatMap((project) => project.supabaseRef ?? []);
  for (const ref of duplicates(refs)) problems.push(`supabaseRef "${ref}" is used by two projects`);
  // A Worker's check is found by script name, and its traffic is read per account.
  const scripts = config.projects.flatMap((project) =>
    (project.cloudflare?.scripts ?? []).map(
      (script) => `${script}" on account "${project.cloudflare?.accountKey}`,
    ),
  );
  for (const script of duplicates(scripts)) problems.push(`Worker "${script}" is listed twice`);
}

function checkExtraBranches(
  where: string,
  github: NonNullable<ProjectConfig['github']>,
  problems: string[],
): void {
  const branches = github.extraBranches ?? [];
  for (const branch of new Set(branches)) {
    const isName =
      BRANCH_PATTERN.test(branch) && !branch.includes('..') && branch.length <= MAX_BRANCH_LENGTH;
    if (!isName) {
      problems.push(`${where}: extra branch "${branch}" is not a branch name`);
    }
    // Its CI is the 'ci' check already; a second check for it would alert twice.
    if (branch === (github.defaultBranch ?? DEFAULT_BRANCH)) {
      problems.push(`${where}: extra branch "${branch}" is the default branch`);
    }
  }
  for (const branch of duplicates(branches)) {
    problems.push(`${where}: extra branch "${branch}" is listed twice`);
  }
}

function checkProjectUrls(where: string, urls: readonly string[], problems: string[]): void {
  for (const url of urls) {
    const protocol = URL.canParse(url) ? new URL(url).protocol : null;
    if (protocol !== 'https:' && protocol !== 'http:') {
      problems.push(`${where}: "${url}" is not an http(s) URL`);
    }
  }
  for (const url of duplicates(urls)) problems.push(`${where}: "${url}" is listed twice`);
}

/** Which sources have their token. A source without one is not called and costs nothing. */
interface TokensPresent {
  github: (ownerKey: string) => boolean;
  supabase: boolean;
  cloudflare: boolean;
}

const ALL_TOKENS: TokensPresent = { github: () => true, supabase: true, cloudflare: true };

/**
 * The subrequests one run plans, before redirects: one per uptime URL, one per repo (two when
 * it watches extra branches or shows pull request checks) plus the overhead of each token that
 * has repos, Supabase, and two per Cloudflare account with Workers.
 * Every run makes every check, so this is the same each time.
 */
export function plannedSubrequests(config: Config, tokens: TokensPresent = ALL_TOKENS): number {
  const urls = config.projects.flatMap((project) => project.productionUrls).length;
  const repos = config.projects
    .flatMap((project) => project.github ?? [])
    .filter((repo) => tokens.github(repo.ownerKey));
  const repoOwners = repos.map((repo) => repo.ownerKey);
  const accountsInUse = new Set(
    config.projects.flatMap((project) => project.cloudflare?.accountKey ?? []),
  );
  return (
    urls * UPTIME_URL_COST +
    repos.length * GITHUB_REPO_COST +
    repos.filter(needsRecentRuns).length * GITHUB_RECENT_RUNS_COST +
    new Set(repoOwners).size * GITHUB_OWNER_COST +
    (tokens.supabase ? SUPABASE_COST : 0) +
    (tokens.cloudflare ? accountsInUse.size * CLOUDFLARE_ACCOUNT_COST : 0)
  );
}

/** Every check is made every run, so a config that plans more than the budget cannot run. */
function checkBudget(config: Config, problems: string[]): void {
  const budget = config.subrequestBudget;
  if (!Number.isInteger(budget) || budget < 1) {
    problems.push('subrequestBudget must be a whole number above 0');
    return;
  }
  const planned = plannedSubrequests(config);
  if (planned > budget) {
    problems.push(
      `this config needs ${planned} subrequests every run and subrequestBudget is ${budget}: ` +
        'remove checks, or on Workers Paid raise subrequestBudget',
    );
  }
}
