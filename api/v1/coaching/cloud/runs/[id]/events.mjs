// Explicit wrapper: Vercel does not match the parent catch-all for nested
// `/runs/:id/events` paths, so the deployed app would 404 when polling events.
export { handleVercelApi as default } from "../../../../../../build/server/vercel.mjs";
