import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const packageJsonPath = path.join(rootDir, "package.json");
const packageLockPath = path.join(rootDir, "package-lock.json");
const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(rootDir, "src-tauri", "Cargo.lock");
const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");

const packageJson = readJson(packageJsonPath);
const version = packageJson.version;

const packageLock = readJson(packageLockPath);
packageLock.version = version;
if (packageLock.packages?.[""]) {
  packageLock.packages[""].version = version;
}
writeJson(packageLockPath, packageLock);

const cargoToml = readFileSync(cargoTomlPath, "utf8");
const cargoTomlPattern = /(\[package\][\s\S]*?version = ")[^"]+(")/;
if (!cargoTomlPattern.test(cargoToml)) {
  throw new Error("Failed to locate package version in Cargo.toml");
}
writeFileSync(cargoTomlPath, cargoToml.replace(cargoTomlPattern, `$1${version}$2`), "utf8");

const cargoLock = readFileSync(cargoLockPath, "utf8");
const cargoLockPattern = /(\[\[package\]\]\r?\nname = "fpsmaster-launcher"\r?\nversion = ")[^"]+(")/;
if (!cargoLockPattern.test(cargoLock)) {
  throw new Error("Failed to locate package version in Cargo.lock");
}
writeFileSync(cargoLockPath, cargoLock.replace(cargoLockPattern, `$1${version}$2`), "utf8");

const tauriConfig = readJson(tauriConfigPath);
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

console.log(`Synchronized launcher version to ${version}`);
