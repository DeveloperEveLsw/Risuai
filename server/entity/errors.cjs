"use strict";

class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.details = details;
  }
}

module.exports = { RuntimeError };
