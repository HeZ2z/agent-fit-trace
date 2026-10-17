// Catch-all Vercel Function for durable cloud coaching routes.
// `handleVercelApi` routes `/api/v1/coaching/cloud/*` to the authenticated
// cloud handler; this file exists so Vercel deploys those nested paths.
export { handleVercelApi as default } from "../../../../build/server/vercel.mjs";
