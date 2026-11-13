import { expect, test } from "vitest";
import { StableDisplayDom } from "./stableDisplayDom";

test("deep authored trees retain their owner and update through the explicit replacement fallback", () => {
  const root = document.createElement("div"),
    view = new StableDisplayDom(root);
  const html = (text: string) =>
    '<section id="outer">' +
    "<div>".repeat(180) +
    `<input id="deep" value="${text}">` +
    "</div>".repeat(180) +
    "</section>";
  view.update(html("before"));
  const outer = root.querySelector("#outer"),
    deep = root.querySelector<HTMLInputElement>("#deep");
  deep.value = "local";
  view.update(html("after"));
  expect(root.querySelector("#outer")).toBe(outer);
  expect(root.querySelector<HTMLInputElement>("#deep").value).toBe("after");
  expect(root.querySelector("#deep")).not.toBe(deep);
  view.close();
});

test("changed neighboring HTML preserves local controls and resolved image state inside the owned range", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const outside = document.createElement("span");
  root.append(outside);
  const view = new StableDisplayDom(root);
  const html = (value: string) =>
    `<section><img id="image" src="asset-name" class="authored"><input id="input" value="original"><input id="check" type="checkbox"><textarea id="text">original</textarea><span>${value}</span></section>`;
  view.update(html("before"));
  const image = root.querySelector<HTMLImageElement>("#image"),
    input = root.querySelector<HTMLInputElement>("#input"),
    check = root.querySelector<HTMLInputElement>("#check"),
    text = root.querySelector<HTMLTextAreaElement>("#text");
  image.src = "blob:synthetic-resolved";
  image.classList.add("root-loaded-image");
  input.value = "local typing";
  input.focus();
  input.setSelectionRange(2, 4);
  check.checked = true;
  text.value = "local textarea";
  view.update(html("after"));
  expect(root.querySelector("#image")).toBe(image);
  expect(image.getAttribute("src")).toBe("blob:synthetic-resolved");
  expect(image.classList.contains("root-loaded-image")).toBe(true);
  expect(root.querySelector("#input")).toBe(input);
  expect(input.value).toBe("local typing");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);
  expect(check.checked).toBe(true);
  expect(text.value).toBe("local textarea");
  expect(root.textContent).toContain("after");
  view.close();
  expect(root.childNodes.length).toBe(1);
  expect(root.firstChild).toBe(outside);
  view.update(html("late"));
  expect(root.childNodes.length).toBe(1);
  root.remove();
});

test("explicit authored changes replace control values and image sources; removed identities do not inherit local state", () => {
  const root = document.createElement("div"),
    view = new StableDisplayDom(root);
  view.update(
    '<input id="same" value="old" checked type="checkbox"><textarea id="text">old</textarea><img id="image" src="old" class="old">',
  );
  const input = root.querySelector<HTMLInputElement>("#same"),
    text = root.querySelector<HTMLTextAreaElement>("#text"),
    image = root.querySelector<HTMLImageElement>("#image");
  input.value = "local";
  text.value = "local";
  image.classList.add("external");
  image.classList.add("root-loaded-image", "root-loaded-image-test");
  image.setAttribute("noimage", "true");
  view.update(
    '<input id="same" value="new" type="checkbox"><textarea id="text">new</textarea><img id="image" src="new" class="new">',
  );
  expect(input.value).toBe("new");
  expect(input.checked).toBe(false);
  expect(text.value).toBe("new");
  expect(image.getAttribute("src")).toBe("new");
  expect(image.className).toBe("external new");
  expect(image.hasAttribute("noimage")).toBe(false);
  view.update('<input id="different" value="fresh">');
  expect(root.querySelector("#different")).not.toBe(input);
  expect(input.parentNode).toBeNull();
  view.close();
});

test("unique sibling identities survive reorder, inserted nodes and SVG namespace attributes without moving across owners", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const view = new StableDisplayDom(root);
  view.update(
    '<section><input id="a" value="a"><input id="b" value="b"><svg id="svg"><use xlink:href="#before" xmlns:xlink="http://www.w3.org/1999/xlink"/></svg></section>',
  );
  const a = root.querySelector<HTMLInputElement>("#a"),
    b = root.querySelector("#b"),
    svg = root.querySelector("#svg");
  a.value = "local";
  a.focus();
  a.setSelectionRange(1, 3);
  view.update(
    '<section><input id="b" value="b"><i>Inserted</i><input id="a" value="a"><svg id="svg"><use xlink:href="#after" xmlns:xlink="http://www.w3.org/1999/xlink"/></svg></section>',
  );
  expect(root.querySelector("#a")).toBe(a);
  expect(root.querySelector("#b")).toBe(b);
  expect(root.querySelector("#svg")).toBe(svg);
  expect(
    svg
      .querySelector("use")
      .getAttributeNS("http://www.w3.org/1999/xlink", "href"),
  ).toBe("#after");
  expect(a.value).toBe("local");
  expect(document.activeElement).toBe(a);
  expect([a.selectionStart, a.selectionEnd]).toEqual([1, 3]);
  const other = document.createElement("div"),
    otherView = new StableDisplayDom(other);
  otherView.update('<input id="a" value="fresh">');
  expect(other.querySelector("#a")).not.toBe(a);
  view.close();
  otherView.close();
  root.remove();
});
