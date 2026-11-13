import type { getDatabase } from "src/ts/storage/database.svelte";
import type { isLocalNetworkUrl } from "src/ts/network/localNetwork";
/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface NetworkRuntimeHost {
  getDatabase: (typeof import("src/ts/storage/database.svelte"))["getDatabase"];
  isLocalNetworkUrl: (typeof import("src/ts/network/localNetwork"))["isLocalNetworkUrl"];
}
export function createNetworkRuntime(host: NetworkRuntimeHost) {
  interface LocalNetworkRequestOptions {
    networkRoute?: "auto" | "local_network";
    requestTimeoutMs?: number;
  }

  function getLocalNetworkRequestOptions(
    url: string,
    db = host.getDatabase(),
    useStreaming = false,
  ): LocalNetworkRequestOptions {
    if (!db.localNetworkMode || !host.isLocalNetworkUrl(url)) {
      return {};
    }
    const timeoutSec =
      Number.isFinite(db.localNetworkTimeoutSec) &&
      db.localNetworkTimeoutSec > 0
        ? db.localNetworkTimeoutSec
        : 600;
    return {
      networkRoute: "local_network",
      requestTimeoutMs: useStreaming
        ? Math.max(1, Math.floor(timeoutSec * 1000))
        : undefined,
    };
  }
  return { getLocalNetworkRequestOptions };
}
