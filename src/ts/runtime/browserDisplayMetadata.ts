import type { DisplayCapture } from "./displayEffects";
// One source header is pinned before the original asynchronous presentation stages.
export const displayMetadata = new WeakMap<
  object,
  {
    firstMessage: boolean;
    rawContent?: string;
    captured?: boolean;
    capture?: DisplayCapture;
    current?: () => boolean;
    drafts?: import("./browserDisplayLua").DisplayDraft[];
    admit?: (
      admission: import("./displayReadDependencies").DisplayReadAdmission,
    ) => Promise<void>;
    admission?: Promise<void>;
    admissionSignature?: string;
  }
>();
