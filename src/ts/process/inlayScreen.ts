let browserRuntime: ReturnType<typeof createInlayScreenRuntime>;
import { writeInlayImage } from "./files/inlays";

import type { character } from "../storage/database.svelte";

import { generateAIImage } from "./stableDiff";

export function runInlayScreen(
  char: character,
  data: string,
): {
  text: string;
  promise?: Promise<string>;
} {
  return getBrowserRuntime().runInlayScreen(char, data);
}

export function updateInlayScreen(char: character): character {
  return getBrowserRuntime().updateInlayScreen(char);
}
import { createInlayScreenRuntime } from "./inlayScreenRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createInlayScreenRuntime({
    get generateAIImage(): typeof generateAIImage {
      return generateAIImage;
    },
    get writeInlayImage(): typeof writeInlayImage {
      return writeInlayImage;
    },
    get Image(): typeof Image {
      return Image;
    },
  }));
}
