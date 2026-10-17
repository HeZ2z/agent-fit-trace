// Explicit wrapper: Vercel does not match the parent catch-all for nested
// `/runs/:id/cancel` paths, so the deployed app would 404 when cancelling.
export { handleVercelApi as default } from "../../../../../../build/server/vercel.mjs";
