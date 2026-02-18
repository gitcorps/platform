"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Disclaimer } from "../../src/components/Disclaimer";
import {
  createFundingCheckoutSession,
  createProject,
  isSlugAvailable,
  waitForCheckoutUrl,
} from "../../src/lib/api";
import {
  getFirebaseAuth,
  getFirebaseDb,
  isFirebaseConfigured,
  signInWithGoogle,
} from "../../src/lib/firebase";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export default function NewProjectPage() {
  const router = useRouter();
  const firebaseConfigured = isFirebaseConfigured();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [manifestoMd, setManifestoMd] = useState("# Vision\n\nDescribe the long-term project vision and constraints.");
  const [initialFundingUsd, setInitialFundingUsd] = useState(25);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugStatus, setSlugStatus] = useState<"unknown" | "checking" | "available" | "taken">(
    "unknown",
  );

  const slugCandidate = useMemo(() => {
    if (slugTouched) {
      return slug;
    }
    return slugify(name);
  }, [name, slug, slugTouched]);

  function getDbOrThrow() {
    if (!firebaseConfigured) {
      throw new Error("Firebase config is missing. Set NEXT_PUBLIC_FIREBASE_* values.");
    }
    return getFirebaseDb();
  }

  async function checkSlug(value: string) {
    if (!value || value.length < 3) {
      setSlugStatus("unknown");
      return;
    }

    setSlugStatus("checking");
    const available = await isSlugAvailable(getDbOrThrow(), value);
    setSlugStatus(available ? "available" : "taken");
  }

  async function ensureSignedIn() {
    const auth = getFirebaseAuth();
    if (auth.currentUser) {
      return;
    }

    await signInWithGoogle();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await ensureSignedIn();

      const finalSlug = slugCandidate;
      if (!finalSlug || finalSlug.length < 3) {
        throw new Error("Slug must be at least 3 characters.");
      }

      const db = getDbOrThrow();
      const available = await isSlugAvailable(db, finalSlug);
      if (!available) {
        throw new Error("Slug is already taken.");
      }

      const project = await createProject({
        name,
        slug: finalSlug,
        manifestoMd,
      });

      if (initialFundingUsd <= 0) {
        router.push(`/p/${finalSlug}`);
        return;
      }

      const amountCents = Math.round(initialFundingUsd * 100);
      const successUrl = `${window.location.origin}/p/${finalSlug}?checkout=success`;
      const cancelUrl = `${window.location.origin}/p/${finalSlug}?checkout=cancel`;

      const checkout = await createFundingCheckoutSession({
        projectId: project.projectId,
        amountCents,
        successUrl,
        cancelUrl,
      });

      const url = await waitForCheckoutUrl(db, checkout.sessionDocumentPath);
      window.location.assign(url);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>Create Project</h1>
      <p className="muted">
        Write the project manifesto, set a unique slug, and choose initial funding to start autonomous
        runs.
      </p>
      <Disclaimer />
      {!firebaseConfigured ? (
        <p className="muted">Firebase config is missing. Set NEXT_PUBLIC_FIREBASE_* values.</p>
      ) : null}
      <form className="form-grid" onSubmit={handleSubmit}>
        <label>
          Project name
          <input
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!slugTouched) {
                setSlug(slugify(event.target.value));
              }
            }}
            placeholder="Example: Open Civic Maps"
          />
        </label>

        <label>
          Slug
          <input
            required
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            minLength={3}
            value={slugCandidate}
            onChange={(event) => {
              setSlugTouched(true);
              setSlug(event.target.value.toLowerCase());
            }}
            onBlur={(event) => {
              void checkSlug(event.target.value);
            }}
            placeholder="open-civic-maps"
          />
        </label>

        <p className="muted">
          {slugStatus === "checking" ? "Checking slug availability..." : null}
          {slugStatus === "available" ? "Slug is available." : null}
          {slugStatus === "taken" ? "Slug is already taken." : null}
        </p>

        <label>
          Manifesto (Markdown)
          <textarea
            required
            minLength={20}
            value={manifestoMd}
            onChange={(event) => {
              setManifestoMd(event.target.value);
            }}
          />
        </label>

        <label>
          Initial funding (USD)
          <input
            type="number"
            min={0}
            step="1"
            value={initialFundingUsd}
            onChange={(event) => {
              setInitialFundingUsd(Number(event.target.value));
            }}
          />
        </label>

        {error ? <p className="muted">Error: {error}</p> : null}

        <button className="button-primary" type="submit" disabled={submitting || !firebaseConfigured}>
          {submitting ? "Starting checkout..." : "Create Project"}
        </button>
      </form>
    </section>
  );
}
