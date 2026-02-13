import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

type Page = "home" | "instances" | "install" | "settings";
type Loader = "vanilla" | "forge" | "fabric";
type PhaseStatus = "pending" | "running" | "done" | "error";

type Instance = {
  id: string;
  name: string;
  versionId: string;
  baseVersion: string;
  loader: Loader;
  loaderVersion?: string;
  preset: boolean;
};

type Settings = {
  gameDir: string;
  playerName: string;
  maxMemoryMb: number;
  hideMainOnLaunch: boolean;
};

type LaunchExecutionResult = {
  versionId: string;
  pid: number;
  command: string[];
  mainClass: string;
  shell: string;
};

type InstallResult = { versionId: string };
type FabricInstallResult = { profileId: string };
type ForgeInstallResult = { profileId: string; forgeVersion: string };
type JdkEnsureResult = { javaPath: string };

type UiLogEntry = { seq: number; source: string; level: string; message: string };
type UiLogPollResult = { entries: UiLogEntry[]; nextSeq: number };
type GameRuntimeStats = { pid: number; running: boolean; memoryMb: number | null; elapsedMs: number | null };

type InstallIpcEvent = {
  channel: string;
  event: string;
  phase?: string;
  stage?: string;
  session?: string;
  current?: number;
  total?: number;
  downloaded?: number;
  cached?: number;
  message?: string;
  error?: string;
};

type InstallPhaseState = {
  title: string;
  sourcePhase: "vanilla" | "forge" | "fabric";
  status: PhaseStatus;
  stage: string;
  message: string;
  current: number;
  total: number;
  downloaded: number;
  cached: number;
};

type InstallDialogState = {
  open: boolean;
  sessionId: string;
  versionId: string;
  loader: Loader;
  canClose: boolean;
  errorText: string;
  vanilla: InstallPhaseState;
  loaderPhase: InstallPhaseState | null;
};

const S_INST = "fpsmaster.instances";
const S_SET = "fpsmaster.settings";
const S_SEL = "fpsmaster.selected";

const NEWS = [
  ["Launcher UI Upgrade", "Home, instance manager and runtime monitor are now integrated."],
  ["Official Presets", "Default launch list uses 1.8.9 Forge and 1.20.1 Fabric presets."],
  ["Install Progress", "Install now shows phased progress with file counts and errors."]
] as const;

const SERVERS = [
  ["FPSMaster Practice", "play.fpsmaster.gg", "PvP"],
  ["SkyArena", "mc.skyarena.net", "Mini Games"],
  ["Builder Hub", "build.fpshub.io", "Creative"]
] as const;

const DEFAULT_SETTINGS: Settings = {
  gameDir: "./.minecraft",
  playerName: "Player",
  maxMemoryMb: 4096,
  hideMainOnLaunch: true
};

const PRESET_INSTANCES: Instance[] = [
  {
    id: "preset-1.8.9-forge",
    name: "FPSMaster 1.8.9 (Forge)",
    versionId: "1.8.9",
    baseVersion: "1.8.9",
    loader: "forge",
    preset: true
  },
  {
    id: "preset-1.20.1-fabric",
    name: "FPSMaster 1.20.1 (Fabric)",
    versionId: "1.20.1",
    baseVersion: "1.20.1",
    loader: "fabric",
    preset: true
  }
];

export function App() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "monitor" ? <Monitor params={params} /> : <Launcher />;
}

function Launcher() {
  const [page, setPage] = useState<Page>("home");
  const [instances, setInstances] = useState<Instance[]>(loadInstances);
  const [selected, setSelected] = useState<string>(localStorage.getItem(S_SEL) ?? PRESET_INSTANCES[0].id);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [busy, setBusy] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [loaderLoading, setLoaderLoading] = useState(false);
  const [status, setStatus] = useState("Ready");

  const [catalog, setCatalog] = useState<string[]>([]);
  const [major, setMajor] = useState("");
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [installVersion, setInstallVersion] = useState("");
  const [loader, setLoader] = useState<Loader>("vanilla");
  const [loaderOptions, setLoaderOptions] = useState<string[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");

  const [installDialog, setInstallDialog] = useState<InstallDialogState | null>(null);

  const logCursorRef = useRef<number | null>(null);
  const pollingRef = useRef(false);
  const loaderRequestRef = useRef(0);
  const lastInstallPageRef = useRef(false);

  const current = useMemo(() => instances.find((x) => x.id === selected) ?? instances[0] ?? null, [instances, selected]);
  const grouped = useMemo(() => groupByMajor(catalog), [catalog]);
  const majors = useMemo(() => Object.keys(grouped).sort((a, b) => compareMajor(b, a)), [grouped]);
  const majorVersions = major ? grouped[major] ?? [] : [];
  const snapshots = useMemo(() => catalog.filter(isSnapshot), [catalog]);
  const installDisabled =
    busy ||
    catalogLoading ||
    !installVersion ||
    (loader !== "vanilla" && (loaderLoading || !loaderVersion));
  const installButtonText = busy
    ? "Installing..."
    : catalogLoading
      ? "Syncing version list..."
      : loader !== "vanilla" && loaderLoading
        ? `Loading ${loader} versions...`
        : "Install Selected Version";

  useEffect(() => {
    localStorage.setItem(S_INST, JSON.stringify(instances));
  }, [instances]);

  useEffect(() => {
    localStorage.setItem(S_SET, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (current) localStorage.setItem(S_SEL, current.id);
  }, [current]);

  useEffect(() => {
    const inInstall = page === "install";
    if (inInstall && !lastInstallPageRef.current) {
      void refreshCatalog();
    }
    lastInstallPageRef.current = inInstall;
  }, [page]);

  useEffect(() => {
    if (catalog.length === 0) return;
    const nextVersion = resolveInstallVersion(catalog, grouped, major, showSnapshots, installVersion);
    if (nextVersion !== installVersion) {
      setInstallVersion(nextVersion);
    }
  }, [catalog, grouped, major, showSnapshots, installVersion]);

  useEffect(() => {
    loaderRequestRef.current += 1;
    setLoaderOptions([]);
    setLoaderVersion("");
    if (page !== "install" || loader === "vanilla" || !installVersion) {
      setLoaderLoading(false);
      return;
    }
    void refreshLoader();
  }, [page, loader, installVersion]);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!active || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const args = logCursorRef.current === null ? {} : { afterSeq: logCursorRef.current };
        const out = await invoke<UiLogPollResult>("poll_ui_logs", args);
        if (!active) return;
        logCursorRef.current = out.nextSeq;
        if (out.entries.length === 0) return;
        for (const entry of out.entries) {
          const ipc = parseInstallIpc(entry.message);
          if (ipc) {
            applyInstallIpc(ipc);
          }
        }
      } catch {
      } finally {
        pollingRef.current = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  function applyInstallIpc(ipc: InstallIpcEvent) {
    setInstallDialog((prev) => {
      if (!prev || !prev.open) return prev;
      if (ipc.channel !== "install") return prev;
      if (ipc.session !== prev.sessionId) return prev;

      const phaseKey =
        ipc.phase === "vanilla"
          ? "vanilla"
          : prev.loaderPhase && ipc.phase === prev.loaderPhase.sourcePhase
            ? "loaderPhase"
            : null;
      if (!phaseKey) return prev;

      const currentPhase = phaseKey === "vanilla" ? prev.vanilla : prev.loaderPhase;
      if (!currentPhase) return prev;

      const nextPhase: InstallPhaseState = {
        ...currentPhase,
        status:
          ipc.event === "error"
            ? "error"
            : ipc.event === "phase-complete"
              ? "done"
              : ipc.event === "phase-start" || ipc.event === "progress"
                ? "running"
                : currentPhase.status,
        stage: ipc.stage ?? currentPhase.stage,
        message: ipc.message ?? currentPhase.message,
        current: typeof ipc.current === "number" ? ipc.current : currentPhase.current,
        total: typeof ipc.total === "number" ? ipc.total : currentPhase.total,
        downloaded: typeof ipc.downloaded === "number" ? ipc.downloaded : currentPhase.downloaded,
        cached: typeof ipc.cached === "number" ? ipc.cached : currentPhase.cached
      };

      let next = {
        ...prev,
        vanilla: phaseKey === "vanilla" ? nextPhase : prev.vanilla,
        loaderPhase: phaseKey === "loaderPhase" ? nextPhase : prev.loaderPhase
      };

      if (ipc.event === "error") {
        next = {
          ...next,
          canClose: true,
          errorText: ipc.error ?? ipc.message ?? "Installation failed"
        };
      }

      return next;
    });
  }

  async function ensureInstanceReadyForLaunch(instance: Instance): Promise<Instance> {
    const needsLoaderProfile = instance.loader !== "vanilla" && instance.versionId === instance.baseVersion;
    if (!needsLoaderProfile) {
      const installed = await invoke<boolean>("is_version_installed", {
        gameDir: settings.gameDir,
        versionId: instance.versionId
      });
      if (installed) {
        return instance;
      }
    }

    setStatus(`Missing ${instance.versionId}, auto installing ${instance.baseVersion} (${instance.loader})...`);
    const sessionId = createSessionId();
    const vanilla = await invoke<InstallResult>("install_vanilla", {
      gameDir: settings.gameDir,
      versionId: instance.baseVersion,
      ipcSession: sessionId
    });

    let nextVersionId = vanilla.versionId;
    let nextLoaderVersion = instance.loaderVersion;

    if (instance.loader === "fabric") {
      if (!nextLoaderVersion) {
        const loaderVersions = await invoke<string[]>("list_fabric_loaders", {
          gameVersion: instance.baseVersion
        });
        nextLoaderVersion = loaderVersions[0] ?? "";
      }
      if (!nextLoaderVersion) {
        throw new Error(`No fabric loader version available for ${instance.baseVersion}`);
      }
      const fabric = await invoke<FabricInstallResult>("install_fabric", {
        gameDir: settings.gameDir,
        gameVersion: instance.baseVersion,
        loaderVersion: nextLoaderVersion,
        ipcSession: sessionId
      });
      nextVersionId = fabric.profileId;
    } else if (instance.loader === "forge") {
      if (!nextLoaderVersion) {
        const forgeVersions = await invoke<string[]>("list_forge_versions", {
          gameVersion: instance.baseVersion
        });
        nextLoaderVersion = forgeVersions[0] ?? "";
      }
      if (!nextLoaderVersion) {
        throw new Error(`No forge version available for ${instance.baseVersion}`);
      }
      const jdk = await ensureJdk(settings.gameDir, instance.baseVersion);
      const forge = await invoke<ForgeInstallResult>("install_forge", {
        gameDir: settings.gameDir,
        forgeVersion: nextLoaderVersion,
        javaPath: jdk.javaPath,
        ipcSession: sessionId
      });
      nextVersionId = forge.profileId;
      nextLoaderVersion = forge.forgeVersion;
    }

    const updatedInstance: Instance = {
      ...instance,
      versionId: nextVersionId,
      loaderVersion: instance.loader === "vanilla" ? undefined : nextLoaderVersion
    };
    setInstances((prev) => prev.map((item) => (item.id === updatedInstance.id ? updatedInstance : item)));
    setStatus(`Auto install completed: ${updatedInstance.name}`);
    return updatedInstance;
  }

  async function launch() {
    if (!current) return;
    setBusy(true);
    setStatus(`Launching ${current.name}...`);
    let launchResult: LaunchExecutionResult | null = null;
    try {
      const prepared = await ensureInstanceReadyForLaunch(current);
      const jdk = await ensureJdk(settings.gameDir, prepared.versionId);
      launchResult = await invoke<LaunchExecutionResult>("launch_vanilla", {
        gameDir: settings.gameDir,
        versionId: prepared.versionId,
        playerName: settings.playerName,
        uuid: "00000000-0000-0000-0000-000000000000",
        accessToken: "offline",
        maxMemoryMb: settings.maxMemoryMb,
        javaPath: jdk.javaPath,
        waitForExit: false
      });
    } catch (e) {
      setStatus(`Launch failed: ${String(e)}`);
      setBusy(false);
      return;
    }

    if (!launchResult) {
      setStatus("Launch failed: missing launch result");
      setBusy(false);
      return;
    }

    try {
      await openMonitor(launchResult.pid, launchResult.versionId, logCursorRef.current ?? 0);
      if (settings.hideMainOnLaunch) {
        await getCurrentWindow().hide();
      }
      setStatus(`Game started pid=${launchResult.pid}`);
    } catch (e) {
      setStatus(`Game started pid=${launchResult.pid}, monitor window failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshCatalog() {
    if (catalogLoading) return;
    setCatalogLoading(true);
    setStatus("Loading versions...");
    try {
      const versions = await invoke<string[]>("list_vanilla_versions");
      const groupedVersions = groupByMajor(versions);
      const majorKeys = Object.keys(groupedVersions).sort((a, b) => compareMajor(b, a));
      const nextMajor = majorKeys.includes(major) ? major : majorKeys[0] ?? "";
      const nextVersion = resolveInstallVersion(versions, groupedVersions, nextMajor, showSnapshots, installVersion);

      setCatalog(versions);
      setMajor(nextMajor);
      setInstallVersion(nextVersion);
      setStatus(`Loaded ${versions.length} versions`);
    } catch (e) {
      setStatus(`Failed: ${String(e)}`);
    } finally {
      setCatalogLoading(false);
    }
  }

  async function refreshLoader() {
    if (!installVersion || loader === "vanilla") return;
    const requestId = loaderRequestRef.current + 1;
    loaderRequestRef.current = requestId;
    setLoaderLoading(true);
    try {
      const versions =
        loader === "fabric"
          ? await invoke<string[]>("list_fabric_loaders", { gameVersion: installVersion })
          : await invoke<string[]>("list_forge_versions", { gameVersion: installVersion });
      if (requestId !== loaderRequestRef.current) return;
      const options = loader === "fabric" ? versions.slice(0, 60) : versions.slice(0, 80);
      setLoaderOptions(options);
      setLoaderVersion(options[0] ?? "");
      setStatus(options.length > 0 ? `Loaded ${options.length} ${loader} versions` : `No ${loader} versions available for ${installVersion}`);
    } catch (e) {
      if (requestId !== loaderRequestRef.current) return;
      setLoaderOptions([]);
      setLoaderVersion("");
      setStatus(`Failed: ${String(e)}`);
    } finally {
      if (requestId === loaderRequestRef.current) {
        setLoaderLoading(false);
      }
    }
  }
  async function install() {
    if (!installVersion) return;
    if (loader !== "vanilla" && !loaderVersion) {
      setStatus(`Select ${loader} version first`);
      return;
    }

    const sessionId = createSessionId();
    const loaderPhase =
      loader === "vanilla"
        ? null
        : createPhaseState(loader === "forge" ? "Forge Install" : "Fabric Install", loader);

    setInstallDialog({
      open: true,
      sessionId,
      versionId: installVersion,
      loader,
      canClose: false,
      errorText: "",
      vanilla: {
        ...createPhaseState("Vanilla Install", "vanilla"),
        status: "running",
        stage: "prepare",
        message: `Preparing ${installVersion}`
      },
      loaderPhase
    });

    setBusy(true);
    setStatus(`Installing ${installVersion}...`);
    try {
      const vanilla = await invoke<InstallResult>("install_vanilla", {
        gameDir: settings.gameDir,
        versionId: installVersion,
        ipcSession: sessionId
      });

      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
          vanilla: {
            ...prev.vanilla,
            status: "done",
            stage: "complete",
            message: "Vanilla install completed"
          }
        };
      });

      let versionId = vanilla.versionId;
      let loaderName: Loader = "vanilla";
      let loaderVer: string | undefined;

      if (loader === "fabric") {
        setInstallDialog((prev) => {
          if (!prev || !prev.loaderPhase) return prev;
          return {
            ...prev,
            loaderPhase: {
              ...prev.loaderPhase,
              status: "running",
              stage: "prepare",
              message: `Installing fabric ${loaderVersion}`
            }
          };
        });

        const result = await invoke<FabricInstallResult>("install_fabric", {
          gameDir: settings.gameDir,
          gameVersion: installVersion,
          loaderVersion,
          ipcSession: sessionId
        });
        versionId = result.profileId;
        loaderName = "fabric";
        loaderVer = loaderVersion;
      }

      if (loader === "forge") {
        setInstallDialog((prev) => {
          if (!prev || !prev.loaderPhase) return prev;
          return {
            ...prev,
            loaderPhase: {
              ...prev.loaderPhase,
              status: "running",
              stage: "prepare",
              message: `Installing forge ${loaderVersion}`
            }
          };
        });

        const jdk = await ensureJdk(settings.gameDir, installVersion);
        const result = await invoke<ForgeInstallResult>("install_forge", {
          gameDir: settings.gameDir,
          forgeVersion: loaderVersion,
          javaPath: jdk.javaPath,
          ipcSession: sessionId
        });
        versionId = result.profileId;
        loaderName = "forge";
        loaderVer = result.forgeVersion;
      }

      const item: Instance = {
        id: `instance-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        name: loaderName === "vanilla" ? `FPSMaster ${installVersion}` : `FPSMaster ${installVersion} (${loaderName})`,
        versionId,
        baseVersion: installVersion,
        loader: loaderName,
        loaderVersion: loaderVer,
        preset: false
      };

      setInstances((prev) => [item, ...prev]);
      setSelected(item.id);
      setPage("instances");
      setStatus(`Installed ${item.name}`);
      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
          canClose: true,
          loaderPhase: prev.loaderPhase
            ? {
                ...prev.loaderPhase,
                status: "done",
                stage: "complete",
                message: "Loader install completed"
              }
            : prev.loaderPhase
        };
      });
    } catch (e) {
      const errorText = String(e);
      setStatus(`Install failed: ${errorText}`);
      setInstallDialog((prev) => {
        if (!prev || prev.sessionId !== sessionId) return prev;
        const loaderRunning = prev.loaderPhase && prev.loaderPhase.status === "running";
        return {
          ...prev,
          canClose: true,
          errorText,
          vanilla:
            prev.vanilla.status === "running"
              ? { ...prev.vanilla, status: "error", stage: "failed", message: errorText }
              : prev.vanilla,
          loaderPhase: loaderRunning
            ? { ...prev.loaderPhase!, status: "error", stage: "failed", message: errorText }
            : prev.loaderPhase
        };
      });
    } finally {
      setBusy(false);
    }
  }

  function removeInstance(id: string) {
    const item = instances.find((x) => x.id === id);
    if (!item) return;
    if (item.preset) {
      setStatus("Preset instances cannot be deleted now");
      return;
    }
    const next = instances.filter((x) => x.id !== id);
    setInstances(next);
    if (selected === id && next.length > 0) setSelected(next[0].id);
  }

  const closeInstallDialog = () => {
    if (!installDialog?.canClose) return;
    setInstallDialog(null);
  };

  return (
    <div className="appWindow">
      <TitleBar title="FPSMaster Launcher" subtitle="Custom Window Chrome" />
      <main className="launcherShell">
      <aside className="launcherSidebar">
        <div className="brandBlock">
          <p className="brandTag">FPSMASTER CLIENT</p>
          <h1>Launcher</h1>
          <p className="brandHint">Official presets: 1.8.9 (Forge), 1.20.1 (Fabric)</p>
        </div>
        <nav className="navList">
          <button className={page === "home" ? "navButton active" : "navButton"} onClick={() => setPage("home")}>Home</button>
          <button className={page === "instances" ? "navButton active" : "navButton"} onClick={() => setPage("instances")}>Instances</button>
          <button className={page === "install" ? "navButton active" : "navButton"} onClick={() => setPage("install")}>Install</button>
          <button className={page === "settings" ? "navButton active" : "navButton"} onClick={() => setPage("settings")}>Settings</button>
        </nav>
        <section className="sidebarStatus"><p className="statusTitle">Status</p><p className="statusLine" title={status}>{status}</p></section>
      </aside>

      <section className="launcherContent">
        {page === "home" && (
          <section className="pageGrid homeGrid">
            <article className="panel launchPanel">
              <div className="panelHead"><h2>Launch FPSMaster</h2><span className="mutedPill">Single-click start</span></div>
              <label>
                Select Instance
                <select value={current?.id ?? ""} onChange={(e) => setSelected(e.target.value)}>
                  {instances.map((x) => (
                    <option key={x.id} value={x.id}>{x.name} [{x.versionId}]</option>
                  ))}
                </select>
              </label>
              {current && (
                <div className="instanceMeta">
                  <p><strong>Game:</strong> {current.baseVersion}</p>
                  <p><strong>Profile:</strong> {current.versionId}</p>
                  <p><strong>Loader:</strong> {current.loader}{current.loaderVersion ? ` (${current.loaderVersion})` : ""}</p>
                </div>
              )}
              <button className="primaryAction" disabled={busy || !current} onClick={launch}>{busy ? "Launching..." : "Launch Game"}</button>
            </article>

            <article className="panel">
              <div className="panelHead"><h2>Latest News</h2></div>
              <div className="stackList">
                {NEWS.map((n) => (
                  <div key={n[0]} className="infoTile"><p className="infoTitle">{n[0]}</p><p className="infoSummary">{n[1]}</p></div>
                ))}
              </div>
            </article>

            <article className="panel">
              <div className="panelHead"><h2>Recommended Servers</h2></div>
              <div className="serverList">
                {SERVERS.map((s) => (
                  <div key={s[1]} className="serverTile"><p className="serverName">{s[0]}</p><p className="serverMeta">{s[2]}</p><p className="serverAddress">{s[1]}</p></div>
                ))}
              </div>
            </article>
          </section>
        )}

        {page === "instances" && (
          <section className="pageGrid instanceGrid">
            <article className="panel">
              <div className="panelHead"><h2>Instance Manager</h2><button className="ghostButton" onClick={() => setPage("install")}>Install New Version</button></div>
              <div className="instanceList">
                {instances.map((x) => (
                  <div key={x.id} className={selected === x.id ? "instanceCard selected" : "instanceCard"}>
                    <div><p className="instanceName">{x.name}</p><p className="instanceSub">{x.versionId}</p><p className="instanceSub">loader: {x.loader}{x.loaderVersion ? ` (${x.loaderVersion})` : ""}</p></div>
                    <div className="instanceActions">
                      <button className="ghostButton" onClick={() => setSelected(x.id)}>Select</button>
                      <button className="ghostButton danger" onClick={() => removeInstance(x.id)} disabled={x.preset}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
            <article className="panel"><div className="panelHead"><h2>Preset Lock</h2></div><p className="minorHint">Preset instances are protected in this phase.</p></article>
          </section>
        )}

        {page === "install" && (
          <section className="pageGrid installGrid">
            <article className="panel">
              <div className="panelHead">
                <h2>Install New Version</h2>
                <span className="mutedPill">{catalogLoading ? "Auto syncing..." : `${catalog.length} versions`}</span>
              </div>
              <p className="stepLabel">Step 1: choose game branch (auto synced when entering this page)</p>
              <div className="majorCardGrid">
                {majors.map((m) => (
                  <button
                    key={m}
                    className={m === major && !showSnapshots ? "majorCard active" : "majorCard"}
                    onClick={() => {
                      setShowSnapshots(false);
                      setMajor(m);
                    }}
                  >
                    <span className="majorTitle">{m}</span>
                    <span className="majorCount">{grouped[m].length} releases</span>
                  </button>
                ))}
                <button className={showSnapshots ? "majorCard active" : "majorCard"} onClick={() => setShowSnapshots((v) => !v)}><span className="majorTitle">Snapshots</span><span className="majorCount">{snapshots.length} versions</span></button>
              </div>
              {!showSnapshots && majorVersions.length > 0 && (
                <div><p className="minorHint">Release versions in {major}</p><div className="chipList">{majorVersions.map((v) => (<button key={v} className={installVersion === v ? "chip active" : "chip"} onClick={() => setInstallVersion(v)}>{v}</button>))}</div></div>
              )}
              {showSnapshots && snapshots.length > 0 && (
                <div><p className="minorHint">Snapshot versions</p><div className="chipList">{snapshots.map((v) => (<button key={v} className={installVersion === v ? "chip active" : "chip"} onClick={() => setInstallVersion(v)}>{v}</button>))}</div></div>
              )}
              {!catalogLoading && !showSnapshots && majorVersions.length === 0 && <p className="minorHint">No release versions in this branch.</p>}
              {!catalogLoading && showSnapshots && snapshots.length === 0 && <p className="minorHint">No snapshots available right now.</p>}
            </article>

            <article className="panel">
              <div className="panelHead">
                <h2>Loader Selection</h2>
                <span className="mutedPill">{loader === "vanilla" ? "No loader needed" : loaderLoading ? `Loading ${loader}...` : `${loaderOptions.length} options`}</span>
              </div>
              <p className="stepLabel">Step 2: choose one loader (versions auto fetched)</p>
              <div className="loaderCards">
                <button className={loader === "vanilla" ? "loaderCard active" : "loaderCard"} onClick={() => setLoader("vanilla")}>Vanilla</button>
                <button className={loader === "forge" ? "loaderCard active" : "loaderCard"} onClick={() => setLoader("forge")}>Forge</button>
                <button className={loader === "fabric" ? "loaderCard active" : "loaderCard"} onClick={() => setLoader("fabric")}>Fabric</button>
              </div>
              {loader !== "vanilla" && (
                <div className="loaderSelector">
                  <p className="minorHint">{loaderLoading ? `Loading ${loader} versions for ${installVersion || "selected version"}...` : `Choose a ${loader} version`}</p>
                  <div className="chipList">{loaderOptions.map((v) => (<button key={v} className={loaderVersion === v ? "chip active" : "chip"} onClick={() => setLoaderVersion(v)}>{v}</button>))}</div>
                  {!loaderLoading && installVersion && loaderOptions.length === 0 && <p className="minorHint">No {loader} versions found for {installVersion}.</p>}
                </div>
              )}
              <p className="stepLabel">Step 3: install and create instance</p>
              <button className="primaryAction" disabled={installDisabled} onClick={install}>{installButtonText}</button>
            </article>
          </section>
        )}

        {page === "settings" && (
          <section className="pageGrid settingsGrid">
            <article className="panel">
              <div className="panelHead"><h2>Launcher Settings</h2></div>
              <label>Game Directory<input value={settings.gameDir} onChange={(e) => setSettings((s) => ({ ...s, gameDir: e.target.value }))} /></label>
              <label>Player Name<input value={settings.playerName} onChange={(e) => setSettings((s) => ({ ...s, playerName: e.target.value }))} /></label>
              <label>Max Memory (MB)<input type="number" min={1024} max={16384} step={256} value={settings.maxMemoryMb} onChange={(e) => setSettings((s) => { const next = Number.parseInt(e.target.value, 10); return { ...s, maxMemoryMb: Number.isFinite(next) ? clamp(next, 1024, 16384) : s.maxMemoryMb }; })} /></label>
              <label className="toggleField"><input type="checkbox" checked={settings.hideMainOnLaunch} onChange={(e) => setSettings((s) => ({ ...s, hideMainOnLaunch: e.target.checked }))} />Hide launcher window after start</label>
              <button className="ghostButton" onClick={() => setSettings(DEFAULT_SETTINGS)}>Reset Settings</button>
            </article>
          </section>
        )}
      </section>

      {installDialog && installDialog.open && (
        <section className="modalOverlay">
          <div className="modalCard">
            <div className="panelHead">
              <h2>Installing {installDialog.versionId}</h2>
              <span className="mutedPill">Session {installDialog.sessionId.slice(-6)}</span>
            </div>
            <p className="minorHint">Installation is split into staged phases and tracked through java-core IPC log stream.</p>
            <InstallPhaseView phase={installDialog.vanilla} />
            {installDialog.loaderPhase && <InstallPhaseView phase={installDialog.loaderPhase} />}
            {installDialog.errorText !== "" && <pre className="errorBox">{installDialog.errorText}</pre>}
            <div className="modalActions">
              <button className="primaryAction" disabled={!installDialog.canClose} onClick={closeInstallDialog}>Confirm</button>
            </div>
          </div>
        </section>
      )}
      </main>
    </div>
  );
}

function TitleBar({ title, subtitle }: { title: string; subtitle?: string }) {
  const [busy, setBusy] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let active = true;
    const win = getCurrentWindow();
    const syncMaximizedState = async () => {
      try {
        const maximized = await win.isMaximized();
        if (active) {
          setIsMaximized(maximized);
        }
      } catch {
      }
    };

    void syncMaximizedState();
    const unlisten = win.onResized(() => {
      void syncMaximizedState();
    });
    return () => {
      active = false;
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  const withGuard = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      console.error("Title bar action failed", error);
    } finally {
      setBusy(false);
    }
  };

  const startDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    void withGuard(() => getCurrentWindow().startDragging());
  };

  const toggleMaximize = () =>
    withGuard(async () => {
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setIsMaximized(await win.isMaximized());
    });

  return (
    <header className="customTitlebar">
      <div className="titleMain">
        <div
          className="titleDragRegion"
          data-tauri-drag-region
          onMouseDown={startDrag}
          onDoubleClick={() => void toggleMaximize()}
        >
          <p className="titleText">{title}</p>
          <p className="titleSubtext">{subtitle ?? ""}</p>
        </div>
      </div>
      <div className="titleControls">
        <button
          className="titleBtn"
          type="button"
          onClick={() => withGuard(() => getCurrentWindow().minimize())}
          aria-label="Minimize"
        >
          <WindowControlIcon kind="minimize" />
        </button>
        <button
          className="titleBtn"
          type="button"
          onClick={() => void toggleMaximize()}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          <WindowControlIcon kind="maximize" maximized={isMaximized} />
        </button>
        <button
          className="titleBtn danger"
          type="button"
          onClick={() => withGuard(() => getCurrentWindow().close())}
          aria-label="Close"
        >
          <WindowControlIcon kind="close" />
        </button>
      </div>
    </header>
  );
}

function WindowControlIcon({ kind, maximized = false }: { kind: "minimize" | "maximize" | "close"; maximized?: boolean }) {
  if (kind === "minimize") {
    return (
      <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 9h8" />
      </svg>
    );
  }
  if (kind === "close") {
    return (
      <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />
      </svg>
    );
  }
  if (maximized) {
    return (
      <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 4.5h5v5h-5z" />
        <path d="M4.5 2.5h5v5" />
        <path d="M7.5 2.5h2v2" />
      </svg>
    );
  }
  return (
    <svg className="titleBtnIcon" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M2.5 2.5h7v7h-7z" />
    </svg>
  );
}

function InstallPhaseView({ phase }: { phase: InstallPhaseState }) {
  const percent = phase.total > 0 ? Math.min(100, Math.floor((phase.current / phase.total) * 100)) : phase.status === "done" ? 100 : 0;
  return (
    <article className="installPhaseCard">
      <div className="phaseHeadRow">
        <p className="phaseTitle">{phase.title}</p>
        <p className={`phaseStatus ${phase.status}`}>{phase.status}</p>
      </div>
      <p className="phaseMeta">stage: {phase.stage || "-"}</p>
      <p className="phaseMeta">{phase.message || "waiting..."}</p>
      <div className="progressTrack"><div className="progressFill" style={{ width: `${percent}%` }} /></div>
      <p className="phaseMeta">progress: {phase.current}/{phase.total || "?"} downloaded={phase.downloaded} cached={phase.cached}</p>
    </article>
  );
}
function Monitor({ params }: { params: URLSearchParams }) {
  const pid = parseIntSafe(params.get("pid"), 0);
  const startedAt = parseIntSafe(params.get("startedAt"), Date.now());
  const initialCursor = parseIntSafe(params.get("cursor"), 0);
  const version = params.get("version") ?? "unknown";

  const [logs, setLogs] = useState<string[]>([]);
  const [stats, setStats] = useState<GameRuntimeStats | null>(null);
  const [status, setStatus] = useState("Connecting runtime stream...");
  const [tick, setTick] = useState(Date.now());

  const cursorRef = useRef<number | null>(initialCursor > 0 ? initialCursor : null);
  const pollingRef = useRef(false);

  useEffect(() => {
    let active = true;
    const pollLogs = async () => {
      if (!active || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const args = cursorRef.current === null ? {} : { afterSeq: cursorRef.current };
        const out = await invoke<UiLogPollResult>("poll_ui_logs", args);
        if (!active) return;
        cursorRef.current = out.nextSeq;
        if (out.entries.length === 0) return;
        setLogs((prev) => {
          const next = [...prev, ...out.entries.map((e) => `${prefix(e)} ${e.message}`)];
          return next.length > 4000 ? next.slice(next.length - 4000) : next;
        });
      } catch {
      } finally {
        pollingRef.current = false;
      }
    };

    const pollRuntime = async () => {
      if (pid <= 0) {
        setStatus("Invalid pid");
        return;
      }
      try {
        const out = await invoke<GameRuntimeStats>("poll_game_runtime", { pid });
        if (!active) return;
        setStats(out);
        setStatus(out.running ? "Game process is running" : "Game process exited");
      } catch (e) {
        if (!active) return;
        setStatus(`Runtime polling failed: ${String(e)}`);
      }
    };

    void pollLogs();
    void pollRuntime();
    const l = window.setInterval(() => void pollLogs(), 200);
    const r = window.setInterval(() => {
      void pollRuntime();
      setTick(Date.now());
    }, 1000);

    return () => {
      active = false;
      window.clearInterval(l);
      window.clearInterval(r);
    };
  }, [pid]);

  const uptime = formatDuration(stats?.elapsedMs ?? Math.max(0, tick - startedAt));
  const memory = stats?.memoryMb === null || stats?.memoryMb === undefined ? "N/A" : `${stats.memoryMb} MB`;

  async function backToLauncher() {
    await invoke("show_main_window");
    await getCurrentWindow().close();
  }

  return (
    <div className="appWindow monitorWindow">
      <TitleBar title={`FPSMaster Runtime ${version}`} subtitle="Game Monitor" />
      <main className="monitorShell">
      <section className="monitorTopBar">
        <div className="monitorTitle"><p className="brandTag">RUNTIME MONITOR</p><h1>FPSMaster {version}</h1></div>
        <div className="monitorActions"><button className="ghostButton" onClick={() => setLogs([])}>Clear Logs</button><button className="primaryAction" onClick={backToLauncher}>Back to Launcher</button></div>
      </section>
      <section className="monitorStats">
        <div className="statCard"><p className="statLabel">PID</p><p className="statValue">{pid > 0 ? pid : "N/A"}</p></div>
        <div className="statCard"><p className="statLabel">Status</p><p className="statValue">{stats?.running ? "Running" : "Exited"}</p></div>
        <div className="statCard"><p className="statLabel">Memory</p><p className="statValue">{memory}</p></div>
        <div className="statCard"><p className="statLabel">Uptime</p><p className="statValue">{uptime}</p></div>
      </section>
      <section className="panel monitorLogPanel">
        <div className="panelHead"><h2>Game Console Output</h2><span className="mutedPill">{status}</span></div>
        <pre className="logBox monitorLogBox">{logs.join("\n")}</pre>
      </section>
      </main>
    </div>
  );
}

async function ensureJdk(gameDir: string, versionId: string): Promise<JdkEnsureResult> {
  return invoke<JdkEnsureResult>("ensure_jdk", { gameDir, versionId });
}

async function openMonitor(pid: number, versionId: string, cursor: number) {
  const params = new URLSearchParams({
    view: "monitor",
    pid: String(pid),
    version: versionId,
    startedAt: String(Date.now()),
    cursor: String(cursor)
  });

  const monitorLabel = `runtime-monitor-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const win = new WebviewWindow(monitorLabel, {
    title: `FPSMaster Runtime - ${versionId}`,
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    decorations: false,
    url: `/?${params.toString()}`
  });

  await new Promise<void>((resolve, reject) => {
    void win.once("tauri://created", () => resolve());
    void win.once("tauri://error", (event) => {
      reject(new Error(String((event as { payload?: unknown }).payload ?? "create monitor failed")));
    });
  });
}

function createPhaseState(title: string, sourcePhase: "vanilla" | "forge" | "fabric"): InstallPhaseState {
  return {
    title,
    sourcePhase,
    status: "pending",
    stage: "",
    message: "Waiting...",
    current: 0,
    total: 0,
    downloaded: 0,
    cached: 0
  };
}

function parseInstallIpc(message: string): InstallIpcEvent | null {
  if (!message.startsWith("[ipc]")) {
    return null;
  }
  const jsonText = message.slice("[ipc]".length).trim();
  if (jsonText === "") {
    return null;
  }
  try {
    return JSON.parse(jsonText) as InstallIpcEvent;
  } catch {
    return null;
  }
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function loadInstances(): Instance[] {
  try {
    const raw = localStorage.getItem(S_INST);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Instance[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaults();
    return withPresetInstances(parsed);
  } catch {
    return defaults();
  }
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(S_SET);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      gameDir: typeof parsed.gameDir === "string" && parsed.gameDir ? parsed.gameDir : DEFAULT_SETTINGS.gameDir,
      playerName: typeof parsed.playerName === "string" && parsed.playerName ? parsed.playerName : DEFAULT_SETTINGS.playerName,
      maxMemoryMb: typeof parsed.maxMemoryMb === "number" ? clamp(parsed.maxMemoryMb, 1024, 16384) : DEFAULT_SETTINGS.maxMemoryMb,
      hideMainOnLaunch: typeof parsed.hideMainOnLaunch === "boolean" ? parsed.hideMainOnLaunch : DEFAULT_SETTINGS.hideMainOnLaunch
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function defaults(): Instance[] {
  return PRESET_INSTANCES.map((item) => ({ ...item }));
}

function withPresetInstances(instances: Instance[]): Instance[] {
  const byId = new Map(instances.map((item) => [item.id, item]));
  const presets = PRESET_INSTANCES.map((preset) => {
    const saved = byId.get(preset.id);
    if (!saved) {
      return { ...preset };
    }
    return {
      ...preset,
      versionId: saved.versionId || preset.versionId,
      loaderVersion: saved.loaderVersion
    };
  });
  const custom = instances.filter((item) => !item.id.startsWith("preset-"));
  return [...presets, ...custom];
}

function resolveInstallVersion(
  catalog: string[],
  grouped: Record<string, string[]>,
  major: string,
  showSnapshots: boolean,
  current: string
): string {
  const snapshotVersions = catalog.filter(isSnapshot);
  if (showSnapshots) {
    return snapshotVersions.includes(current) ? current : (snapshotVersions[0] ?? "");
  }

  const currentMajorVersions = major ? grouped[major] ?? [] : [];
  if (currentMajorVersions.length > 0) {
    return currentMajorVersions.includes(current) ? current : currentMajorVersions[0];
  }

  const firstMajor = Object.keys(grouped).sort((a, b) => compareMajor(b, a))[0];
  const fallbackVersions = firstMajor ? grouped[firstMajor] ?? [] : [];
  return fallbackVersions.includes(current) ? current : (fallbackVersions[0] ?? "");
}

function groupByMajor(versions: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const v of versions) {
    if (isSnapshot(v)) continue;
    const m = majorOf(v);
    if (!m) continue;
    out[m] = out[m] ?? [];
    out[m].push(v);
  }
  for (const m of Object.keys(out)) out[m].sort((a, b) => compareRelease(b, a));
  return out;
}

function majorOf(version: string): string {
  const match = version.match(/^(\d+\.\d+)/);
  return match ? match[1] : "";
}

function isSnapshot(version: string): boolean {
  return !/^\d+\.\d+(?:\.\d+)?$/.test(version);
}

function compareRelease(a: string, b: string): number {
  const left = a.split(".").map((x) => Number.parseInt(x, 10));
  const right = b.split(".").map((x) => Number.parseInt(x, 10));
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    if (l !== r) return l - r;
  }
  return 0;
}

function compareMajor(a: string, b: string): number {
  return compareRelease(a, b);
}

function prefix(entry: UiLogEntry): string {
  if (entry.source === "game") return entry.level === "stderr" ? "[game-err]" : "[game]";
  return entry.level === "stderr" ? "[core-err]" : "[core]";
}

function parseIntSafe(input: string | null, fallback: number): number {
  if (input === null) return fallback;
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s` : `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
