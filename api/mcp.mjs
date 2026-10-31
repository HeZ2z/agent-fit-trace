// Remote MCP endpoint (`/api/mcp`) and its Protected Resource Metadata
// (`/.well-known/oauth-protected-resource/api/mcp`, rewritten onto this
// Function by vercel.json because Vercel creates no Function for a
// dot-directory and the Hobby plan's 12-Function cap is already reached).
//
// Same shared adapter export as every other API Function: the MCP surface is
// routed *first* inside `handleVercelApi` and returns unconditionally, so the
// `/api/v1` chain never sees these paths. Keeping one entrypoint means one
// import graph, one cold-start, and no second copy of the env/fail-closed rules.
//
// The relative depth differs from the `api/v1/**` entrypoints: this file sits
// directly under `api/`, so the bundle at `<repo>/build/server/vercel.mjs` is
// one level up, not two. Getting this wrong is not a subtle bug — the specifier
// resolves outside the repository, the Function fails to load, and both
// `/api/mcp` and its rewritten metadata route disappear with it.
export { handleVercelApi as default } from "../build/server/vercel.mjs";
