"use strict";
const { RuntimeError } = require("./errors.cjs");
const MAX_BYTES = 4 * 1024 * 1024;
const modes = new Set([
  "model",
  "submodel",
  "memory",
  "emotion",
  "otherAx",
  "translate",
]);
function normalize(output) {
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    Object.keys(output).some(
      (key) =>
        !["request", "mode", "type", "complete", "candidates"].includes(key),
    ) ||
    !Number.isSafeInteger(output.request) ||
    output.request < 1 ||
    output.request > 64 ||
    !modes.has(output.mode) ||
    !["success", "multiline", "streaming"].includes(output.type) ||
    typeof output.complete !== "boolean" ||
    !Array.isArray(output.candidates) ||
    output.candidates.length > 64
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Invalid retained provider output",
    );
  const seen = new Set();
  const candidates = output.candidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some(
        (key) => !["key", "role", "data"].includes(key),
      ) ||
      typeof candidate.key !== "string" ||
      candidate.key.length > 80 ||
      seen.has(candidate.key) ||
      !["char", "user"].includes(candidate.role) ||
      typeof candidate.data !== "string"
    )
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Invalid retained provider candidate",
      );
    seen.add(candidate.key);
    return { key: candidate.key, role: candidate.role, data: candidate.data };
  });
  return {
    request: output.request,
    mode: output.mode,
    type: output.type,
    complete: output.complete,
    candidates,
  };
}
function upsert(previous = [], output) {
  const value = normalize(output);
  const values = previous
    .filter((entry) => entry.request !== value.request)
    .concat(value)
    .sort((a, b) => a.request - b.request);
  if (
    values.length > 64 ||
    Buffer.byteLength(JSON.stringify(values)) > MAX_BYTES
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Retained provider outputs exceed the 4 MiB job budget",
    );
  return values;
}
function project(values) {
  if (!Array.isArray(values) || values.length > 64) return [];
  try {
    const result = values.map(normalize);
    if (
      new Set(result.map((value) => value.request)).size !== result.length ||
      Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES
    )
      return [];
    return result;
  } catch {
    return [];
  }
}
function writeRow(store, jobId, output) {
  const value = normalize(output),
    payload = JSON.stringify(value),
    bytes = Buffer.byteLength(payload);
  // Count JSON array commas/brackets too. Read only row metadata for other
  // requests; never reparse or rewrite their retained text on each chunk.
  const other = store.db
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes),0) AS bytes FROM job_provider_outputs WHERE job_id=? AND request<>?",
    )
    .get(jobId, value.request);
  if (other.count >= 64 || other.bytes + bytes + other.count + 2 > MAX_BYTES)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Retained provider outputs exceed the 4 MiB job budget",
    );
  store.db
    .prepare(
      "INSERT INTO job_provider_outputs(job_id,request,payload,payload_bytes) VALUES (?,?,?,?) ON CONFLICT(job_id,request) DO UPDATE SET payload=excluded.payload,payload_bytes=excluded.payload_bytes",
    )
    .run(jobId, value.request, payload, bytes);
}

// Called only inside the owned writeJobProgress transaction.
function apply(store, jobId, values) {
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    new Set(values.map((value) => value?.request)).size !== values.length
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Invalid retained provider output updates",
    );
  for (const value of values) writeRow(store, jobId, value);
}

function read(store, jobId) {
  return project(
    store.db
      .prepare(
        "SELECT payload FROM job_provider_outputs WHERE job_id=? ORDER BY request",
      )
      .all(jobId)
      .map((row) => JSON.parse(row.payload)),
  );
}

function bytes(store, jobId) {
  const row = store.db
    .prepare(
      "SELECT COUNT(*) AS count,COALESCE(SUM(payload_bytes),0) AS bytes FROM job_provider_outputs WHERE job_id=?",
    )
    .get(jobId);
  return row.count ? row.bytes + row.count + 1 : 0;
}

function migrate(store) {
  const rows = store.db
    .prepare(
      "SELECT id,state FROM jobs WHERE json_type(progress,'$.providerOutputs') IS NOT NULL",
    )
    .all();
  for (const row of rows) {
    const progress = JSON.parse(
      store.db.prepare("SELECT progress FROM jobs WHERE id=?").get(row.id)
        .progress,
    );
    const values = project(progress.providerOutputs);
    if (
      !Array.isArray(progress.providerOutputs) ||
      values.length !== progress.providerOutputs.length
    )
      throw new RuntimeError(
        "MIGRATION_ERROR",
        "Legacy retained model output is invalid; migration was rolled back",
      );
    if (row.state !== "completed")
      for (const value of values) writeRow(store, row.id, value);
    delete progress.providerOutputs;
    store.db
      .prepare("UPDATE jobs SET progress=? WHERE id=?")
      .run(JSON.stringify(progress), row.id);
  }
}

module.exports = {
  normalize,
  upsert,
  project,
  apply,
  read,
  bytes,
  migrate,
  MAX_BYTES,
};
