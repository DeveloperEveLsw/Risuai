import shuffle from "lodash/shuffle";
import { createGroupOrderRuntime } from "./groupOrderRuntime";
import { findCharacterbyId } from "../util";
import { alertConfirm, alertError, alertSelectChar } from "../alert";
import { language } from "src/lang";
import { get } from "svelte/store";
import { DBState, selectedCharID } from "../stores.svelte";
import {
  browserRuntime,
  entityRuntimeEnabled,
  reportRuntimeError,
} from "../runtime/browserRuntimeState.svelte";

export async function addGroupChar() {
  let selectedId = get(selectedCharID);
  let group = DBState.db.characters[selectedId];
  if (group.type === "group") {
    if (entityRuntimeEnabled) {
      try {
        // Selection and confirmation may outlive the current screen. Pin the
        // owner and greeting chat before either dialog opens.
        const runtime = browserRuntime();
        const target = runtime.captureGroup(group.chaId);
        const memberId = await alertSelectChar();
        if (!memberId) return;
        if (runtime.groupView(target.groupId).characters.includes(memberId)) {
          alertError(language.errors.alreadyCharInGroup);
          return;
        }
        const greeting = await alertConfirm(language.askLoadFirstMsg);
        await runtime.addGroupMember(target, memberId, greeting);
      } catch (error) {
        reportRuntimeError(error);
      }
      return;
    }
    const res = await alertSelectChar();
    if (res) {
      if (group.characters.includes(res)) {
        alertError(language.errors.alreadyCharInGroup);
      } else {
        if (await alertConfirm(language.askLoadFirstMsg)) {
          group.chats[group.chatPage].message.push({
            role: "char",
            data: findCharacterbyId(res).firstMessage,
            saying: res,
          });
        }

        group.characters.push(res);
        group.characterTalks.push((1 / 6) * 4);
        group.characterActive.push(true);
      }
    }
  }
}

export async function rmCharFromGroup(index: number) {
  let selectedId = get(selectedCharID);
  let group = DBState.db.characters[selectedId];
  if (group.type === "group") {
    if (entityRuntimeEnabled) {
      try {
        const runtime = browserRuntime();
        const memberId = runtime.groupView(group.chaId).characters[index];
        const target = runtime.captureGroupMember(group.chaId, memberId, index);
        await runtime.changeGroupMember(target, "remove");
      } catch (error) {
        reportRuntimeError(error);
      }
      return;
    }
    group.characters.splice(index, 1);
    group.characterTalks.splice(index, 1);
    group.characterActive.splice(index, 1);
  }
}

export type { GroupOrder } from "./groupOrderRuntime";
export const { groupOrder } = createGroupOrderRuntime({
  findCharacterbyId,
  shuffle,
});
