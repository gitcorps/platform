"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebaseDb, isFirebaseConfigured } from "../src/lib/firebase";
import { ProjectCard, type ProjectCardData } from "../src/components/ProjectCard";

interface ProjectListItem extends ProjectCardData {
  id: string;
}

export default function HomePage() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const firebaseConfigured = isFirebaseConfigured();

  useEffect(() => {
    if (!firebaseConfigured) {
      setLoading(false);
      return;
    }

    const db = getFirebaseDb();
    const q = query(collection(db, "projects"), orderBy("createdAt", "desc"), limit(20));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const rows: ProjectListItem[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          return {
            id: docSnap.id,
            slug: String(data.slug || ""),
            name: String(data.name || "Untitled"),
            manifestoMd: String(data.manifestoMd || ""),
            balanceCents: Number(data.balanceCents || 0),
            status: String(data.status || "active"),
          };
        });

        setProjects(rows);
        setLoading(false);
      },
      () => {
        setLoading(false);
      },
    );

    return unsubscribe;
  }, [firebaseConfigured]);

  return (
    <>
      <section className="hero">
        <h1>Fund autonomous open-source projects that ship continuously.</h1>
        <p className="muted">
          Anyone can launch a project manifesto, fund its wallet, and let the agent iterate directly on
          main until funds run out.
        </p>
        <Link className="button-primary" href="/new">
          Create Project
        </Link>
      </section>

      <section>
        <h2>Recent Projects</h2>
        {!firebaseConfigured ? (
          <p className="muted">Firebase config is missing. Set NEXT_PUBLIC_FIREBASE_* values.</p>
        ) : null}
        {loading ? <p className="muted">Loading projects...</p> : null}
        {!loading && projects.length === 0 ? (
          <p className="muted">No projects yet. Create the first one.</p>
        ) : null}

        <div className="project-grid">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </section>
    </>
  );
}
