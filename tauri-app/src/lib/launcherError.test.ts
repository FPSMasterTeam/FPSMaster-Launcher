import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyApiError,
  describeApiError,
  isAuthExpiredError,
  isLauncherAppUpdateMissing,
  normalizeLoginError
} from "./launcherError.ts";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}${JSON.stringify(values)}` : key;

function apiError(status: number, code: string | null, message: string | null, context = "launcher home") {
  return `FPSMASTER_API_ERROR ${JSON.stringify({ status, code, message, context })}`;
}

test("only a 401 with a session code from the FPSMaster API expires the session", () => {
  assert.equal(isAuthExpiredError(apiError(401, "UNAUTHORIZED", "请先登录")), true);
  assert.equal(isAuthExpiredError(apiError(401, "AUTHENTICATION_REQUIRED", "Please sign in first.")), true);
  assert.equal(isAuthExpiredError(apiError(401, null, null)), true);
  // Wrong password on login is a 401 too, but not a dead session.
  assert.equal(isAuthExpiredError(apiError(401, "INVALID_CREDENTIALS", "用户名或密码错误")), false);
  assert.equal(isAuthExpiredError(apiError(403, "ACCOUNT_BANNED", "账号已被封禁")), false);
  // A mirror refusing a file must never log the user out.
  assert.equal(isAuthExpiredError("HTTP 403 Forbidden from https://bmclapi2.bangbang93.com/x.jar"), false);
  assert.equal(isAuthExpiredError("Mojang said: Forbidden"), false);
});

test("backend messages are shown verbatim, codes are not", () => {
  assert.equal(describeApiError(apiError(409, "ITEM_ALREADY_OWNED", "你已拥有该物品"), t), "你已拥有该物品");
  assert.equal(describeApiError(apiError(403, "FORBIDDEN", null), t), "error.http.forbidden");
  assert.equal(normalizeLoginError(apiError(401, "INVALID_CREDENTIALS", "用户名或密码错误"), t), "用户名或密码错误");
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

test("transport failures to the FPSMaster API use the server text", () => {
  const raw =
    "Releases request failed: error sending request for url (https://api.fpsmaster.top/api/v1/launcher/releases/available): operation timed out";
  assert.equal(classifyApiError(raw).kind, "timeout");
  assert.equal(describeApiError(raw, t), "error.network.timeout");
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

test("missing launcher update is detected from the tagged status", () => {
  assert.equal(isLauncherAppUpdateMissing(apiError(404, "NOT_FOUND", "not found", "launcher app update")), true);
  assert.equal(isLauncherAppUpdateMissing(apiError(500, "INTERNAL_ERROR", null)), false);
});
