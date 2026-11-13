"use strict";

const { createHash } = require("node:crypto");
const { getWygloreRelease } = require("./wygloreContract.cjs");

// These exact distributed releases use the same regional endpoint function.
// Supporting a future author artifact does not implicitly approve this seam.
const RELEASES = Object.freeze([
  "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
  "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
]);
const SIGNATURE = "function endpointBase(region,projectId)";
const FUNCTION_LENGTH = 234;
const FUNCTION_SHA256 =
  "c69728e1f12187a40da9546072c228a90d846cd7d088d11dc5c5d23377ebc864";
const REPLACEMENT =
  'function endpointBase(region,projectId){return region==="us"||region==="eu"?`https://aiplatform.${region}.rep.googleapis.com/v1/projects/${projectId}/locations/${region}`:region==="global"?`https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global`:`https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}`}';

/** Extend the reviewed author's URL builder only for explicitly configured
 * Vertex multi-regions. Keep global and existing regional routing unchanged.
 * No stored region, model, credential or author artifact is modified, and no
 * automatic fallback or replay is introduced.
 */
function instrumentWygloreVertexEndpoint(original, executable = original) {
  const release = getWygloreRelease(original);
  if (!RELEASES.includes(release.sha256))
    throw Error("WygLore Vertex endpoint release is not reviewed");
  if (typeof executable !== "string")
    throw Error("WygLore Vertex executable is required");
  const start = executable.indexOf(SIGNATURE);
  if (start < 0 || executable.indexOf(SIGNATURE, start + SIGNATURE.length) >= 0)
    throw Error("Reviewed WygLore Vertex endpoint function count differs");
  const text = executable.slice(start, start + FUNCTION_LENGTH);
  if (createHash("sha256").update(text).digest("hex") !== FUNCTION_SHA256)
    throw Error("Reviewed WygLore Vertex endpoint function differs");
  return (
    executable.slice(0, start) +
    REPLACEMENT +
    executable.slice(start + FUNCTION_LENGTH)
  );
}

module.exports = { instrumentWygloreVertexEndpoint, RELEASES };
