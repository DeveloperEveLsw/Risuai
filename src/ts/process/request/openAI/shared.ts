let browserRuntime: ReturnType<typeof createNetworkRuntime>;
import { getDatabase } from "src/ts/storage/database.svelte";

import { isLocalNetworkUrl } from "src/ts/network/localNetwork";

export interface LocalNetworkRequestOptions {
  networkRoute?: "auto" | "local_network";
  requestTimeoutMs?: number;
}

export function getLocalNetworkRequestOptions(
  url: string,
  db = getDatabase(),
  useStreaming = false,
): LocalNetworkRequestOptions {
  return getBrowserRuntime().getLocalNetworkRequestOptions(
    url,
    db,
    useStreaming,
  );
}
import { createNetworkRuntime } from "./networkRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createNetworkRuntime({
    get getDatabase() {
      return getDatabase;
    },
    get isLocalNetworkUrl() {
      return isLocalNetworkUrl;
    },
  }));
}
