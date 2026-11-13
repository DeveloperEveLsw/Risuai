import type { Json, RuntimeCommand } from "./clientProtocol";

export type FieldTarget =
  | { scope: "character"; entityId: string; key: string }
  | { scope: "chat"; entityId: string; key: string }
  | {
      scope: "resource";
      resourceKind: "settings" | "module" | "preset" | "persona" | "plugin";
      entityId: string;
      key: string;
    };
export type FieldEdit = FieldTarget & {
  expectedRevision: number;
  expectedEpoch: number;
} & ({ value: Json; remove?: false } | { remove: true; value?: never });
export type FieldCheck = FieldTarget & {
  expectedRevision: number;
  expectedEpoch: number;
};
export interface GroupImageSourceGuard {
  groupId: string;
  expectedEpoch: number;
  expectedMembershipRevision: number;
  digest: string;
}
export interface GroupImageSourcePage {
  guard: GroupImageSourceGuard;
  sources: { memberId: string; position: number; image: string | null }[];
  count: number;
  nextOffset: number | null;
}
export interface DerivedFieldOptions {
  checks?: FieldCheck[];
  groupImageSources?: GroupImageSourceGuard;
}
export type FieldValue = FieldTarget & {
  revision: number;
  entityEpoch: number;
  exists: boolean;
  value?: Json;
};
export type FieldIntent = { target: FieldTarget; value: Json | undefined };
export function fieldIdentity(target: FieldTarget) {
  return JSON.stringify([
    "field",
    target.scope,
    "resourceKind" in target ? target.resourceKind : "",
    target.entityId,
    target.key,
  ]);
}
export function fieldHeadIdentity(edit: FieldEdit) {
  return JSON.stringify([fieldIdentity(edit), edit.expectedEpoch]);
}
export function fieldTarget(edit: FieldTarget): FieldTarget {
  return edit.scope === "resource"
    ? {
        scope: edit.scope,
        resourceKind: edit.resourceKind,
        entityId: edit.entityId,
        key: edit.key,
      }
    : { scope: edit.scope, entityId: edit.entityId, key: edit.key };
}
export function fieldEdits(command: RuntimeCommand): FieldEdit[] {
  return command.type === "change-fields" && Array.isArray(command.edits)
    ? (command.edits as unknown as FieldEdit[])
    : [];
}
