export interface ServerSnapshotManifest {
  format: "risu-server-snapshot";
  version: 1;
  serverId: string;
  schema: 21;
  cursor: number;
  files: { name: string; bytes: number; sha256: string }[];
}
export const snapshotMagic: Uint8Array;
export const snapshotEnd: Uint8Array;
export const snapshotLimits: Readonly<{
  manifestBytes: number;
  databaseBytes: number;
  totalBytes: number;
  files: number;
}>;
export function validateSnapshotManifest(
  value: unknown,
): ServerSnapshotManifest;
