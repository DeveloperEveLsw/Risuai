export type Json =
  null | string | number | boolean | Json[] | { [key: string]: Json };
export type RuntimeCommand = { type: string; [key: string]: Json };
export type AdmissionKind = "command" | "job";
export interface RuntimeChange {
  sequence: number;
  type: string;
  id: string;
  chatId: string | null;
  revision: number | null;
  payload: Record<string, Json>;
}
export interface RuntimeBootstrap {
  serverId: string;
  cursor: number;
  fieldReadChecksVersion?: number;
  groupImageSourcesVersion?: number;
  characterNavigation?: import("./characterNavigation.mjs").CharacterNavigationHeader;
  characters: {
    id: string;
    name: string;
    kind: string;
    revision: number;
    chatCount: number;
    entityEpoch?: number;
  }[];
  lifecycleTombstones?: { kind: string; id: string; revision: number }[];
  resources: { kind: string; id: string; revision: number; deleted: number }[];
  statistics: {
    settingsId: string;
    revision: number;
    messages: number;
    imports: number;
  }[];
}
export interface RuntimeFailure {
  code: string;
  message: string;
  details?: Json;
  requestId?: string;
}
export class RuntimeClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public details?: Json,
    public requestId?: string,
  ) {
    super(message);
    this.name = "RuntimeClientError";
  }
}

export interface RuntimeLibraryItem {
  kind: string;
  id: string;
  revision: number;
  entityEpoch: number;
  payloadBytes: number;
  summary: {
    name: string;
    description: string;
    namespace: string;
    mcp: boolean;
  };
}
export interface RuntimeLibraryPage {
  kind: string;
  cursor: number;
  items: RuntimeLibraryItem[];
  next: string | null;
}

// Matching the server's canonical JSON prevents a reused ID from changing its payload.
export function commandJson(value: unknown): string {
  function canonical(item: unknown): Json {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item as Json;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return Array.from(item, canonical);
    if (
      item &&
      typeof item === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])]),
      );
    throw new RuntimeClientError(
      "INVALID_COMMAND",
      "Command must contain only JSON values",
    );
  }
  return JSON.stringify(canonical(value));
}
export function validCursor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
