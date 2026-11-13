import { BrowserDisplayLua } from "../../src/ts/runtime/browserDisplayLua";
import {
  DisplayWorkerExecutor,
  pinDisplayCapture,
} from "../../src/ts/runtime/displayWorkerExecutor";
import { browserRuntime } from "../../src/ts/runtime/browserRuntimeState.svelte";
import { getBrowserCbsHost } from "../../src/ts/parser/parser.svelte";

// This harness only reads the neutral character created by the owning loopback test.
export function createWorkerHarness(budgetMs = 800) {
  let code = "",
    content = "Synthetic",
    clock = 0;
  const commands = [],
    errors = [],
    imageCalls = [];
  const pixel = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  const runtime = new BrowserDisplayLua(
    () =>
      ({
        readImage: async (path) => {
          imageCalls.push({ path });
          return pixel;
        },
        writeInlayImage: async (image, options) => {
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
          });
          imageCalls.push({
            options,
            width: image.width,
            height: image.height,
          });
          return "synthetic-worker-image";
        },
      }) as never,
    {
      capture: () => {
        const capture = browserRuntime().captureDisplay(-1, true, "c");
        if (!capture)
          throw new Error("Synthetic original UI scope is not ready");
        const cbs = getBrowserCbsHost();
        capture.cbsModules = [];
        capture.cbsLorebooks = [
          { comment: "Synthetic lore", content: "{{getvar::worker_value}}" },
        ] as never;
        capture.cbsEnvironment = {
          model: cbs.getModelInfo(capture.database.aiModel),
          triggerId: cbs.getCurrentTriggerId(),
          isTauri: cbs.isTauri,
          isNodeServer: cbs.isNodeServer,
          isMobile: cbs.isMobile,
          appVer: cbs.appVer,
        };
        capture.state.inputClock += clock;
        capture.sourceContent = content;
        capture.chat.scriptstate = { $worker_value: "pinned" };
        capture.character.image = "synthetic-image.png";
        capture.character.triggerscript = [
          {
            type: "manual",
            conditions: [],
            effect: [{ type: "triggerlua", code }],
          },
        ];
        capture.triggers = capture.character.triggerscript;
        return pinDisplayCapture(capture);
      },
      seen: () => false,
      pending: () => undefined,
      submit: async (command) => {
        commands.push(command);
      },
      error: (error) => {
        errors.push(String(error));
      },
      parser: () => {
        throw new Error("Worker must not run the browser CBS parser");
      },
    },
    8,
    (base) => new DisplayWorkerExecutor(base, budgetMs),
  );
  return {
    runtime,
    commands,
    errors,
    imageCalls,
    run: (script, text = "Synthetic") => {
      code = script;
      content = text;
      return runtime.run(content);
    },
    nextClock: () => {
      clock++;
    },
  };
}
