import type { character } from "../storage/database.svelte";
import { updateInlayScreen } from "../process/inlayScreen";

export const characterAssetFields = [
  "image",
  "ccAssets",
  "extentions",
  "largePortrait",
  "viewScreen",
  "emotionImages",
  "inlayViewScreen",
  "newGenData",
  "additionalAssets",
  "prebuiltAssetCommand",
  "prebuiltAssetStyle",
  "prebuiltAssetExclude",
] as const;

/** Original dump/swap representation: the selected icon leaves ccAssets. */
export function replaceCharacterIcon(values: any, image: string) {
  if (values.image) {
    values.ccAssets ??= [];
    values.ccAssets.push({
      type: "icon",
      name: "iconx",
      uri: values.image,
      ext: "png",
    });
  }
  values.image = image;
}
export function switchCharacterIcon(values: any, index: number) {
  const image = values.ccAssets[index].uri;
  values.ccAssets.splice(index, 1);
  replaceCharacterIcon(values, image);
}
export function changeCharacterView(
  values: any,
  viewScreen: string,
  inlay?: boolean,
) {
  values.viewScreen = viewScreen;
  if (inlay !== undefined) {
    values.inlayViewScreen = inlay;
    if (viewScreen === "emotion") {
      if (inlay && values.additionalAssets === undefined)
        values.additionalAssets = [];
      else if (!inlay && values.additionalAssets?.length === 0)
        values.additionalAssets = undefined;
    }
  }
  values.newGenData = updateInlayScreen({
    viewScreen,
    inlayViewScreen: values.inlayViewScreen,
  } as character).newGenData;
}
