// Catch-all wrapper for nested `/sessions/:id` paths. The parent cloud
// catch-all does not receive these multi-segment paths on Vercel, and the
// Hobby plan limits us to 12 Functions.
export { handleVercelApi as default } from "../../../../../build/server/vercel.mjs";
