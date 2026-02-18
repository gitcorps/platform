"use client";

import { useEffect, useState } from "react";
import {
  getFirebaseAuth,
  isFirebaseConfigured,
  observeAuth,
  signInWithGoogle,
} from "../lib/firebase";

export function AuthPanel() {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      return;
    }

    setEmail(getFirebaseAuth().currentUser?.email ?? null);
    return observeAuth((user) => {
      setEmail(user?.email ?? null);
    });
  }, []);

  if (!isFirebaseConfigured()) {
    return <span className="auth-chip">Firebase config missing</span>;
  }

  if (email) {
    return <span className="auth-chip">Signed in as {email}</span>;
  }

  return (
    <button
      className="button-secondary"
      type="button"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        try {
          await signInWithGoogle();
        } finally {
          setLoading(false);
        }
      }}
    >
      {loading ? "Signing in..." : "Sign in"}
    </button>
  );
}
