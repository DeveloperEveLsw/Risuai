import type {
  GroupImageSourceGuard,
  GroupImageSourcePage,
} from "./fieldCommands";

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new Error("The group image editor was closed");
}
function loadImage(url: string, signal: AbortSignal) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    checkAbort(signal);
    const image = new Image();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      image.onload = image.onerror = null;
      if (error) {
        image.src = "";
        reject(error);
      } else resolve(image);
    };
    const abort = () => finish(new Error("The group image editor was closed"));
    const timer = setTimeout(
      () =>
        finish(new Error("A member image did not finish loading; try again")),
      15000,
    );
    signal.addEventListener("abort", abort, { once: true });
    image.crossOrigin = "anonymous";
    image.onload = () => finish();
    image.onerror = () =>
      finish(new Error("A group member image could not be loaded"));
    image.src = url;
  });
}
/** Original 256px stretched grid, deterministic membership order and at most four decoded images. */
export async function composeGroupImage(options: {
  groupId: string;
  signal: AbortSignal;
  hideImages: boolean;
  read: (
    offset: number,
    guard?: GroupImageSourceGuard,
  ) => Promise<GroupImageSourcePage>;
  source: (image: string) => Promise<string>;
}) {
  const { signal } = options;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  let guard: GroupImageSourceGuard | undefined,
    count = -1,
    offset = 0;
  try {
    do {
      checkAbort(signal);
      const page = await options.read(offset, guard);
      checkAbort(signal);
      if (
        page.guard.groupId !== options.groupId ||
        (guard && JSON.stringify(guard) !== JSON.stringify(page.guard)) ||
        !Number.isSafeInteger(page.count) ||
        page.count < 0 ||
        (count >= 0 && count !== page.count) ||
        page.sources.length !== Math.min(128, page.count - offset) ||
        page.nextOffset !==
          (offset + page.sources.length < page.count
            ? offset + page.sources.length
            : null)
      )
        throw new Error("Group image sources changed; try again");
      guard = page.guard;
      count = page.count;
      const columns = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / columns);
      for (let i = 0; i < page.sources.length; i += 4) {
        const batch = page.sources.slice(i, i + 4);
        const images = await Promise.allSettled(
          batch.map(async (member, index) => {
            if (member.position !== offset + i + index)
              throw new Error("Invalid group image order");
            if (!options.hideImages && !member.image)
              throw new Error("A group member has no image");
            const url = options.hideImages
              ? "/none.webp"
              : await options.source(member.image!);
            checkAbort(signal);
            return loadImage(url, signal);
          }),
        );
        try {
          checkAbort(signal);
          for (let j = 0; j < images.length; j++) {
            const image = images[j];
            if (image.status === "rejected") throw image.reason;
            const position = batch[j].position;
            context.drawImage(
              image.value,
              ((position % columns) * 256) / columns,
              (Math.floor(position / columns) * 256) / rows,
              256 / columns,
              256 / rows,
            );
          }
        } finally {
          for (const image of images)
            if (image.status === "fulfilled") image.value.src = "";
        }
      }
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value
            ? resolve(value)
            : reject(new Error("Could not encode the group image")),
        "image/png",
      ),
    );
    checkAbort(signal);
    return { data: new Uint8Array(await blob.arrayBuffer()), guard: guard! };
  } finally {
    canvas.width = canvas.height = 0;
    canvas.remove();
  }
}
