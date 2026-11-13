import { LocalWriter } from "../globalApi.svelte";
import { alertError, alertNormal, alertStore, alertWait } from "../alert";
import { browserRuntime } from "../runtime/browserRuntimeState.svelte";

export async function saveServerSnapshotBackup() {
  const writer = new LocalWriter();
  let opened = false;
  try {
    if (!(await writer.init("risu-server-backup", ["risusnapshot"]))) {
      alertStore.set({ type: "none", msg: "" });
      return;
    }
    opened = true;
    let bytes = 0,
      lastUpdate = 0;
    alertWait("Saving full server data...");
    await browserRuntime().exportServerSnapshot(async (chunk) => {
      await writer.write(chunk);
      bytes += chunk.length;
      if (Date.now() - lastUpdate > 500) {
        lastUpdate = Date.now();
        alertWait(
          `Saving full server data... (${(bytes / 1024 / 1024).toFixed(1)} MiB)`,
        );
      }
    });
    await writer.close();
    opened = false;
    alertNormal(
      "Server data backup saved. Restore into a new database with the server snapshot restore command.",
    );
  } catch (error) {
    if (opened)
      try {
        if (
          "abort" in writer.writer &&
          typeof writer.writer.abort === "function"
        )
          await writer.writer.abort(error);
        else await writer.close();
      } catch {}
    alertError(error instanceof Error ? error.message : String(error));
  }
}
