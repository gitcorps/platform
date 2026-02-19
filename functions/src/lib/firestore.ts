import { getApp, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

function getDefaultApp(): App {
  if (cachedApp) {
    return cachedApp;
  }

  try {
    cachedApp = getApp();
  } catch {
    cachedApp = initializeApp();
  }

  return cachedApp;
}

export function getDb(): Firestore {
  if (cachedDb) {
    return cachedDb;
  }

  cachedDb = getFirestore(getDefaultApp());
  return cachedDb;
}
