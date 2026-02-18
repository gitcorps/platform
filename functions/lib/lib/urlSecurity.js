"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAllowedReturnUrl = isAllowedReturnUrl;
function isAllowedReturnUrl(urlValue, publicSiteDomain) {
    let parsed;
    try {
        parsed = new URL(urlValue);
    }
    catch {
        return false;
    }
    const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (isLocalhost) {
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    if (parsed.protocol !== "https:") {
        return false;
    }
    return (parsed.hostname === publicSiteDomain || parsed.hostname.endsWith(`.${publicSiteDomain}`));
}
//# sourceMappingURL=urlSecurity.js.map