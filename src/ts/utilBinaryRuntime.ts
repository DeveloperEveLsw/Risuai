/** Pure upstream binary text helper, independent of browser state. */
export function createUtilBinaryRuntime() {
  function base64url(source: Uint8Array | ArrayBuffer): string {
    const bytes =
      source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    let encodedSource = btoa(String.fromCharCode.apply(null, [...bytes]))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    return encodedSource;
  }
  return { base64url };
}
