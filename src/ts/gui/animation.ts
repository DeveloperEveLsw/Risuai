import { getDatabase } from "../storage/database.svelte";

export function updateAnimationSpeed(db = getDatabase()) {
  document.documentElement.style.setProperty(
    "--risu-animation-speed",
    db.animationSpeed + "s",
  );
}
