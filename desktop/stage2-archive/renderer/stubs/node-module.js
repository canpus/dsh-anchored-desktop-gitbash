// Browser stub for node builtins referenced by vendored lib artifacts; the
// code paths that use them are Node-only and never execute in the renderer.
export default {}
export const createRequire = () => (id) => {
  throw new Error(`[desktop] node builtin require("${id}") reached in browser context`)
}
