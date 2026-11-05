import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeBackgroundSettings } from "./backgroundSettings.ts";

test("removed web background safely falls back and drops the saved URL", () => {
  const settings = normalizeBackgroundSettings({
    backgroundSource: "web-random", backgroundWebUrl: "https://example.invalid/image",
    backgroundImage: "/old/unused.png", backgroundVideo: "/old/unused.mp4"
  });
  assert.deepEqual(settings, { backgroundSource: "local", backgroundImage: "", backgroundVideo: "" });
  assert.equal("backgroundWebUrl" in settings, false);
});

test("local backgrounds survive migration but remote image/video URLs do not", () => {
  assert.equal(normalizeBackgroundSettings({ backgroundSource: "local", backgroundImage: "/tmp/image.png" }).backgroundImage, "/tmp/image.png");
  assert.equal(normalizeBackgroundSettings({ backgroundSource: "video", backgroundVideo: "blob:local" }).backgroundVideo, "blob:local");
  for (const remote of ["https://example.invalid/bg", " HTTP://example.invalid/bg ", "//example.invalid/bg"]) {
    assert.deepEqual(normalizeBackgroundSettings({ backgroundSource: "local", backgroundImage: remote, backgroundVideo: remote }), {
      backgroundSource: "local", backgroundImage: "", backgroundVideo: ""
    });
  }
});

test("malformed or missing old background fields use the default plain background", () => {
  for (const value of [null, {}, { backgroundSource: 7, backgroundWebUrl: {} }]) {
    assert.deepEqual(normalizeBackgroundSettings(value), { backgroundSource: "local", backgroundImage: "", backgroundVideo: "" });
  }
});
