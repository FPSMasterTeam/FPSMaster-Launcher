import assert from "node:assert/strict";
import { test } from "node:test";
import { localizeProgressMessage, translateStageName } from "./progressText.ts";

const t = (key: string, values?: Record<string, string | number>) =>
  `${key}${values ? JSON.stringify(values) : ""}`;

test("known progress messages map to locale keys", () => {
  assert.equal(localizeProgressMessage("Downloading", t as never), "progress.msg.downloading");
  assert.equal(
    localizeProgressMessage("Install completed version=1.20.1 libraries=3 assets=9", t as never),
    'progress.msg.installCompleted{"a":"1.20.1","b":"3","c":"9"}'
  );
  assert.equal(localizeProgressMessage("something unknown", t as never), "something unknown");
});

test("stage names translate, unknown stages pass through", () => {
  assert.equal(translateStageName("libraries", t as never), "dialog.stage.libraries");
  assert.equal(translateStageName("weird", t as never), "weird");
  assert.equal(translateStageName("", t as never), "dialog.stage.default");
});
