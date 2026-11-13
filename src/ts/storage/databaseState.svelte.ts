import type { Database } from "./database.svelte";

// Shared by the original UI and the scoped server projection; no browser host imports.
export const DBState = $state({ db: {} as Database });
