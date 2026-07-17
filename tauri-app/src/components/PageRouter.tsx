import { lazy } from "react";
import HomePage from "../pages/Home";
import type {
  DownloadedLauncherUpdate,
  Instance,
  LauncherAppUpdateChannel,
  LauncherAppUpdateInfo,
  LauncherDashboard,
  LauncherUser,
  LauncherVersion,
  LauncherVersionMap,
  Loader,
  MinecraftAccount,
  NewsItem,
  OptiFineVersion,
  Page,
  PresetPackageStatus,
  ServerItem,
  Settings,
  TelemetryOnlineSummary
} from "../types";

const InstanceSettingsPage = lazy(() => import("../pages/InstanceSettings"));
const InstallPage = lazy(() => import("../pages/Install"));
const InstancesPage = lazy(() => import("../pages/Instances"));
const ServersPage = lazy(() => import("../pages/Servers"));
const ContentPage = lazy(() => import("../pages/Content"));
const MandatoryUpdatePage = lazy(() => import("../pages/MandatoryUpdate"));
const AccountCenterPage = lazy(() => import("../pages/AccountCenter"));
const SettingsPage = lazy(() => import("../pages/Settings"));

// Everything the page tree needs, assembled by the Launcher. Grouped loosely
// by domain so it maps cleanly onto the domain hooks that feed it.
export type PageRouterContext = {
  page: Page;
  // shared / instances
  instances: Instance[];
  current: Instance | null;
  busy: boolean;
  user: LauncherUser | null;
  settings: Settings;
  launcherVersions: LauncherVersionMap;
  // Nova's selectable Minecraft game versions (keyed by MC version) and the current pick.
  novaGameVersions: Record<string, LauncherVersion>;
  selectedNovaGameVersion: string;
  onSelectNovaGameVersion: (gameVersion: string) => void;
  presetPackageStatuses: Record<string, PresetPackageStatus>;
  onSelect: (id: string) => void;
  onRemoveInstance: (id: string) => void;
  onLaunchInstance: (id: string) => void;
  onOpenInstanceSettings: (id: string) => void;
  onInstanceRepair: () => void;
  onInstanceDelete: () => void;
  onInstanceDuplicate: () => void;
  onInstanceExport: () => void;
  // launcher data
  launcherNews: NewsItem[];
  launcherServers: ServerItem[];
  launcherOnlineSummary: TelemetryOnlineSummary | null;
  launcherDashboard: LauncherDashboard | null;
  currentLauncherVersion: string;
  onRefreshServers: () => void;
  // game launch
  launching: boolean;
  launchingInstanceId: string | null;
  launchProgressPercent: number | null;
  launchProgressText: string;
  onLaunch: () => void;
  onLaunchToServer: (serverAddress: string) => void;
  // minecraft accounts
  minecraftAccounts: MinecraftAccount[];
  currentMinecraftAccount: MinecraftAccount | null;
  onSelectMinecraftAccount: (id: string | null) => void;
  onAddOfflineMinecraftAccount: (username: string) => void;
  onSaveMinecraftAccount: (account: MinecraftAccount) => void;
  onDeleteMinecraftAccount: (accountId: string) => void;
  // launcher self-update
  launcherUpdate: LauncherAppUpdateInfo | null;
  launcherUpdateAvailable: boolean;
  launcherUpdateChannels: LauncherAppUpdateChannel[];
  launcherUpdateChecking: boolean;
  launcherUpdateDownloading: boolean;
  launcherUpdateDownload: DownloadedLauncherUpdate | null;
  onRefreshLauncherUpdate: () => void;
  onInstallLauncherUpdate: () => void;
  // install wizard
  catalogLoading: boolean;
  catalogCount: number;
  majors: string[];
  major: string;
  grouped: Record<string, string[]>;
  showSnapshots: boolean;
  snapshots: string[];
  majorVersions: string[];
  installVersion: string;
  loader: Loader;
  loaderLoading: boolean;
  loaderOptions: string[];
  loaderVersion: string;
  optiFineEnabled: boolean;
  optiFineLoading: boolean;
  optiFineOptions: OptiFineVersion[];
  optiFineVersion: string;
  optiFineDisabledReason: string;
  installedVersions: string[];
  installDisabled: boolean;
  installButtonText: string;
  onSelectMajor: (major: string) => void;
  onToggleSnapshots: () => void;
  onSelectInstallVersion: (version: string) => void;
  onSelectLoader: (loader: Loader) => void;
  onSelectLoaderVersion: (version: string) => void;
  onToggleOptiFine: () => void;
  onSelectOptiFineVersion: (version: string) => void;
  onInstall: () => void;
  // navigation + settings
  gameDir: string;
  curseforgeApiKey: string;
  onStatusChange: (status: string) => void;
  onGoInstall: () => void;
  onGoInstances: () => void;
  onGoSettings: () => void;
  onGoServers: () => void;
  onLogoutLauncherAccount: () => void;
  onChangeSettings: (next: Settings) => void;
  onClampMemory: (input: string) => void;
  onResetSettings: () => void;
};

export default function PageRouter({ ctx }: { ctx: PageRouterContext }) {
  switch (ctx.page) {
    case "home":
      return (
        <HomePage
          availableInstances={ctx.instances}
          launcherNews={ctx.launcherNews}
          launcherServers={ctx.launcherServers}
          launcherOnlineSummary={ctx.launcherOnlineSummary}
          launcherDashboard={ctx.launcherDashboard}
          launcherUpdate={ctx.launcherUpdate}
          launcherUpdateAvailable={ctx.launcherUpdateAvailable}
          launcherUpdateDownloading={ctx.launcherUpdateDownloading}
          launcherUpdateDownload={ctx.launcherUpdateDownload}
          current={ctx.current}
          busy={ctx.busy}
          launching={ctx.launching}
          launchProgressPercent={ctx.launchProgressPercent}
          launchProgressText={ctx.launchProgressText}
          user={ctx.user}
          novaGameVersions={ctx.novaGameVersions}
          selectedNovaGameVersion={ctx.selectedNovaGameVersion}
          onSelectNovaGameVersion={ctx.onSelectNovaGameVersion}
          minecraftAccounts={ctx.minecraftAccounts}
          currentMinecraftAccount={ctx.currentMinecraftAccount}
          onSelect={ctx.onSelect}
          onLaunch={ctx.onLaunch}
          onLaunchToServer={ctx.onLaunchToServer}
          onOpenSettings={ctx.onGoSettings}
          onOpenServers={ctx.onGoServers}
          onSelectMinecraftAccount={ctx.onSelectMinecraftAccount}
          onAddOfflineMinecraftAccount={ctx.onAddOfflineMinecraftAccount}
          onSaveMicrosoftMinecraftAccount={ctx.onSaveMinecraftAccount}
          onDeleteMinecraftAccount={ctx.onDeleteMinecraftAccount}
        />
      );
    case "servers":
      return (
        <ServersPage
          servers={ctx.launcherServers}
          currentInstance={ctx.current}
          busy={ctx.busy}
          launching={ctx.launching}
          launchProgressPercent={ctx.launchProgressPercent}
          launchProgressText={ctx.launchProgressText}
          user={ctx.user}
          onLaunch={ctx.onLaunchToServer}
          onRefreshServers={ctx.onRefreshServers}
        />
      );
    case "account-center":
      return <AccountCenterPage launcherDashboard={ctx.launcherDashboard} />;
    case "instances":
      return (
        <InstancesPage
          instances={ctx.instances}
          launcherVersions={ctx.launcherVersions}
          busy={ctx.busy}
          launchingInstanceId={ctx.launchingInstanceId}
          launchProgressPercent={ctx.launchProgressPercent}
          launchProgressText={ctx.launchProgressText}
          user={ctx.user}
          presetPackageStatuses={ctx.presetPackageStatuses}
          onDelete={ctx.onRemoveInstance}
          onGoInstall={ctx.onGoInstall}
          onLaunchInstance={ctx.onLaunchInstance}
          onOpenInstanceSettings={ctx.onOpenInstanceSettings}
        />
      );
    case "instance-settings":
      return (
        <InstanceSettingsPage
          instance={ctx.current}
          gameDir={ctx.gameDir}
          busy={ctx.busy}
          onBack={ctx.onGoInstances}
          onRepair={ctx.onInstanceRepair}
          onDelete={ctx.onInstanceDelete}
          onDuplicate={ctx.onInstanceDuplicate}
          onExport={ctx.onInstanceExport}
        />
      );
    case "install":
      return (
        <InstallPage
          catalogLoading={ctx.catalogLoading}
          catalogCount={ctx.catalogCount}
          majors={ctx.majors}
          major={ctx.major}
          grouped={ctx.grouped}
          showSnapshots={ctx.showSnapshots}
          snapshots={ctx.snapshots}
          majorVersions={ctx.majorVersions}
          installVersion={ctx.installVersion}
          loader={ctx.loader}
          loaderLoading={ctx.loaderLoading}
          loaderOptions={ctx.loaderOptions}
          loaderVersion={ctx.loaderVersion}
          optiFineEnabled={ctx.optiFineEnabled}
          optiFineLoading={ctx.optiFineLoading}
          optiFineOptions={ctx.optiFineOptions}
          optiFineVersion={ctx.optiFineVersion}
          optiFineDisabledReason={ctx.optiFineDisabledReason}
          installedVersions={ctx.installedVersions}
          installDisabled={ctx.installDisabled}
          installButtonText={ctx.installButtonText}
          onSelectMajor={ctx.onSelectMajor}
          onToggleSnapshots={ctx.onToggleSnapshots}
          onSelectInstallVersion={ctx.onSelectInstallVersion}
          onSelectLoader={ctx.onSelectLoader}
          onSelectLoaderVersion={ctx.onSelectLoaderVersion}
          onToggleOptiFine={ctx.onToggleOptiFine}
          onSelectOptiFineVersion={ctx.onSelectOptiFineVersion}
          onInstall={ctx.onInstall}
        />
      );
    case "content":
      return (
        <ContentPage
          instances={ctx.instances}
          current={ctx.current}
          gameDir={ctx.gameDir}
          curseforgeApiKey={ctx.curseforgeApiKey}
          busy={ctx.busy}
          onSelectInstance={ctx.onSelect}
          onStatusChange={ctx.onStatusChange}
        />
      );
    case "mandatory-update":
      return (
        <MandatoryUpdatePage
          launcherUpdate={ctx.launcherUpdate}
          launcherUpdateDownloading={ctx.launcherUpdateDownloading}
          launcherUpdateDownload={ctx.launcherUpdateDownload}
          onInstallLauncherUpdate={ctx.onInstallLauncherUpdate}
        />
      );
    default:
      return (
        <SettingsPage
          settings={ctx.settings}
          launcherCurrentVersion={ctx.currentLauncherVersion}
          launcherUpdate={ctx.launcherUpdate}
          launcherUpdateChannels={ctx.launcherUpdateChannels}
          launcherUpdateAvailable={ctx.launcherUpdateAvailable}
          launcherUpdateChecking={ctx.launcherUpdateChecking}
          launcherUpdateDownloading={ctx.launcherUpdateDownloading}
          launcherUpdateDownload={ctx.launcherUpdateDownload}
          launcherUser={ctx.user}
          onLogoutLauncherAccount={ctx.onLogoutLauncherAccount}
          onRefreshLauncherUpdate={ctx.onRefreshLauncherUpdate}
          onInstallLauncherUpdate={ctx.onInstallLauncherUpdate}
          onChange={ctx.onChangeSettings}
          onClampMemory={ctx.onClampMemory}
          onReset={ctx.onResetSettings}
        />
      );
  }
}
