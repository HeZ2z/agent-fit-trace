// Remote MCP endpoint (`/api/mcp`) and its Protected Resource Metadata
// (`/.well-known/oauth-protected-resource/api/mcp`, rewritten onto this
// Function by vercel.json because Vercel creates no Function for a
// dot-directory and the Hobby plan's 12-Function cap is already reached).
//
// Same shared adapter export as every other API Function: the MCP surface is
// routed *first* inside `handleVercelApi` and returns unconditionally, so the
// `/api/v1` chain never sees these paths. Keeping one entrypoint means one
// import graph, one cold-start, and no second copy of the env/fail-closed rules.
export { handleVercelApi as default } from "../../build/server/vercel.mjs";
