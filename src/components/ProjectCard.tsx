import type { CheckView, ProjectView } from '../../shared/api.ts';
import CheckRow from './CheckRow.tsx';
import PullRequestRows from './PullRequestRows.tsx';

interface ProjectCardProps {
  project: ProjectView;
  now: number;
}

/** The rows of a card, in the order they appear; only rows that apply to the project. */
function checkRows(project: ProjectView): CheckView[] {
  return [
    ...project.sites,
    ...(project.deploy ? [project.deploy] : []),
    ...(project.ci ? [project.ci] : []),
    ...(project.supabase ? [project.supabase] : []),
    ...project.workers,
  ];
}

export function hasProblem(project: ProjectView): boolean {
  return checkRows(project).some((check) => check.status === 'problem');
}

export default function ProjectCard({ project, now }: ProjectCardProps) {
  const rows = checkRows(project);
  const problem = hasProblem(project);
  return (
    <section
      className={`overflow-hidden rounded-xl border bg-surface ${problem ? 'border-bad' : 'border-line'}`}
      aria-label={project.name}
    >
      <h3 className="px-4 pb-1 pt-3 text-base font-semibold">{project.name}</h3>
      <div className="divide-y divide-line pb-1">
        {rows.map((check) => (
          <CheckRow key={`${check.label}:${check.summary}`} check={check} now={now} />
        ))}
        {project.pullRequests !== null && <PullRequestRows pullRequests={project.pullRequests} />}
      </div>
    </section>
  );
}
