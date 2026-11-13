import { sleep } from "./util";
import { globalFetch } from "./globalApi.svelte";

let bgmElement: HTMLAudioElement | null = null;
const observedDom = new WeakMap<
  Element,
  { hlLang: string | null; ctrlName: string | null; abort: AbortController }
>();
let domObserver: MutationObserver | undefined;

function playBgmControl(node: Element) {
  const split = node.getAttribute("risu-ctrl")?.split("___");
  if (split?.[0] !== "bgm" || bgmElement) return;
  const volume = split[1] === "auto" ? 0.5 : parseFloat(split[1]);
  const audio = new Audio(split[2]);
  bgmElement = audio;
  audio.volume = volume;
  audio.addEventListener("ended", () => {
    audio.remove();
    if (bgmElement !== audio) return;
    bgmElement = null;
    // The original 100 ms scan replayed the first connected BGM control after
    // the current track ended. Retain that behavior with one event-driven retry.
    setTimeout(() => {
      const next = document.querySelector('[risu-ctrl^="bgm___"]');
      if (next) playBgmControl(next);
    }, 100);
  });
  audio.play();
}

function nodeObserve(node: Element) {
  const hlLang = node.getAttribute("x-hl-lang");
  const ctrlName = node.getAttribute("risu-ctrl");
  const previous = observedDom.get(node);
  if (previous?.hlLang === hlLang && previous.ctrlName === ctrlName) return;
  previous?.abort.abort();
  if (!hlLang && !ctrlName) {
    observedDom.delete(node);
    return;
  }
  const abort = new AbortController();
  observedDom.set(node, { hlLang, ctrlName, abort });

  if (hlLang) {
    node.addEventListener(
      "contextmenu",
      (event) => {
        const e = event as MouseEvent;
        e.preventDefault();

        const prevContextMenu = document.getElementById("code-contextmenu");
        if (prevContextMenu) {
          prevContextMenu.remove();
        }

        const menu = document.createElement("div");
        menu.id = "code-contextmenu";
        menu.setAttribute(
          "class",
          "fixed z-50 min-w-[160px] py-2 bg-gray-800 rounded-lg border border-gray-700",
        );

        const copyOption = document.createElement("div");
        copyOption.textContent = "Copy";
        copyOption.setAttribute(
          "class",
          "px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer",
        );
        copyOption.addEventListener("click", () => {
          navigator.clipboard.writeText(node.textContent);
          menu.remove();
        });

        const downloadOption = document.createElement("div");
        downloadOption.textContent = "Download";
        downloadOption.setAttribute(
          "class",
          "px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 cursor-pointer",
        );
        downloadOption.addEventListener("click", () => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(
            new Blob([node.textContent], { type: "text/plain" }),
          );
          a.download = "code." + hlLang;
          a.click();
          menu.remove();
        });

        menu.appendChild(copyOption);
        menu.appendChild(downloadOption);

        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";

        document.body.appendChild(menu);

        document.addEventListener(
          "click",
          () => {
            menu?.remove();
          },
          { once: true },
        );
      },
      { signal: abort.signal },
    );
  }

  if (ctrlName) {
    playBgmControl(node);
  }
}

export async function startObserveDom() {
  if (domObserver) return;
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return;
    nodeObserve(node);
    node
      .querySelectorAll<Element>("[x-hl-lang], [risu-ctrl]")
      .forEach(nodeObserve);
  };
  domObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        if (mutation.target instanceof Element) nodeObserve(mutation.target);
      } else mutation.addedNodes.forEach(scan);
    });
  });
  const root = document.body ?? document.documentElement;
  domObserver.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["x-hl-lang", "risu-ctrl"],
  });
  scan(root);
}


let claudeObserverRunning = false;
let lastClaudeObserverLoad = 0;
let lastClaudeRequestTimes = 0;
let lastClaudeObserverPayload:any = null;
let lastClaudeObserverHeaders:any = null;
let lastClaudeObserverURL:any = null;

export function registerClaudeObserver(arg:{
    url:string,
    body:any,
    headers:any,
}) {
    lastClaudeRequestTimes = 0;
    lastClaudeObserverLoad = Date.now();
    lastClaudeObserverPayload = safeStructuredClone(arg.body)
    lastClaudeObserverHeaders = arg.headers;
    lastClaudeObserverURL = arg.url;
    lastClaudeObserverPayload.max_tokens = 10;
    claudeObserver()
}

function claudeObserver(){
    if(claudeObserverRunning){
        return
    }
    claudeObserverRunning = true;

    const fetchIt = async (tries = 0)=>{
        const res = await globalFetch(lastClaudeObserverURL, {
            body: lastClaudeObserverPayload,
            headers: lastClaudeObserverHeaders,
            method: "POST"
        })
        if(res.status >= 400){
            if(tries < 3){
                fetchIt(tries + 1)
            }
        }
    }

    const func = ()=>{       
        //request every 4 minutes and 30 seconds
        if(lastClaudeObserverLoad > Date.now() - 1000 * 60 * 4.5){
            return
        }
        
        if(lastClaudeRequestTimes > 4){
            return
        }
        fetchIt()
        lastClaudeObserverLoad = Date.now();
        lastClaudeRequestTimes += 1;
    }
    
    setInterval(func, 20000)
}
