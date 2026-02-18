"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
function getDb() {
    if ((0, app_1.getApps)().length === 0) {
        (0, app_1.initializeApp)();
    }
    return (0, firestore_1.getFirestore)();
}
//# sourceMappingURL=firestore.js.map