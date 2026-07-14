// Store context constants (mirrors the backend-integration-test skill's
// storeContext; userId comes from the auth token at runtime).
// storeId comes from perf.storeId in project-profile.json — pass it through as the
// STORE_ID env var (k6 has no direct file-read access to project-profile.json).
export const STORE = {
    // no baked-in store default — set per deployment
    storeId: __ENV.STORE_ID || '',
    currencyCode: 'USD',
    cultureName: 'en-US',
};
