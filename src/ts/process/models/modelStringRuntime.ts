import type { getDatabase } from "src/ts/storage/database.svelte";
/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface ModelStringRuntimeHost {
  getDatabase: (typeof import("src/ts/storage/database.svelte"))["getDatabase"];
}
export function createModelStringRuntime(host: ModelStringRuntimeHost) {
  function getGenerationModelString(name?: string) {
    const db = host.getDatabase();
    switch (name ?? db.aiModel) {
      case "reverse_proxy":
        return (
          "custom-" +
          (db.reverseProxyOobaMode ? "ooba" : db.customProxyRequestModel)
        );
      case "openrouter":
        return "openrouter-" + db.openrouterRequestModel;
      case "nanogpt": {
        const modelLabel = db.nanogptRequestModelName || db.nanogptRequestModel;
        return (
          "NanoGPT " +
          modelLabel +
          (db.nanogptUseSubscriptionEndpoint ? " [SUB]" : "")
        );
      }
      case "ollama-hosted":
      case "ollama-cloud": {
        const modelLabel =
          name === "ollama-cloud"
            ? db.ollamaCloudModelName || db.ollamaCloudModel
            : db.ollamaModelName || db.ollamaModel;
        return `Ollama ${name === "ollama-cloud" ? "Cloud" : "Local"} ${modelLabel}`;
      }
      default:
        return name ?? db.aiModel;
    }
  }
  return { getGenerationModelString };
}
