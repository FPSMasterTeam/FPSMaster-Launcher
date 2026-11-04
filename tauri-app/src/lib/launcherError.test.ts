import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyApiError,
  describeApiError
} from "./launcherError.ts";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}${JSON.stringify(values)}` : key;

function apiError(status: number, code: string | null, message: string | null, context = "launcher home") {
  return `FPSMASTER_API_ERROR ${JSON.stringify({ status, code, message, context })}`;
}

test("backend messages are shown verbatim, codes are not", () => {
  assert.equal(describeApiError(apiError(409, "ITEM_ALREADY_OWNED", "你已拥有该物品"), t), "你已拥有该物品");
  assert.equal(describeApiError(apiError(403, "FORBIDDEN", null), t), "error.http.forbidden");
});

test("release catalog 404 without a body reads as unavailable, not unreleased", () => {
  assert.equal(describeApiError(apiError(404, null, null, "versions list"), t), "error.catalog.unavailable");
});

test("transport failures name the download source host", () => {
  const raw =
    "Failed to download x: error sending request for url (https://bmclapi2.bangbang93.com/assets/a): tcp connect error: Connection refused (os error 61)";
  const item = classifyApiError(raw);
  assert.equal(item.kind, "offline");
  assert.equal(item.fromApi, false);
  assert.equal(describeApiError(raw, t), 'error.source.offline{"host":"bmclapi2.bangbang93.com"}');
});

test("catalog transport failures name the public source", () => {
  const raw =
    "Releases request failed: error sending request for url (https://raw.githubusercontent.com/example/catalog.json): operation timed out";
  assert.equal(classifyApiError(raw).kind, "timeout");
  assert.equal(describeApiError(raw, t), 'error.source.timeout{"host":"raw.githubusercontent.com"}');
});

test("a proxy word in a message is not an offline error", () => {
  assert.notEqual(classifyApiError("Mod 'Proxy Utils' is incompatible").kind, "offline");
  assert.equal(classifyApiError("error sending request: unsuccessful tunnel").kind, "proxy");
});

test("download HTTP statuses are classified without touching auth", () => {
  assert.equal(classifyApiError("HTTP 404 Not Found from https://libraries.minecraft.net/a.jar").kind, "notFound");
  assert.equal(classifyApiError("HTTP 503 Service Unavailable from https://bmclapi2.bangbang93.com/").kind, "server");
  assert.equal(classifyApiError("SHA1 mismatch: expected=a actual=b").kind, "integrity");
  assert.equal(classifyApiError("Installation cancelled").kind, "cancelled");
  assert.equal(classifyApiError("Failed to write: No space left on device (os error 28)").kind, "diskFull");
});

test("public authorization failures do not imply a launcher session", () => {
  assert.equal(classifyApiError("HTTP 401 Unauthorized from https://example.org/package.jar").kind, "forbidden");
  assert.equal(classifyApiError("token is required").kind, "business");
});
