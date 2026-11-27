import type { SourceResult, StateObservation } from '../observations.ts';
import { SUPABASE_LABEL, SUPABASE_SOURCE, UNASSIGNED_PROJECT_ID, type Project } from '../config.ts';
import {
  fetchJson,
  isRecord,
  readString,
  safeErrorMessage,
  SourceError,
  type Fetcher,
} from './http.ts';

const PROJECTS_URL = 'https://api.supabase.com/v1/projects';
const HEALTHY_STATUS = 'ACTIVE_HEALTHY';

interface SupabaseProject {
  ref: string;
  name: string;
  status: string;
}

/** One request: the list of projects the read-only token can see, with their status. */
export async function fetchSupabase(
  fetcher: Fetcher,
  token: string,
  projects: readonly Project[],
): Promise<SourceResult> {
  const base = { source: SUPABASE_SOURCE, label: SUPABASE_LABEL };
  try {
    const body = await fetchJson(fetcher, PROJECTS_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    return { ...base, error: null, observations: parseSupabaseProjects(body, projects) };
  } catch (error) {
    return { ...base, error: safeErrorMessage(error), observations: [] };
  }
}

export function parseSupabaseProjects(
  body: unknown,
  projects: readonly Project[],
): StateObservation[] {
  if (!Array.isArray(body)) throw new SourceError('invalid response');
  const seen: SupabaseProject[] = (body as unknown[]).map((item) => {
    if (!isRecord(item)) throw new SourceError('invalid response');
    return {
      ref: readString(item, 'ref'),
      name: readString(item, 'name'),
      status: readString(item, 'status'),
    };
  });

  const observations: StateObservation[] = [];
  const known = new Set<string>();
  for (const project of projects) {
    if (project.supabaseRef === null) continue;
    known.add(project.supabaseRef);
    const found = seen.find((candidate) => candidate.ref === project.supabaseRef);
    observations.push(
      found
        ? toObservation(project.id, project.name, 'Supabase', found)
        : notVisible(project.id, project.name, project.supabaseRef),
    );
  }
  for (const found of seen) {
    if (known.has(found.ref)) continue;
    observations.push(toObservation(UNASSIGNED_PROJECT_ID, found.name, found.name, found));
  }
  return observations;
}

function toObservation(
  projectId: string,
  subject: string,
  label: string,
  found: SupabaseProject,
): StateObservation {
  const isHealthy = found.status === HEALTHY_STATUS;
  return {
    type: 'state',
    projectId,
    checkKey: `supabase:${found.ref}`,
    kind: 'supabase',
    subject,
    label,
    status: isHealthy ? 'ok' : 'problem',
    summary: isHealthy ? 'Healthy' : describeStatus(found.status),
    linkUrl: dashboardUrl(found.ref),
    at: null,
    failuresToProblem: 1,
  };
}

// A registered project the token cannot see tells us nothing about its health.
function notVisible(projectId: string, subject: string, ref: string): StateObservation {
  return {
    type: 'state',
    projectId,
    checkKey: `supabase:${ref}`,
    kind: 'supabase',
    subject,
    label: 'Supabase',
    status: 'unknown',
    summary: 'Not visible to the token',
    linkUrl: dashboardUrl(ref),
    at: null,
    failuresToProblem: 1,
  };
}

function describeStatus(status: string): string {
  return status === 'INACTIVE' ? 'INACTIVE (paused)' : status;
}

function dashboardUrl(ref: string): string {
  return `https://supabase.com/dashboard/project/${ref}`;
}
