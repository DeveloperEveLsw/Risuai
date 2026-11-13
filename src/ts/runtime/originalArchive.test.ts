import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  missingArchiveAssets,
  validateOriginalArchive,
  validateOriginalArchiveAsset,
  type OriginalArchive,
} from "./originalArchive";
import type { Database } from "../storage/database.svelte";

describe("original archive integrity", () => {
  it("checks unknown inline and structured audio references, including selected partial images", () => {
    const id = "a".repeat(64) + ".wav";
    const missing = "b".repeat(64) + ".webp";
    const archive = {
      database: {
        characters: [
          {
            image: "assets/runtime/" + missing,
            unknown: "Synthetic inline assets/" + id,
          },
        ],
        unknown: { sound: "assets/runtime/" + id },
      },
      assets: [{ id }],
    } as unknown as OriginalArchive;
    expect(missingArchiveAssets(archive)).toEqual([missing]);
    expect(missingArchiveAssets(archive, new Set(["assets/" + id]))).toEqual(
      [],
    );
    expect(
      missingArchiveAssets(archive, new Set(["assets/runtime/" + missing])),
    ).toEqual([missing]);
  });
  it("rejects foreign authority, duplicate or forged manifests and changed bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    const asset = {
      id: digest + ".wav",
      digest,
      extension: "wav",
      path: "assets/runtime/" + digest + ".wav",
      mime: "audio/wav",
      byteLength: bytes.byteLength,
    };
    const archive: OriginalArchive = {
      format: "risu-original-archive",
      version: 1,
      serverId: "synthetic",
      cursor: 7,
      database: { characters: [] } as Database,
      assets: [asset],
    };
    expect(validateOriginalArchive(archive, "synthetic")).toBe(archive);
    expect(() => validateOriginalArchive(archive, "foreign")).toThrow(
      "Invalid complete",
    );
    expect(() =>
      validateOriginalArchive(
        { ...archive, assets: [asset, asset] },
        "synthetic",
      ),
    ).toThrow("Invalid immutable");
    expect(() =>
      validateOriginalArchive(
        { ...archive, assets: [{ ...asset, path: "assets/" + asset.id }] },
        "synthetic",
      ),
    ).toThrow("Invalid immutable");
    await expect(
      validateOriginalArchiveAsset(asset, bytes.subarray(0, 2)),
    ).rejects.toThrow("size mismatch");
    await expect(
      validateOriginalArchiveAsset(asset, new Uint8Array([1, 2, 4])),
    ).rejects.toThrow("checksum mismatch");
    await expect(validateOriginalArchiveAsset(asset, bytes)).resolves.toEqual(
      bytes,
    );
  });
});
