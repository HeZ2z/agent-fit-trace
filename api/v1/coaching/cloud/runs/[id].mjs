// Explicit wrapper: Vercel does not match the parent catch-all for nested
// `/runs/:id` paths, so the deployed app would 404 when reading a run.
export { handleVercelApi as default } from "../../../../../build/server/vercel.mjs";
