import type { Database } from "../storage/database.svelte";

export interface OriginalArchiveAsset {
  id: string;
  path: string;
  digest: string;
  extension: string;
  mime: string;
  byteLength: number;
}
export interface OriginalArchive {
  format: "risu-original-archive";
  version: 1;
  serverId: string;
  cursor: number;
  database: Database;
  assets: OriginalArchiveAsset[];
}

export function validateOriginalArchive(
  value: OriginalArchive,
  serverId: string,
) {
  if (
    value?.format !== "risu-original-archive" ||
    value.version !== 1 ||
    value.serverId !== serverId ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    !Array.isArray(value.database?.characters) ||
    !Array.isArray(value.assets)
  )
    throw new Error("Invalid complete server archive");
  const seen = new Set<string>();
  for (const asset of value.assets) {
    if (
      !/^[a-f0-9]{64}\.[a-z0-9]{1,16}$/.test(asset.id) ||
      asset.id !== asset.digest + "." + asset.extension ||
      asset.path !== "assets/runtime/" + asset.id ||
      !Number.isSafeInteger(asset.byteLength) ||
      asset.byteLength < 1 ||
      asset.byteLength > 64 * 1024 * 1024 ||
      seen.has(asset.id)
    )
      throw new Error("Invalid immutable archive asset");
    seen.add(asset.id);
  }
  return value;
}

/** Unknown extension fields and inline references participate in a full backup. */
export function missingArchiveAssets(
  archive: OriginalArchive,
  selected?: Set<string>,
) {
  const known = new Set(archive.assets.map((asset) => asset.id));
  const missing = new Set<string>();
  const inspect = (value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(
        /assets\/(?:runtime\/)?([a-f0-9]{64}\.[a-z0-9]{1,16})(?![a-z0-9.])/g,
      )) {
        if ((!selected || selected.has(value)) && !known.has(match[1]))
          missing.add(match[1]);
      }
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) inspect(nested);
    }
  };
  inspect(archive.database);
  return [...missing];
}

/** Validate the downloaded bytes, not merely the server's manifest metadata. */
export async function validateOriginalArchiveAsset(
  asset: OriginalArchiveAsset,
  data: Uint8Array,
) {
  if (data.byteLength !== asset.byteLength)
    throw new Error("Archive asset size mismatch: " + asset.id);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== asset.digest)
    throw new Error("Archive asset checksum mismatch: " + asset.id);
  return data;
}
