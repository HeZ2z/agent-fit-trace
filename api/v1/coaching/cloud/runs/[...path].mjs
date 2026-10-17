// Catch-all wrapper for nested `/runs/:id`, `/runs/:id/events`, and
// `/runs/:id/cancel` paths. The parent cloud catch-all does not receive these
// multi-segment paths on Vercel, and the Hobby plan limits us to 12 Functions,
// so one nested Function covers all run subpaths.
export { handleVercelApi as default } from "../../../../../build/server/vercel.mjs";
