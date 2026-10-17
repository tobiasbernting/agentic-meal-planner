// The offline service worker (ADR-0007), served at /sw.js as a module worker after a
// `self.OFFLINE_CONFIG = {...};` line built by src/offline/routes.ts.
// Stub: #104 fills in the read side (Offline Copy), #107 the write side (Pending Changes).

self.addEventListener("fetch", () => {});
