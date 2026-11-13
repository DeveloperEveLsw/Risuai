"use strict";
const { createHash, randomUUID } = require("node:crypto");
const {
  mkdir,
  open,
  link,
  unlink,
  stat,
  readFile,
} = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { RuntimeError } = require("../entity/errors.cjs");
const { identity, assetId, MAX_ASSET_BYTES } = require("../entity/assets.cjs");
function mime(head, extension) {
  if (
    head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (head[0] === 255 && head[1] === 216 && head[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (
    head.subarray(4, 8).toString("ascii") === "ftyp" &&
    /^(avif|avis)$/.test(head.subarray(8, 12).toString("ascii"))
  )
    return "image/avif";
  return (
    {
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      wav: "audio/wav",
      mp4: "video/mp4",
      webm: "video/webm",
    }[extension] ?? "application/octet-stream"
  );
}
/** Immutable blobs are synced before SQLite metadata admits a reference. Unreferenced blobs are retained. */
class AssetStorage {
  constructor(file, store, serverId) {
    if (
      typeof serverId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(serverId)
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid asset authority identity",
      );
    this.root = resolve(file + ".assets", serverId);
    this.store = store;
    this.pending = new Set();
    this.closing = false;
  }
  upload(source, extension = "png") {
    if (this.closing)
      return Promise.reject(
        new RuntimeError("STORE_CLOSED", "Asset storage is closing"),
      );
    const task = this.write(source, extension);
    this.pending.add(task);
    task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  async write(source, extension) {
    if (typeof extension !== "string" || !/^[a-z0-9]{1,16}$/.test(extension))
      throw new RuntimeError("INVALID_COMMAND", "Invalid asset extension");
    await mkdir(this.root, { recursive: true });
    const temporary = join(this.root, randomUUID() + ".part");
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0,
        head = Buffer.alloc(0);
      for await (const raw of source) {
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > MAX_ASSET_BYTES)
          throw new RuntimeError(
            "ASSET_TOO_LARGE",
            "Asset exceeds the 64 MiB upload limit",
          );
        hash.update(chunk);
        if (head.length < 64)
          head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
        await handle.writeFile(chunk);
      }
      if (!size)
        throw new RuntimeError("INVALID_COMMAND", "Asset body is empty");
      await handle.sync();
      await handle.close();
      handle = null;
      const digest = hash.digest("hex"),
        destination = join(this.root, digest + ".blob");
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if ((await stat(destination)).size !== size)
          throw new RuntimeError(
            "ASSET_STORAGE_ERROR",
            "Existing asset has an invalid size",
          );
      }
      await unlink(temporary);
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return await this.store.call("registerAsset", {
        id: digest + "." + extension,
        digest,
        extension,
        byteLength: size,
        mime: mime(head, extension),
      });
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async file(id) {
    identity(id);
    const value = await this.store.call("getAsset", id);
    if (!value) throw new RuntimeError("NOT_FOUND", "Asset does not exist");
    const file = join(this.root, value.digest + ".blob");
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new RuntimeError(
          "ASSET_STORAGE_ERROR",
          "Stored asset file is missing",
        );
      throw error;
    }
    if (!info.isFile() || info.size !== value.byteLength)
      throw new RuntimeError(
        "ASSET_STORAGE_ERROR",
        "Stored asset file has an invalid size",
      );
    return { file, value };
  }
  async read(path, signal) {
    const { file } = await this.file(assetId(path));
    return new Uint8Array(await readFile(file, { signal }));
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.pending]);
  }
}
module.exports = { AssetStorage, mime };
