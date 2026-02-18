"use client";

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  type Auth,
  type User,
} from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getFunctions, type Functions } from "firebase/functions";

interface FirebaseBundle {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  functions: Functions;
}

const provider = new GoogleAuthProvider();
let cachedBundle: FirebaseBundle | null = null;

function readConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

function hasRequiredConfig(config: ReturnType<typeof readConfig>): boolean {
  return (
    typeof config.apiKey === "string" &&
    config.apiKey.length > 0 &&
    typeof config.authDomain === "string" &&
    config.authDomain.length > 0 &&
    typeof config.projectId === "string" &&
    config.projectId.length > 0 &&
    typeof config.appId === "string" &&
    config.appId.length > 0
  );
}

function ensureFirebase(): FirebaseBundle {
  if (cachedBundle) {
    return cachedBundle;
  }

  const config = readConfig();
  if (!hasRequiredConfig(config)) {
    throw new Error("Firebase client configuration is missing. Check NEXT_PUBLIC_FIREBASE_* env vars.");
  }

  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  cachedBundle = {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    functions: getFunctions(
      app,
      process.env.NEXT_PUBLIC_FIREBASE_FUNCTIONS_REGION || "us-central1",
    ),
  };

  return cachedBundle;
}

export function isFirebaseConfigured(): boolean {
  return hasRequiredConfig(readConfig());
}

export function getFirebaseAuth(): Auth {
  return ensureFirebase().auth;
}

export function getFirebaseDb(): Firestore {
  return ensureFirebase().db;
}

export function getFirebaseFunctions(): Functions {
  return ensureFirebase().functions;
}

export async function signInWithGoogle(): Promise<void> {
  await signInWithPopup(getFirebaseAuth(), provider);
}

export function observeAuth(callback: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), callback);
}
