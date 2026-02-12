import { invoke } from "@tauri-apps/api/core";

export type VanillaInstallResult = {
  versionId: string;
  versionJsonPath: string;
  librariesDownloaded: number;
  assetsDownloaded: number;
};

export type LaunchPlanResult = {
  command: string[];
  classpath: string;
  mainClass: string;
  nativesDirectory: string;
};

export type FabricInstallResult = {
  profileId: string;
  loaderVersion: string;
  profileJsonPath: string;
  librariesDownloaded: number;
};

export type ForgeInstallResult = {
  profileId: string;
  forgeVersion: string;
  profileJsonPath: string;
  installerUrl: string;
};

export async function detectJavaAndEnsureJdk(): Promise<string> {
  return invoke("ensure_jdk");
}

export async function listVanillaVersions(javaCoreJarPath: string): Promise<string[]> {
  return invoke("java_core_list_vanilla_versions", { javaCoreJarPath });
}

export async function installVanilla(
  javaCoreJarPath: string,
  gameDirectory: string,
  versionId: string
): Promise<VanillaInstallResult> {
  return invoke("java_core_install_vanilla", {
    javaCoreJarPath,
    gameDirectory,
    versionId
  });
}

export async function buildLaunchPlan(
  javaCoreJarPath: string,
  gameDirectory: string,
  versionId: string,
  javaPath: string,
  playerName: string
): Promise<LaunchPlanResult> {
  return invoke("java_core_build_launch_plan", {
    javaCoreJarPath,
    gameDirectory,
    versionId,
    javaPath,
    playerName
  });
}

export async function installFabric(
  javaCoreJarPath: string,
  gameDirectory: string,
  gameVersion: string,
  loaderVersion?: string
): Promise<FabricInstallResult> {
  return invoke("java_core_install_fabric", {
    javaCoreJarPath,
    gameDirectory,
    gameVersion,
    loaderVersion
  });
}

export async function installForge(
  javaCoreJarPath: string,
  gameDirectory: string,
  gameVersion: string,
  javaPath: string,
  forgeVersion?: string
): Promise<ForgeInstallResult> {
  return invoke("java_core_install_forge", {
    javaCoreJarPath,
    gameDirectory,
    gameVersion,
    forgeVersion,
    javaPath
  });
}
