import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveLaunchOptions, normalizeLaunchOptions } from "./launchOptions.ts";

test("empty instance options inherit global launch settings", () => {
  const global = { maxMemoryMb: 4096, launchOptions: {
    javaPath: "/opt/java/bin/java", jvmArgs: ["-Dname=a b"], windowWidth: 1280, windowHeight: 720
  }};
  assert.deepEqual(resolveLaunchOptions(global, {}), {
    maxMemoryMb: 4096, javaPath: "/opt/java/bin/java", jvmArgs: ["-Dname=a b"],
    windowWidth: 1280, windowHeight: 720
  });
  assert.equal(resolveLaunchOptions(global, { javaPath: " ", maxMemoryMb: undefined }).javaPath, "/opt/java/bin/java");
});

test("instance options override each field without losing other defaults", () => {
  const result = resolveLaunchOptions({ maxMemoryMb: 2048, launchOptions: { javaPath: "/global", windowWidth: 900 } }, {
    maxMemoryMb: 8192, jvmArgs: ["-Dpath=C:\\Program Files\\Java"], windowHeight: 800
  });
  assert.deepEqual(result, {
    maxMemoryMb: 8192, javaPath: "/global", jvmArgs: ["-Dpath=C:\\Program Files\\Java"],
    windowWidth: 900, windowHeight: 800
  });
});

test("malformed saved options are bounded and cannot pass non-string arguments", () => {
  assert.deepEqual(normalizeLaunchOptions({
    maxMemoryMb: Infinity, javaPath: 17, jvmArgs: ["-ea", null, ""],
    windowWidth: -1, windowHeight: 1e9
  }), { jvmArgs: ["-ea"], windowWidth: 320, windowHeight: 16384 });
  assert.deepEqual(normalizeLaunchOptions(null), {});
});

test("JVM argument check rejects -Xmx and classpath flags like the backend", async () => {
  const { findInvalidJvmArg } = await import("./launchOptions.ts");
  assert.equal(findInvalidJvmArg(["-Dname=a b", " -XX:+UseG1GC ", ""]), null);
  assert.equal(findInvalidJvmArg(["-Dok=1", "-Xmx4G"]), "-Xmx4G");
  assert.equal(findInvalidJvmArg(["-cp"]), "-cp");
  assert.equal(findInvalidJvmArg(["notAnOption"]), "notAnOption");
  assert.equal(findInvalidJvmArg(undefined), null);
});

test("JVM argument check rejects NUL characters", async () => {
  const { findInvalidJvmArg } = await import("./launchOptions.ts");
  assert.equal(findInvalidJvmArg(["-Da\0b"]), "-Da\0b");
});
