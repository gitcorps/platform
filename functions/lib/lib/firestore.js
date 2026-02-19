"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
let cachedApp = null;
let cachedDb = null;
function getDefaultApp() {
    if (cachedApp) {
        return cachedApp;
    }
    try {
        cachedApp = (0, app_1.getApp)();
    }
    catch {
        cachedApp = (0, app_1.initializeApp)();
    }
    return cachedApp;
}
function getDb() {
    if (cachedDb) {
        return cachedDb;
    }
    cachedDb = (0, firestore_1.getFirestore)(getDefaultApp());
    return cachedDb;
}
//# sourceMappingURL=firestore.js.map