// Explicit wrapper: Vercel does not match the parent catch-all for nested
// `/sessions/:id` paths, so the deployed app would 404 when reading a session.
export { handleVercelApi as default } from "../../../../../build/server/vercel.mjs";
