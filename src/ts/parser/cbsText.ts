// Shared CBS escaping, independent of DOM and application state.
const replacements = [
  "{", //0xE9B8
  "}", //0xE9B9
  "(", //0xE9BA
  ")", //0xE9BB
  "&lt;", //0xE9BC
  "&gt;", //0xE9BD
  ":", //0xE9BE
  ";", //0xE9BF
];

export function risuUnescape(text: string) {
  return text.replace(/[\uE9b8-\uE9bf]/g, (f) => {
    const index = f.charCodeAt(0) - 0xe9b8;
    return replacements[index];
  });
}

export function risuEscape(text: string) {
  return text.replace(/[{}()]/g, (f) => {
    switch (f) {
      case "{":
        return "\uE9B8";
      case "}":
        return "\uE9B9";
      case "(":
        return "\uE9BA";
      case ")":
        return "\uE9BB";
      default:
        return f;
    }
  });
}
