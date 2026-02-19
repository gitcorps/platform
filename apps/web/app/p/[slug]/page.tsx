import { ProjectPageClient } from "../../../src/components/ProjectPageClient";

export default function ProjectPage({ params }: { params: { slug: string } }) {
  return <ProjectPageClient slug={params.slug} />;
}
