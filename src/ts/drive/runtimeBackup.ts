import { LocalWriter } from "../globalApi.svelte";
import { alertError, alertNormal, alertStore, alertWait } from "../alert";
import { encodeRisuSaveLegacy } from "../storage/risuSave";
import { browserRuntime } from "../runtime/browserRuntimeState.svelte";
import {
  missingArchiveAssets,
  validateOriginalArchiveAsset,
} from "../runtime/originalArchive";
import type { Database } from "../storage/database.svelte";

/** Original partial backup keeps all data and only the selected identity images. */
export function partialBackupAssets(db: Database) {
  const paths = new Set<string>();
  for (const char of db.characters ?? []) if (char.image) paths.add(char.image);
  for (const path of [db.userIcon, db.customBackground])
    if (path) paths.add(path);
  for (const persona of db.personas ?? [])
    if (persona.icon) paths.add(persona.icon);
  for (const item of db.characterOrder ?? [])
    if (typeof item !== "string") {
      if (item.img) paths.add(item.img);
      if (item.imgFile) paths.add(item.imgFile);
    }
  for (const preset of db.botPresets ?? [])
    if (preset.image) paths.add(preset.image);
  return paths;
}

export async function saveRuntimeLocalBackup(partial = false) {
  let writer: LocalWriter | undefined;
  try {
    alertWait(
      partial ? "Saving partial server backup..." : "Saving server backup...",
    );
    const archive = await browserRuntime().exportArchive();
    const selected = partial ? partialBackupAssets(archive.database) : null;
    if (missingArchiveAssets(archive, selected ?? undefined).length)
      throw new Error("Backup references assets missing from server storage");
    const database = encodeRisuSaveLegacy(
      { ...archive.database, account: undefined },
      "compression",
    );
    if (database.byteLength > 64 * 1024 * 1024)
      throw new Error("Database exceeds the original backup entry limit");
    const assets = archive.assets.filter(
      (asset) =>
        !selected ||
        selected.has(asset.path) ||
        selected.has("assets/" + asset.id),
    );
    writer = new LocalWriter();
    if (!(await writer.init())) {
      alertStore.set({ type: "none", msg: "" });
      return;
    }
    for (const [index, asset] of assets.entries()) {
      alertWait(
        `Saving server backup assets... (${index + 1} / ${assets.length})`,
      );
      const data = await validateOriginalArchiveAsset(
        asset,
        await browserRuntime().readAsset(asset.path),
      );
      await writer.writeBackup(asset.id, data);
    }
    // A missing/corrupt asset cannot produce a misleading complete database entry.
    alertWait("Saving server backup database...");
    await writer.writeBackup("database.risudat", database);
    await writer.close();
    writer = undefined;
    alertNormal(
      partial
        ? "Partial backup saved. Only main identity images are included. Server job history and saved reply alternatives require a server snapshot."
        : "Backup saved. Server job history and saved reply alternatives require a server snapshot.",
    );
  } catch (error) {
    if (writer?.writer) {
      try {
        if (
          "abort" in writer.writer &&
          typeof writer.writer.abort === "function"
        )
          await writer.writer.abort(error);
        else await writer.close();
      } catch {}
    }
    alertError(error instanceof Error ? error.message : String(error));
  }
}
