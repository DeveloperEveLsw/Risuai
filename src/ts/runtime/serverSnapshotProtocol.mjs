export const snapshotMagic = new TextEncoder().encode("RISURT01");
export const snapshotEnd = new TextEncoder().encode("RTDONE01");
export const snapshotLimits = Object.freeze({
  manifestBytes: 64 * 1024 * 1024,
  databaseBytes: 8 * 1024 ** 3,
  totalBytes: 32 * 1024 ** 3,
  files: 200001,
});
export function validateSnapshotManifest(value) {
  if (
    value?.format !== "risu-server-snapshot" ||
    value.version !== 1 ||
    typeof value.serverId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(value.serverId) ||
    ![21, 22].includes(value.schema) ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0 ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > snapshotLimits.files
  )
    throw Error("Invalid server snapshot manifest");
  const seen = new Set();
  let total = 0;
  for (const [index, file] of value.files.entries()) {
    if (
      typeof file?.name !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      seen.has(file.name)
    )
      throw Error("Invalid snapshot entry");
    if (index === 0) {
      if (
        file.name !== "snapshot.sqlite" ||
        file.bytes > snapshotLimits.databaseBytes
      )
        throw Error("Invalid snapshot database");
    } else if (
      file.name !== "assets/" + file.sha256 + ".blob" ||
      file.bytes > 64 * 1024 * 1024
    )
      throw Error("Invalid snapshot asset");
    seen.add(file.name);
    total += file.bytes;
    if (total > snapshotLimits.totalBytes)
      throw Error("Snapshot exceeds the transfer budget");
  }
  return value;
}
