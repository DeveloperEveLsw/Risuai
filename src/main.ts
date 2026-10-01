import "./ts/polyfill";
import "core-js/actual"
import "./ts/storage/database.svelte"
import { isServerResidentExecutor } from "./ts/platform";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { preLoadCheck } from "./preload";
import { mount } from "svelte";

window.addEventListener('vite:preloadError', (event) => {
    console.error("Chunk load error detected:", event);
    alert("The server has been updated or the network connection has been lost. Please refresh the page.");
});

preLoadCheck()
// The resident runs the engine without mounting the chat/catalog/settings UI.
const { default: App } = isServerResidentExecutor
    ? await import('./ResidentApp.svelte')
    : await import('./App.svelte');
let app = mount(App, {
    target: document.getElementById("app"),
});
loadData()
if (!isServerResidentExecutor) initHotkey()
document.getElementById('preloading').remove()

export default app;