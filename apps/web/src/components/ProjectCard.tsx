import Link from "next/link";

export interface ProjectCardData {
  slug: string;
  name: string;
  manifestoMd: string;
  balanceCents: number;
  status: string;
}

function excerpt(markdown: string): string {
  const compact = markdown.replace(/\s+/g, " ").trim();
  return compact.length <= 140 ? compact : `${compact.slice(0, 140)}...`;
}

export function ProjectCard({ project }: { project: ProjectCardData }) {
  return (
    <article className="project-card">
      <header>
        <h3>{project.name}</h3>
      </header>
      <p>{excerpt(project.manifestoMd)}</p>
      <dl>
        <div>
          <dt>Balance</dt>
          <dd>${(project.balanceCents / 100).toFixed(2)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{project.status}</dd>
        </div>
      </dl>
      <Link href={`/p/${project.slug}`} className="button-primary">
        View Project
      </Link>
    </article>
  );
}
