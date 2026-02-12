import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";

type InstallResult = {
  versionId: string;
  librariesDownloaded: number;
  assetsDownloaded: number;
};

type LaunchPlan = {
  command: string[];
  mainClass: string;
};

type FabricInstallResult = {
  profileId: string;
  librariesDownloaded: number;
};

type ForgeInstallResult = {
  forgeVersion: string;
  exitCode: number;
};

export function App() {
  const [gameDir, setGameDir] = useState("./.minecraft");
  const [versionId, setVersionId] = useState("1.21.4");
  const [versions, setVersions] = useState<string[]>([]);
  const [fabricLoaders, setFabricLoaders] = useState<string[]>([]);
  const [forgeVersions, setForgeVersions] = useState<string[]>([]);
  const [fabricLoaderVersion, setFabricLoaderVersion] = useState("0.16.10");
  const [forgeVersion, setForgeVersion] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  const canRun = useMemo(() => gameDir.trim() !== "" && versionId.trim() !== "", [gameDir, versionId]);

  async function listVersions() {
    setBusy(true);
    try {
      const result = await invoke<string[]>("list_vanilla_versions");
      setVersions(result.slice(0, 30));
      setOutput(`Loaded ${result.length} versions`);
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function installVanilla() {
    if (!canRun) return;
    setBusy(true);
    try {
      const result = await invoke<InstallResult>("install_vanilla", { game_dir: gameDir, version_id: versionId });
      setOutput(
        `Installed ${result.versionId} with ${result.librariesDownloaded} libraries and ${result.assetsDownloaded} assets`
      );
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function buildLaunchPlan() {
    if (!canRun) return;
    setBusy(true);
    try {
      const result = await invoke<LaunchPlan>("build_vanilla_launch_plan", {
        game_dir: gameDir,
        version_id: versionId,
        player_name: "Player",
        uuid: "00000000-0000-0000-0000-000000000000",
        access_token: "offline",
        max_memory_mb: 4096
      });
      setOutput(`MainClass: ${result.mainClass}\n${result.command.join(" ")}`);
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function listFabricLoaders() {
    setBusy(true);
    try {
      const result = await invoke<string[]>("list_fabric_loaders", { game_version: versionId });
      setFabricLoaders(result.slice(0, 40));
      if (result.length > 0) {
        setFabricLoaderVersion(result[0]);
      }
      setOutput(`Loaded ${result.length} fabric loader versions`);
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function installFabric() {
    setBusy(true);
    try {
      const result = await invoke<FabricInstallResult>("install_fabric", {
        game_dir: gameDir,
        game_version: versionId,
        loader_version: fabricLoaderVersion
      });
      setOutput(`Installed fabric profile ${result.profileId} with ${result.librariesDownloaded} libraries`);
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function listForgeVersions() {
    setBusy(true);
    try {
      const result = await invoke<string[]>("list_forge_versions", { game_version: versionId });
      setForgeVersions(result.slice(0, 50));
      if (result.length > 0) {
        setForgeVersion(result[0]);
      }
      setOutput(`Loaded ${result.length} forge versions for ${versionId}`);
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function installForge() {
    setBusy(true);
    try {
      const result = await invoke<ForgeInstallResult>("install_forge", {
        game_dir: gameDir,
        forge_version: forgeVersion
      });
      setOutput(`Installed forge ${result.forgeVersion} (exitCode=${result.exitCode})`);
    } catch (err) {
      setOutput(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <section className="card">
        <h1>FPSMaster Launcher</h1>
        <p>Phase 1: Vanilla install and launch planning</p>

        <label>
          Game Directory
          <input value={gameDir} onChange={(e) => setGameDir(e.target.value)} />
        </label>

        <label>
          Version ID
          <input value={versionId} onChange={(e) => setVersionId(e.target.value)} />
        </label>

        <div className="actions">
          <button onClick={listVersions} disabled={busy}>List Versions</button>
          <button onClick={installVanilla} disabled={!canRun || busy}>Install Vanilla</button>
          <button onClick={buildLaunchPlan} disabled={!canRun || busy}>Build Launch Plan</button>
          <button onClick={listFabricLoaders} disabled={!canRun || busy}>List Fabric</button>
          <button onClick={installFabric} disabled={!canRun || busy || fabricLoaderVersion === ""}>Install Fabric</button>
          <button onClick={listForgeVersions} disabled={!canRun || busy}>List Forge</button>
          <button onClick={installForge} disabled={!canRun || busy || forgeVersion === ""}>Install Forge</button>
        </div>

        <label>
          Fabric Loader
          <input value={fabricLoaderVersion} onChange={(e) => setFabricLoaderVersion(e.target.value)} />
        </label>

        <label>
          Forge Version
          <input value={forgeVersion} onChange={(e) => setForgeVersion(e.target.value)} />
        </label>

        <pre className="output">{output}</pre>

        {versions.length > 0 && (
          <div className="versions">
            {versions.map((version) => (
              <button key={version} onClick={() => setVersionId(version)}>{version}</button>
            ))}
          </div>
        )}

        {fabricLoaders.length > 0 && (
          <div className="versions">
            {fabricLoaders.map((version) => (
              <button key={version} onClick={() => setFabricLoaderVersion(version)}>{version}</button>
            ))}
          </div>
        )}

        {forgeVersions.length > 0 && (
          <div className="versions">
            {forgeVersions.map((version) => (
              <button key={version} onClick={() => setForgeVersion(version)}>{version}</button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
