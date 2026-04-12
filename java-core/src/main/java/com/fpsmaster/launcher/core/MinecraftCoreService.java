package com.fpsmaster.launcher.core;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.io.RandomAccessFile;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class MinecraftCoreService {
    private static final int DOWNLOAD_RETRY_ATTEMPTS = 3;

    private final HttpClient httpClient;
    private final Gson gson;

    public MinecraftCoreService() {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(30))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        this.gson = new Gson();
    }

    public List<String> listVanillaVersions() throws IOException, InterruptedException {
        return listVanillaVersions(DownloadSource.OFFICIAL);
    }

    public List<String> listVanillaVersions(DownloadSource downloadSource) throws IOException, InterruptedException {
        JsonObject manifest = getJson(downloadSource.versionManifestUrl());
        JsonArray versions = manifest.getAsJsonArray("versions");
        List<String> result = new ArrayList<>();
        for (JsonElement versionElement : versions) {
            result.add(versionElement.getAsJsonObject().get("id").getAsString());
        }
        return result;
    }

    public JavaRuntimeRequirement resolveJavaRuntimeRequirement(String versionId) throws IOException, InterruptedException {
        return resolveJavaRuntimeRequirement(null, versionId, DownloadSource.OFFICIAL);
    }

    public JavaRuntimeRequirement resolveJavaRuntimeRequirement(Path gameDirectory, String versionId) throws IOException, InterruptedException {
        return resolveJavaRuntimeRequirement(gameDirectory, versionId, DownloadSource.OFFICIAL);
    }

    public JavaRuntimeRequirement resolveJavaRuntimeRequirement(Path gameDirectory, String versionId, DownloadSource downloadSource) throws IOException, InterruptedException {
        if (gameDirectory != null) {
            Path gameDir = gameDirectory.toAbsolutePath().normalize();
            Path localVersionJson = gameDir.resolve("versions").resolve(versionId).resolve(versionId + ".json");
            if (Files.isRegularFile(localVersionJson)) {
                ResolvedVersionDescriptor descriptor = resolveVersionDescriptor(gameDir, versionId, 0);
                JsonObject merged = descriptor.merged();

                int majorVersion = 8;
                String component = "jre-legacy";
                if (merged.has("javaVersion")) {
                    JsonObject javaVersion = merged.getAsJsonObject("javaVersion");
                    if (javaVersion.has("majorVersion")) {
                        majorVersion = javaVersion.get("majorVersion").getAsInt();
                    }
                    if (javaVersion.has("component")) {
                        component = javaVersion.get("component").getAsString();
                    }
                }
                return new JavaRuntimeRequirement(versionId, majorVersion, component);
            }
        }

        JsonObject versionInfo = findVersionFromManifest(versionId, downloadSource);
        JsonObject versionJson = getJson(downloadSource.rewriteUrl(versionInfo.get("url").getAsString()));

        int majorVersion = 8;
        String component = "jre-legacy";
        if (versionJson.has("javaVersion")) {
            JsonObject javaVersion = versionJson.getAsJsonObject("javaVersion");
            if (javaVersion.has("majorVersion")) {
                majorVersion = javaVersion.get("majorVersion").getAsInt();
            }
            if (javaVersion.has("component")) {
                component = javaVersion.get("component").getAsString();
            }
        }

        return new JavaRuntimeRequirement(versionId, majorVersion, component);
    }

    public InstallResult installVanilla(Path gameDirectory, String versionId) throws IOException, InterruptedException {
        return installVanilla(gameDirectory, versionId, DownloadSource.OFFICIAL);
    }

    public InstallResult installVanilla(Path gameDirectory, String versionId, DownloadSource downloadSource) throws IOException, InterruptedException {
        Path normalizedGameDir = gameDirectory.toAbsolutePath().normalize();
        Files.createDirectories(normalizedGameDir);
        IpcLogBridge.installPhaseStart("vanilla", "prepare", "Prepare install for version=" + versionId);
        logProgress("vanilla", "Prepare install for version=" + versionId);

        JsonObject versionInfo = findVersionFromManifest(versionId, downloadSource);
        String versionJsonUrl = downloadSource.rewriteUrl(versionInfo.get("url").getAsString());

        JsonObject versionJson = getJson(versionJsonUrl);
        Path versionDir = normalizedGameDir.resolve("versions").resolve(versionId);
        Files.createDirectories(versionDir);

        Path versionJsonPath = versionDir.resolve(versionId + ".json");
        writeJson(versionJsonPath, versionJson);

        IpcLogBridge.installPhaseStart("vanilla", "client", "Download client jar");
        logProgress("vanilla", "Download client jar");
        downloadClient(versionJson, versionDir, versionId, "vanilla", downloadSource);

        IpcLogBridge.installPhaseStart("vanilla", "libraries", "Download libraries");
        logProgress("vanilla", "Download libraries");
        List<Path> downloadedLibraries = downloadLibraries(versionJson, normalizedGameDir, versionId, "vanilla", downloadSource);

        IpcLogBridge.installPhaseStart("vanilla", "assets", "Download assets");
        logProgress("vanilla", "Download assets");
        int assetsCount = downloadAssets(versionJson, normalizedGameDir, versionId, "vanilla", downloadSource);

        logProgress("vanilla", "Install completed version=" + versionId
                + " libraries=" + downloadedLibraries.size() + " assets=" + assetsCount);
        IpcLogBridge.installPhaseComplete(
                "vanilla",
                "complete",
                "Install completed version=" + versionId
                        + " libraries=" + downloadedLibraries.size()
                        + " assets=" + assetsCount
        );

        return new InstallResult(versionId, versionJsonPath, downloadedLibraries.size(), assetsCount);
    }

    public LaunchPlan buildVanillaLaunchPlan(LaunchRequest request) throws IOException {
        return buildVanillaLaunchPlan(request, DownloadSource.OFFICIAL);
    }

    public LaunchPlan buildVanillaLaunchPlan(LaunchRequest request, DownloadSource downloadSource) throws IOException {
        Path gameDir = request.gameDirectory().toAbsolutePath().normalize();
        String versionId = request.versionId();
        ResolvedVersionDescriptor descriptor = resolveVersionDescriptor(gameDir, versionId, 0);
        JsonObject versionJson = descriptor.merged();
        Map<String, Boolean> ruleFeatures = buildRuleFeatures();

        Path versionDir = gameDir.resolve("versions").resolve(versionId);

        Path nativesBaseDir = versionDir.resolve("natives");
        Files.createDirectories(nativesBaseDir);
        Path nativesDir = Files.createTempDirectory(nativesBaseDir, "run-");

        List<Path> classPathEntries = new ArrayList<>();
        for (ResolvedLibrary library : resolveLibraries(versionJson, gameDir, versionId, ruleFeatures, downloadSource)) {
            ensureLibraryDownloaded(library);
            if (library.classpathEntry()) {
                classPathEntries.add(library.path());
            }
            if (library.nativeEntry()) {
                extractNativeJar(library.path(), nativesDir);
            }
        }

        String jarVersionId = descriptor.jarVersionId();
        Path clientJar = gameDir.resolve("versions").resolve(jarVersionId).resolve(jarVersionId + ".jar");
        ensureClientJarDownloaded(versionJson, clientJar, downloadSource);
        classPathEntries.add(clientJar);

        String classpath = classPathEntries.stream()
                .map(path -> path.toAbsolutePath().toString())
                .sorted(Comparator.naturalOrder())
                .reduce((a, b) -> a + OsUtils.classPathSeparator() + b)
                .orElse("");

        Map<String, String> variables = buildVariables(request, versionJson, gameDir, nativesDir, classpath);

        List<String> jvmArgs = new ArrayList<>();
        jvmArgs.add(request.javaExecutable().toAbsolutePath().toString());
        jvmArgs.add("-Xmx" + request.maxMemoryMb() + "M");
        jvmArgs.add("-Djava.library.path=" + nativesDir.toAbsolutePath());

        // Pass FPSMaster auth token via system property for client-side authentication
        if (request.fpsAuthToken() != null && !request.fpsAuthToken().isEmpty()) {
            jvmArgs.add("-Dfpsmaster.auth.token=" + request.fpsAuthToken());
        }

        if (versionJson.has("arguments") && versionJson.getAsJsonObject("arguments").has("jvm")) {
            jvmArgs.addAll(resolveArgumentArray(
                    versionJson.getAsJsonObject("arguments").getAsJsonArray("jvm"),
                    variables,
                    ruleFeatures
            ));
        }
        jvmArgs = normalizeJvmArguments(jvmArgs);

        String mainClass = versionJson.get("mainClass").getAsString();
        List<String> gameArgs = new ArrayList<>();
        if (versionJson.has("arguments") && versionJson.getAsJsonObject("arguments").has("game")) {
            gameArgs.addAll(resolveArgumentArray(
                    versionJson.getAsJsonObject("arguments").getAsJsonArray("game"),
                    variables,
                    ruleFeatures
            ));
        } else if (versionJson.has("minecraftArguments")) {
            for (String token : versionJson.get("minecraftArguments").getAsString().split(" ")) {
                if (!token.isBlank()) {
                    gameArgs.add(replaceVariables(token, variables));
                }
            }
        }

        // Add --server parameter if serverAddress is provided
        if (request.serverAddress() != null && !request.serverAddress().isBlank()) {
            gameArgs.add("--server");
            gameArgs.add(request.serverAddress());
        }

        List<String> fullCommand = new ArrayList<>(jvmArgs);
        if (!containsClasspathArg(jvmArgs)) {
            fullCommand.add("-cp");
            fullCommand.add(classpath);
        }
        fullCommand.add(mainClass);
        fullCommand.addAll(gameArgs);

        return new LaunchPlan(fullCommand, classpath, mainClass, nativesDir);
    }

    public LaunchExecutionResult launchVanilla(LaunchRequest request, boolean waitForExit) throws IOException, InterruptedException {
        return launchVanilla(request, waitForExit, DownloadSource.OFFICIAL);
    }

    public LaunchExecutionResult launchVanilla(LaunchRequest request, boolean waitForExit, DownloadSource downloadSource) throws IOException, InterruptedException {
        LaunchPlan plan = buildVanillaLaunchPlan(request, downloadSource);
        logProgress("launch", "Command line: " + String.join(" ", plan.command()));
        ProcessBuilder builder = new ProcessBuilder(plan.command());
        builder.directory(request.gameDirectory().toFile());
        builder.redirectErrorStream(true);

        Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            cleanupLaunchArtifacts(plan);
            throw e;
        }
        long pid = process.pid();
        logProgress("launch", "Process started version=" + request.versionId() + " pid=" + pid);

        startProcessOutputForwarder(process);
        Path latestLogPath = request.gameDirectory().resolve("logs").resolve("latest.log");

        Integer exitCode = null;
        if (waitForExit) {
            try {
                exitCode = waitForProcessWithLatestLog(process, latestLogPath);
                logProgress("launch", "Process finished pid=" + pid + " exitCode=" + exitCode);
            } finally {
                cleanupLaunchArtifacts(plan);
            }
        } else {
            Thread tailThread = new Thread(() -> {
                try {
                    int code = waitForProcessWithLatestLog(process, latestLogPath);
                    logProgress("launch", "Process finished pid=" + pid + " exitCode=" + code);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                } finally {
                    cleanupLaunchArtifacts(plan);
                }
            }, "mc-latest-log-tailer");
            tailThread.setDaemon(true);
            tailThread.start();
        }

        return new LaunchExecutionResult(
                request.versionId(),
                pid,
                waitForExit,
                exitCode,
                plan.mainClass(),
                plan.command()
        );
    }

    private void cleanupLaunchArtifacts(LaunchPlan plan) {
        try {
            deleteDirectoryRecursively(plan.nativesDirectory());
        } catch (IOException e) {
            logProgress("launch", "Failed cleaning natives directory " + plan.nativesDirectory() + ": " + e.getMessage());
        }
    }

    private void deleteDirectoryRecursively(Path directory) throws IOException {
        if (directory == null || !Files.exists(directory)) {
            return;
        }
        Files.walkFileTree(directory, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.deleteIfExists(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException exc) throws IOException {
                if (exc != null) {
                    throw exc;
                }
                Files.deleteIfExists(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }

    private void startProcessOutputForwarder(Process process) {
        Thread thread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (!line.isBlank()) {
                        logProgress("game", line);
                    }
                }
            } catch (IOException e) {
                logProgress("game", "Failed reading game output: " + e.getMessage());
            }
        }, "mc-output-forwarder");
        thread.setDaemon(true);
        thread.start();
    }

    private int waitForProcessWithLatestLog(Process process, Path latestLogPath) throws InterruptedException {
        long offset = 0;
        while (process.isAlive()) {
            offset = emitLatestLogIncrement(latestLogPath, offset);
            Thread.sleep(300);
        }
        offset = emitLatestLogIncrement(latestLogPath, offset);
        return process.exitValue();
    }

    private long emitLatestLogIncrement(Path latestLogPath, long offset) {
        if (!Files.isRegularFile(latestLogPath)) {
            return offset;
        }

        try {
            long fileSize = Files.size(latestLogPath);
            if (fileSize < offset) {
                offset = 0;
            }
        } catch (IOException e) {
            return offset;
        }

        try (RandomAccessFile file = new RandomAccessFile(latestLogPath.toFile(), "r")) {
            file.seek(offset);
            String line;
            while ((line = file.readLine()) != null) {
                if (!line.isBlank()) {
                    String decoded = new String(line.getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8);
                    logProgress("latest.log", decoded);
                }
            }
            return file.getFilePointer();
        } catch (IOException e) {
            return offset;
        }
    }

    public List<String> listFabricLoaderVersions(String gameVersion) throws IOException, InterruptedException {
        return listFabricLoaderVersions(gameVersion, DownloadSource.OFFICIAL);
    }

    public List<String> listFabricLoaderVersions(String gameVersion, DownloadSource downloadSource) throws IOException, InterruptedException {
        JsonArray versions = getJsonArray(downloadSource.fabricLoaderApiBase() + "/" + gameVersion);
        List<String> result = new ArrayList<>();
        for (JsonElement element : versions) {
            JsonObject row = element.getAsJsonObject();
            JsonObject loader = row.getAsJsonObject("loader");
            result.add(loader.get("version").getAsString());
        }
        return result;
    }

    public FabricInstallResult installFabric(Path gameDirectory, String gameVersion, String requestedLoaderVersion) throws IOException, InterruptedException {
        return installFabric(gameDirectory, gameVersion, requestedLoaderVersion, DownloadSource.OFFICIAL);
    }

    public FabricInstallResult installFabric(Path gameDirectory, String gameVersion, String requestedLoaderVersion, DownloadSource downloadSource) throws IOException, InterruptedException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        IpcLogBridge.installPhaseStart("fabric", "prepare", "Prepare fabric install gameVersion=" + gameVersion);
        Path baseVersionJson = gameDir.resolve("versions").resolve(gameVersion).resolve(gameVersion + ".json");
        if (!Files.exists(baseVersionJson)) {
            installVanilla(gameDir, gameVersion, downloadSource);
        }

        String loaderVersion = requestedLoaderVersion;
        if (loaderVersion == null || loaderVersion.isBlank()) {
            JsonArray allLoaders = getJsonArray(downloadSource.fabricLoaderApiBase());
            loaderVersion = chooseLatestStableLoader(allLoaders);
        }

        JsonObject row = getFabricProfile(downloadSource.fabricLoaderApiBase() + "/" + gameVersion + "/" + loaderVersion);
        JsonObject launcherMeta = row.getAsJsonObject("launcherMeta");
        JsonObject intermediary = row.getAsJsonObject("intermediary");
        JsonObject loader = row.getAsJsonObject("loader");
        String created = row.has("created") ? row.get("created").getAsString() : Instant.now().toString();

        String profileId = "fabric-loader-" + loaderVersion + "-" + gameVersion;
        JsonObject versionJson = new JsonObject();
        versionJson.addProperty("id", profileId);
        versionJson.addProperty("inheritsFrom", gameVersion);
        versionJson.addProperty("time", created);
        versionJson.addProperty("releaseTime", created);

        if (launcherMeta.get("mainClass").isJsonObject()) {
            versionJson.addProperty("mainClass", launcherMeta.getAsJsonObject("mainClass").get("client").getAsString());
        } else {
            versionJson.addProperty("mainClass", launcherMeta.get("mainClass").getAsString());
        }

        if (launcherMeta.has("arguments")) {
            versionJson.add("arguments", launcherMeta.getAsJsonObject("arguments"));
        }

        JsonArray libraries = new JsonArray();
        JsonObject launcherLibraries = launcherMeta.getAsJsonObject("libraries");
        if (launcherLibraries.has("common")) {
            appendLibraries(libraries, launcherLibraries.getAsJsonArray("common"));
        }
        if (launcherLibraries.has("client")) {
            appendLibraries(libraries, launcherLibraries.getAsJsonArray("client"));
        }
        if (launcherLibraries.has("server")) {
            appendLibraries(libraries, launcherLibraries.getAsJsonArray("server"));
        }

        addFabricMavenLibrary(libraries, intermediary.get("maven").getAsString(), downloadSource);
        addFabricMavenLibrary(libraries, loader.get("maven").getAsString(), downloadSource);
        versionJson.add("libraries", libraries);

        Path profileDir = gameDir.resolve("versions").resolve(profileId);
        Files.createDirectories(profileDir);
        Path profileJson = profileDir.resolve(profileId + ".json");
        writeJson(profileJson, versionJson);

        IpcLogBridge.installPhaseStart("fabric", "libraries", "Download fabric libraries");
        List<Path> downloadedLibraries = downloadLibraries(versionJson, gameDir, profileId, "fabric", downloadSource);
        IpcLogBridge.installPhaseComplete(
                "fabric",
                "complete",
                "Fabric install completed profile=" + profileId + " libraries=" + downloadedLibraries.size()
        );
        return new FabricInstallResult(profileId, loaderVersion, profileJson, downloadedLibraries.size());
    }

    public List<String> listForgeVersions(String gameVersion) throws IOException, InterruptedException {
        return listForgeVersions(gameVersion, DownloadSource.OFFICIAL);
    }

    public List<String> listForgeVersions(String gameVersion, DownloadSource downloadSource) throws IOException, InterruptedException {
        if (downloadSource == DownloadSource.BMCLAPI) {
            return listForgeVersionsFromBmclapi(gameVersion, downloadSource);
        }

        List<String> versions = new ArrayList<>();
        String xml = getText(downloadSource.forgeVersionListUrl(gameVersion));
        String prefix = gameVersion + "-";

        int index = 0;
        while (true) {
            int begin = xml.indexOf("<version>", index);
            if (begin < 0) {
                break;
            }
            int end = xml.indexOf("</version>", begin);
            if (end < 0) {
                break;
            }

            String candidate = xml.substring(begin + "<version>".length(), end).trim();
            if (candidate.startsWith(prefix)) {
                versions.add(candidate);
            }
            index = end + "</version>".length();
        }

        return versions.stream()
                .distinct()
                .sorted((a, b) -> compareForgeVersions(b, a))
                .collect(Collectors.toList());
    }

    private int compareForgeVersions(String a, String b) {
        String[] aParts = a.split("[-.]");
        String[] bParts = b.split("[-.]");
        int max = Math.max(aParts.length, bParts.length);
        for (int i = 0; i < max; i++) {
            int ai = i < aParts.length ? parseIntSafe(aParts[i]) : 0;
            int bi = i < bParts.length ? parseIntSafe(bParts[i]) : 0;
            int cmp = Integer.compare(ai, bi);
            if (cmp != 0) {
                return cmp;
            }
        }
        return a.compareTo(b);
    }

    private int parseIntSafe(String value) {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    public ForgeInstallResult installForge(Path gameDirectory, String gameVersion, String requestedForgeVersion, Path javaExecutable) throws IOException, InterruptedException {
        return installForge(gameDirectory, gameVersion, requestedForgeVersion, javaExecutable, DownloadSource.OFFICIAL);
    }

    public ForgeInstallResult installForge(Path gameDirectory, String gameVersion, String requestedForgeVersion, Path javaExecutable, DownloadSource downloadSource) throws IOException, InterruptedException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        IpcLogBridge.installPhaseStart("forge", "prepare", "Prepare forge install gameVersion=" + gameVersion);
        Path baseVersionJson = gameDir.resolve("versions").resolve(gameVersion).resolve(gameVersion + ".json");
        if (!Files.exists(baseVersionJson)) {
            installVanilla(gameDir, gameVersion, downloadSource);
        }

        String forgeVersion = requestedForgeVersion;
        if (forgeVersion == null || forgeVersion.isBlank()) {
            List<String> versions = listForgeVersions(gameVersion, downloadSource);
            if (versions.isEmpty()) {
                throw new IOException("No forge versions found for game version " + gameVersion);
            }
            forgeVersion = versions.get(0);
        }

        String installerUrl = downloadSource.forgeInstallerUrl(gameVersion, forgeVersion);

        IpcLogBridge.installPhaseStart("forge", "installer", "Run forge installer " + forgeVersion);
        ModLoaderService.ForgeInstallResult installResult = new ModLoaderService(downloadSource)
                .installForge(gameDir, forgeVersion, javaExecutable.toAbsolutePath().toString());

        String profileId = installResult.profileId();
        Path profileJsonPath = gameDir.resolve("versions").resolve(profileId).resolve(profileId + ".json");
        if (!Files.isRegularFile(profileJsonPath)) {
            throw new IOException("Forge profile json not found after install: " + profileJsonPath);
        }

        IpcLogBridge.installPhaseComplete(
                "forge",
                "complete",
                "Forge install completed profile=" + profileId
        );

        return new ForgeInstallResult(profileId, forgeVersion, profileJsonPath, installerUrl);
    }

    private List<String> listForgeVersionsFromBmclapi(String gameVersion, DownloadSource downloadSource) throws IOException, InterruptedException {
        JsonArray payload = getJsonArray(downloadSource.forgeVersionListUrl(gameVersion));
        List<String> versions = new ArrayList<>();
        for (JsonElement element : payload) {
            JsonObject row = element.getAsJsonObject();
            if (!row.has("version")) {
                continue;
            }

            boolean hasInstaller = false;
            if (row.has("files") && row.get("files").isJsonArray()) {
                for (JsonElement fileElement : row.getAsJsonArray("files")) {
                    JsonObject file = fileElement.getAsJsonObject();
                    if ("installer".equals(file.get("category").getAsString())
                            && "jar".equals(file.get("format").getAsString())) {
                        hasInstaller = true;
                        break;
                    }
                }
            }
            if (!hasInstaller) {
                continue;
            }

            String version = row.get("version").getAsString();
            String branch = row.has("branch") && !row.get("branch").isJsonNull()
                    ? row.get("branch").getAsString()
                    : "";
            String fullVersion = gameVersion + "-" + version + (branch.isBlank() ? "" : "-" + branch);
            versions.add(fullVersion);
        }

        return versions.stream()
                .distinct()
                .sorted((a, b) -> compareForgeVersions(b, a))
                .collect(Collectors.toList());
    }

    private String chooseLatestStableLoader(JsonArray loaderRows) {
        String latestStable = null;
        for (JsonElement element : loaderRows) {
            JsonObject row = element.getAsJsonObject();
            if (!row.get("stable").getAsBoolean()) {
                continue;
            }
            latestStable = row.get("version").getAsString();
            break;
        }
        if (latestStable == null && !loaderRows.isEmpty()) {
            latestStable = loaderRows.get(0).getAsJsonObject().get("version").getAsString();
        }
        if (latestStable == null) {
            throw new IllegalStateException("Unable to resolve fabric loader version");
        }
        return latestStable;
    }

    private void appendLibraries(JsonArray target, JsonArray source) {
        for (JsonElement element : source) {
            target.add(element.getAsJsonObject().deepCopy());
        }
    }

    private void addFabricMavenLibrary(JsonArray libraries, String mavenCoordinate, DownloadSource downloadSource) {
        JsonObject library = new JsonObject();
        library.addProperty("name", mavenCoordinate);
        library.addProperty("url", downloadSource.fabricMavenRepo());
        libraries.add(library);
    }

    private ResolvedVersionDescriptor resolveVersionDescriptor(Path gameDir, String versionId, int depth) throws IOException {
        if (depth > 8) {
            throw new IOException("Version inheritance depth exceeded limit for " + versionId);
        }

        Path versionJsonPath = gameDir.resolve("versions").resolve(versionId).resolve(versionId + ".json");
        if (!Files.isRegularFile(versionJsonPath)) {
            throw new IOException("Version metadata not found: " + versionJsonPath);
        }

        JsonObject raw = JsonParser.parseString(Files.readString(versionJsonPath)).getAsJsonObject();
        if (!raw.has("inheritsFrom")) {
            String jarVersion = raw.has("jar") ? raw.get("jar").getAsString() : versionId;
            return new ResolvedVersionDescriptor(raw.deepCopy(), raw, jarVersion);
        }

        String parentId = raw.get("inheritsFrom").getAsString();
        ResolvedVersionDescriptor parent = resolveVersionDescriptor(gameDir, parentId, depth + 1);
        JsonObject merged = mergeVersionJson(parent.merged(), raw);
        String jarVersion = raw.has("jar") ? raw.get("jar").getAsString() : parent.jarVersionId();
        return new ResolvedVersionDescriptor(merged, raw, jarVersion);
    }

    private JsonObject mergeVersionJson(JsonObject parent, JsonObject child) {
        JsonObject merged = parent.deepCopy();

        for (Map.Entry<String, JsonElement> entry : child.entrySet()) {
            String key = entry.getKey();
            JsonElement value = entry.getValue();

            if ("libraries".equals(key) && value.isJsonArray()) {
                JsonArray mergedLibraries = new JsonArray();
                if (parent.has("libraries") && parent.get("libraries").isJsonArray()) {
                    for (JsonElement parentLibrary : parent.getAsJsonArray("libraries")) {
                        mergedLibraries.add(parentLibrary.deepCopy());
                    }
                }
                for (JsonElement childLibrary : value.getAsJsonArray()) {
                    mergedLibraries.add(childLibrary.deepCopy());
                }
                merged.add("libraries", mergedLibraries);
                continue;
            }

            if ("arguments".equals(key) && value.isJsonObject()) {
                merged.add("arguments", mergeArguments(
                        parent.has("arguments") && parent.get("arguments").isJsonObject()
                                ? parent.getAsJsonObject("arguments")
                                : null,
                        value.getAsJsonObject()
                ));
                continue;
            }

            merged.add(key, value.deepCopy());
        }

        return merged;
    }

    private JsonObject mergeArguments(JsonObject parentArguments, JsonObject childArguments) {
        JsonObject merged = parentArguments == null ? new JsonObject() : parentArguments.deepCopy();

        for (Map.Entry<String, JsonElement> entry : childArguments.entrySet()) {
            String key = entry.getKey();
            JsonElement value = entry.getValue();
            if (value.isJsonArray() && merged.has(key) && merged.get(key).isJsonArray()) {
                JsonArray combined = new JsonArray();
                for (JsonElement parentItem : merged.getAsJsonArray(key)) {
                    combined.add(parentItem.deepCopy());
                }
                for (JsonElement childItem : value.getAsJsonArray()) {
                    combined.add(childItem.deepCopy());
                }
                merged.add(key, combined);
            } else {
                merged.add(key, value.deepCopy());
            }
        }

        return merged;
    }

    private void ensureLibraryDownloaded(ResolvedLibrary library) throws IOException {
        if (Files.isRegularFile(library.path())) {
            return;
        }
        if (library.downloadUrls() == null || library.downloadUrls().isEmpty()) {
            throw new IOException("Missing download URL for library: " + library.path());
        }
        try {
            downloadFile(library.downloadUrls(), library.path(), library.sha1(), "library");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while downloading library " + library.path(), e);
        }
    }

    private void ensureClientJarDownloaded(JsonObject versionJson, Path clientJar, DownloadSource downloadSource) throws IOException {
        if (Files.isRegularFile(clientJar)) {
            return;
        }
        if (!versionJson.has("downloads") || !versionJson.getAsJsonObject("downloads").has("client")) {
            throw new IOException("Client download info missing and jar not found: " + clientJar);
        }
        JsonObject clientDownload = versionJson.getAsJsonObject("downloads").getAsJsonObject("client");
        List<String> urls = downloadSource.candidateUrls(clientDownload.get("url").getAsString());
        String sha1 = clientDownload.has("sha1") ? clientDownload.get("sha1").getAsString() : null;
        try {
            downloadFile(urls, clientJar, sha1, "client");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while downloading client jar", e);
        }
    }

    private boolean containsClasspathArg(List<String> args) {
        for (String arg : args) {
            if ("-cp".equals(arg) || "-classpath".equals(arg) || arg.startsWith("-Djava.class.path=")) {
                return true;
            }
        }
        return false;
    }

    private Map<String, Boolean> buildRuleFeatures() {
        Map<String, Boolean> features = new HashMap<>();
        features.put("is_demo_user", false);
        features.put("has_custom_resolution", true);
        features.put("has_quick_plays_support", false);
        features.put("is_quick_play_singleplayer", false);
        features.put("is_quick_play_multiplayer", false);
        features.put("is_quick_play_realms", false);
        return features;
    }

    private Map<String, String> buildVariables(LaunchRequest request, JsonObject versionJson, Path gameDir, Path nativesDir, String classpath) {
        Map<String, String> variables = new HashMap<>();
        variables.put("${auth_player_name}", request.playerName());
        variables.put("${auth_uuid}", request.uuid());
        variables.put("${auth_access_token}", request.accessToken());
        variables.put("${version_name}", request.versionId());
        variables.put("${game_directory}", gameDir.toString());
        variables.put("${assets_root}", gameDir.resolve("assets").toString());
        variables.put("${assets_index_name}", versionJson.getAsJsonObject("assetIndex").get("id").getAsString());
        variables.put("${natives_directory}", nativesDir.toString());
        variables.put("${classpath}", classpath);
        variables.put("${version_type}", versionJson.has("type") ? versionJson.get("type").getAsString() : "release");
        variables.put("${launcher_name}", "FPSMasterLauncher");
        variables.put("${launcher_version}", "0.1.0");
        variables.put("${user_type}", "msa");
        variables.put("${auth_xuid}", "0");
        variables.put("${clientid}", "057064c6-d180-43df-b010-834b4571532f");
        variables.put("${user_properties}", "{}");
        variables.put("${profile_properties}", "{}");
        variables.put("${auth_session}", request.accessToken());
        variables.put("${game_assets}", gameDir.resolve("assets").resolve("virtual").resolve("legacy").toString());
        variables.put("${library_directory}", gameDir.resolve("libraries").toString());
        variables.put("${resolution_width}", "1200");
        variables.put("${resolution_height}", "680");
        variables.put("${classpath_separator}", OsUtils.classPathSeparator());
        variables.put("${primary_jar}", gameDir.resolve("versions").resolve(request.versionId()).resolve(request.versionId() + ".jar").toString());
        return variables;
    }

    private List<String> resolveArgumentArray(
            JsonArray argumentArray,
            Map<String, String> variables,
            Map<String, Boolean> ruleFeatures
    ) {
        List<String> arguments = new ArrayList<>();
        for (JsonElement element : argumentArray) {
            if (element.isJsonPrimitive()) {
                appendResolvedArguments(List.of(element.getAsString()), variables, arguments);
                continue;
            }
            JsonObject argumentObject = element.getAsJsonObject();
            if (!rulesMatch(argumentObject.getAsJsonArray("rules"), ruleFeatures)) {
                continue;
            }
            JsonElement valueElement = argumentObject.get("value");
            if (valueElement.isJsonArray()) {
                List<String> values = new ArrayList<>();
                for (JsonElement nested : valueElement.getAsJsonArray()) {
                    values.add(nested.getAsString());
                }
                appendResolvedArguments(values, variables, arguments);
            } else {
                appendResolvedArguments(List.of(valueElement.getAsString()), variables, arguments);
            }
        }
        return arguments;
    }

    private void appendResolvedArguments(List<String> rawTokens, Map<String, String> variables, List<String> target) {
        for (int i = 0; i < rawTokens.size(); i++) {
            String currentRaw = rawTokens.get(i);
            String current = replaceVariables(currentRaw, variables).trim();

            if (current.startsWith("--") && i + 1 < rawTokens.size()) {
                String nextRaw = rawTokens.get(i + 1);
                if (!nextRaw.startsWith("--")) {
                    String next = replaceVariables(nextRaw, variables).trim();
                    if (!shouldOmitResolvedArg(next) && !shouldOmitResolvedArg(current)) {
                        target.add(current);
                        target.add(next);
                    }
                    i++;
                    continue;
                }
            }

            if (!shouldOmitResolvedArg(current)) {
                target.add(current);
            }
        }
    }

    private boolean shouldOmitResolvedArg(String arg) {
        return arg.isBlank() || arg.contains("${");
    }

    private String replaceVariables(String input, Map<String, String> variables) {
        String result = input;
        for (Map.Entry<String, String> entry : variables.entrySet()) {
            result = result.replace(entry.getKey(), entry.getValue());
        }
        return result;
    }

    private List<String> normalizeJvmArguments(List<String> args) {
        List<String> normalized = new ArrayList<>();
        for (int i = 0; i < args.size(); i++) {
            String current = args.get(i);

            if (current.startsWith("-Djava.library.path ")) {
                String value = current.substring("-Djava.library.path ".length()).trim();
                normalized.add("-Djava.library.path=" + value);
                continue;
            }

            if ("-Djava.library.path".equals(current) && i + 1 < args.size()) {
                normalized.add("-Djava.library.path=" + args.get(i + 1));
                i++;
                continue;
            }

            if (current.startsWith("-D") && !current.contains("=") && i + 1 < args.size()) {
                String next = args.get(i + 1);
                if (next.startsWith(".")) {
                    normalized.add(current + next);
                    i++;
                    continue;
                }
            }

            normalized.add(current);
        }
        return normalized;
    }

    private int downloadAssets(
            JsonObject versionJson,
            Path gameDirectory,
            String versionId,
            String phase,
            DownloadSource downloadSource
    ) throws IOException, InterruptedException {
        JsonObject assetIndex = versionJson.getAsJsonObject("assetIndex");
        String assetIndexId = assetIndex.get("id").getAsString();
        String assetIndexUrl = downloadSource.rewriteUrl(assetIndex.get("url").getAsString());
        String assetIndexSha1 = assetIndex.has("sha1") ? assetIndex.get("sha1").getAsString() : null;

        Path assetIndexPath = gameDirectory.resolve("assets").resolve("indexes").resolve(assetIndexId + ".json");
        downloadFile(downloadSource.candidateUrls(assetIndex.get("url").getAsString()), assetIndexPath, assetIndexSha1, "asset-index");

        JsonObject indexObject = JsonParser.parseString(Files.readString(assetIndexPath)).getAsJsonObject();
        JsonObject objects = indexObject.getAsJsonObject("objects");

        int total = objects.entrySet().size();
        Map<Path, AssetDownload> uniqueAssets = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> entry : objects.entrySet()) {
            JsonObject object = entry.getValue().getAsJsonObject();
            String hash = object.get("hash").getAsString();
            String prefix = hash.substring(0, 2);
            List<String> urls = downloadSource.assetObjectCandidates(hash);
            Path objectPath = gameDirectory.resolve("assets").resolve("objects").resolve(prefix).resolve(hash);
            uniqueAssets.compute(
                    objectPath,
                    (path, existing) -> existing == null
                            ? new AssetDownload(objectPath, urls, hash, 1)
                            : existing.withAdditionalReference()
            );
        }
        logProgress("assets", "Start download total=" + total + " version=" + versionId);
        IpcLogBridge.installProgress(phase, "assets", 0, total, 0, total, "Start downloading assets");

        AtomicInteger completed = new AtomicInteger(0);
        AtomicInteger downloaded = new AtomicInteger(0);
        List<Callable<Void>> jobs = new ArrayList<>(uniqueAssets.size());
        for (AssetDownload asset : uniqueAssets.values()) {
            jobs.add(() -> {
                boolean fetched = downloadFile(asset.urls(), asset.target(), asset.sha1(), "asset");
                if (fetched) {
                    downloaded.incrementAndGet();
                }
                int done = completed.addAndGet(asset.references());
                logProgress("assets", "Downloaded " + done + "/" + total);
                IpcLogBridge.installProgress(
                        phase,
                        "assets",
                        done,
                        total,
                        downloaded.get(),
                        Math.max(0, done - downloaded.get()),
                        "Downloaded assets " + done + "/" + total
                );
                return null;
            });
        }

        runParallelJobs("asset download", jobs);

        Path legacyDir = gameDirectory.resolve("assets").resolve("virtual").resolve("legacy");
        Files.createDirectories(legacyDir);
        for (Map.Entry<String, JsonElement> entry : objects.entrySet()) {
            JsonObject object = entry.getValue().getAsJsonObject();
            String hash = object.get("hash").getAsString();
            String prefix = hash.substring(0, 2);
            Path source = gameDirectory.resolve("assets").resolve("objects").resolve(prefix).resolve(hash);
            Path target = legacyDir.resolve(entry.getKey());
            Files.createDirectories(target.getParent());
            if (!Files.exists(target)) {
                Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
        logProgress("assets", "Completed downloaded=" + downloaded.get() + " cached=" + (total - downloaded.get()));
        IpcLogBridge.installProgress(
                phase,
                "assets",
                total,
                total,
                downloaded.get(),
                total - downloaded.get(),
                "Assets completed downloaded=" + downloaded.get() + " cached=" + (total - downloaded.get())
        );
        return total;
    }

    private List<Path> downloadLibraries(
            JsonObject versionJson,
            Path gameDirectory,
            String versionId,
            String phase,
            DownloadSource downloadSource
    ) throws IOException, InterruptedException {
        List<ResolvedLibrary> libraries = resolveLibraries(versionJson, gameDirectory, versionId, buildRuleFeatures(), downloadSource);
        Map<Path, ResolvedLibrary> uniqueLibraries = new LinkedHashMap<>();
        for (ResolvedLibrary library : libraries) {
            if (library.downloadUrls() == null || library.downloadUrls().isEmpty()) {
                continue;
            }
            uniqueLibraries.putIfAbsent(library.path(), library);
        }

        int total = uniqueLibraries.size();
        logProgress("libraries", "Start download total=" + total + " version=" + versionId);
        IpcLogBridge.installProgress(phase, "libraries", 0, total, 0, total, "Start downloading libraries");

        AtomicInteger completed = new AtomicInteger(0);
        AtomicInteger downloaded = new AtomicInteger(0);
        List<Callable<Path>> jobs = new ArrayList<>(total);
        for (ResolvedLibrary library : uniqueLibraries.values()) {
            jobs.add(() -> {
                boolean fetched = downloadFile(library.downloadUrls(), library.path(), library.sha1(), "library");
                if (fetched) {
                    downloaded.incrementAndGet();
                }
                int done = completed.incrementAndGet();
                logProgress("libraries", "Downloaded " + done + "/" + total);
                IpcLogBridge.installProgress(
                        phase,
                        "libraries",
                        done,
                        total,
                        downloaded.get(),
                        done - downloaded.get(),
                        "Downloaded libraries " + done + "/" + total
                );
                return library.path();
            });
        }

        List<Path> results = runParallelJobs("library download", jobs);
        logProgress("libraries", "Completed downloaded=" + downloaded.get() + " cached=" + (total - downloaded.get()));
        IpcLogBridge.installProgress(
                phase,
                "libraries",
                total,
                total,
                downloaded.get(),
                total - downloaded.get(),
                "Libraries completed downloaded=" + downloaded.get() + " cached=" + (total - downloaded.get())
        );
        return results;
    }

    private List<ResolvedLibrary> resolveLibraries(
            JsonObject versionJson,
            Path gameDirectory,
            String versionId,
            Map<String, Boolean> ruleFeatures,
            DownloadSource downloadSource
    ) {
        JsonArray libraries = versionJson.getAsJsonArray("libraries");
        List<ResolvedLibrary> resolved = new ArrayList<>();

        for (JsonElement libraryElement : libraries) {
            JsonObject library = libraryElement.getAsJsonObject();
            if (!rulesMatch(library.has("rules") ? library.getAsJsonArray("rules") : null, ruleFeatures)) {
                continue;
            }

            String name = library.get("name").getAsString();
            String libraryRepo = library.has("url")
                    ? library.get("url").getAsString()
                    : DownloadSource.OFFICIAL.defaultLibraryRepo();

            JsonObject downloads = library.has("downloads") ? library.getAsJsonObject("downloads") : null;
            JsonObject classifiers = downloads != null && downloads.has("classifiers")
                    ? downloads.getAsJsonObject("classifiers")
                    : null;
            String nativeKey = resolveNativeClassifierKey(library, classifiers);

            if (nativeKey != null && classifiers != null && classifiers.has(nativeKey)) {
                JsonObject classifier = classifiers.getAsJsonObject(nativeKey);
                String path = classifier.get("path").getAsString();
                Path target = gameDirectory.resolve("libraries").resolve(path);
                List<String> urls = classifier.has("url")
                        ? downloadSource.candidateUrls(classifier.get("url").getAsString())
                        : downloadSource.candidateUrls(normalizeBaseUrl(libraryRepo) + path);
                String sha1 = classifier.has("sha1") ? classifier.get("sha1").getAsString() : null;
                resolved.add(new ResolvedLibrary(target, urls, sha1, false, true));
            }

            if (downloads != null && downloads.has("artifact")) {
                JsonObject artifact = downloads.getAsJsonObject("artifact");
                String path = artifact.get("path").getAsString();
                Path target = gameDirectory.resolve("libraries").resolve(path);
                List<String> urls = artifact.has("url")
                        ? downloadSource.candidateUrls(artifact.get("url").getAsString())
                        : downloadSource.candidateUrls(normalizeBaseUrl(libraryRepo) + path);
                String sha1 = artifact.has("sha1") ? artifact.get("sha1").getAsString() : null;
                resolved.add(new ResolvedLibrary(target, urls, sha1, true, false));
                continue;
            }

            if (nativeKey == null) {
                MavenCoordinates coordinates = MavenCoordinates.parse(name);
                String path = coordinates.toJarPath();
                Path target = gameDirectory.resolve("libraries").resolve(path);
                resolved.add(new ResolvedLibrary(
                        target,
                        downloadSource.candidateUrls(normalizeBaseUrl(libraryRepo) + path),
                        null,
                        true,
                        false
                ));
            }
        }
        return resolved;
    }

    private String resolveNativeClassifierKey(JsonObject library, JsonObject classifiers) {
        if (classifiers == null || classifiers.isEmpty()) {
            return null;
        }

        String osName = OsUtils.minecraftOsName();
        String arch = OsUtils.archToken();

        if (library.has("natives")) {
            JsonObject natives = library.getAsJsonObject("natives");
            if (natives.has(osName)) {
                return natives.get(osName).getAsString().replace("${arch}", arch);
            }
        }

        List<String> candidates = List.of(
                "natives-" + osName + "-" + arch,
                "native-" + osName + "-" + arch,
                "natives-" + osName,
                "native-" + osName,
                osName + "-" + arch,
                osName
        );
        for (String candidate : candidates) {
            if (classifiers.has(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private boolean rulesMatch(JsonArray rules, Map<String, Boolean> ruleFeatures) {
        if (rules == null || rules.isEmpty()) {
            return true;
        }
        boolean allowed = false;
        String currentOs = OsUtils.minecraftOsName();
        for (JsonElement element : rules) {
            JsonObject rule = element.getAsJsonObject();
            boolean matches = true;
            if (rule.has("os")) {
                JsonObject os = rule.getAsJsonObject("os");
                if (os.has("name")) {
                    matches = currentOs.equals(os.get("name").getAsString());
                }
            }
            if (matches && rule.has("features")) {
                JsonObject features = rule.getAsJsonObject("features");
                for (Map.Entry<String, JsonElement> featureEntry : features.entrySet()) {
                    boolean expected = featureEntry.getValue().getAsBoolean();
                    boolean actual = ruleFeatures.getOrDefault(featureEntry.getKey(), false);
                    if (actual != expected) {
                        matches = false;
                        break;
                    }
                }
            }
            if (!matches) {
                continue;
            }
            String action = rule.get("action").getAsString();
            if ("allow".equals(action)) {
                allowed = true;
            } else if ("disallow".equals(action)) {
                allowed = false;
            }
        }
        return allowed;
    }

    private void extractNativeJar(Path nativeJar, Path nativesDir) throws IOException {
        if (!Files.isRegularFile(nativeJar)) {
            return;
        }
        try (ZipInputStream input = new ZipInputStream(Files.newInputStream(nativeJar))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                if (entry.isDirectory() || entry.getName().startsWith("META-INF")) {
                    continue;
                }
                Path target = nativesDir.resolve(entry.getName());
                Files.createDirectories(target.getParent());
                Files.copy(input, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private void downloadClient(
            JsonObject versionJson,
            Path versionDir,
            String versionId,
            String phase,
            DownloadSource downloadSource
    ) throws IOException, InterruptedException {
        JsonObject clientDownload = versionJson.getAsJsonObject("downloads").getAsJsonObject("client");
        List<String> urls = downloadSource.candidateUrls(clientDownload.get("url").getAsString());
        String sha1 = clientDownload.has("sha1") ? clientDownload.get("sha1").getAsString() : null;
        Path target = versionDir.resolve(versionId + ".jar");
        boolean downloaded = downloadFile(urls, target, sha1, "client");
        IpcLogBridge.installProgress(
                phase,
                "client",
                1,
                1,
                downloaded ? 1 : 0,
                downloaded ? 0 : 1,
                downloaded ? "Client jar downloaded" : "Client jar already cached"
        );
    }

    private boolean downloadFile(List<String> urls, Path target, String expectedSha1, String artifactType) throws IOException, InterruptedException {
        if (urls == null || urls.isEmpty()) {
            throw new IOException("Download URL is missing for " + target);
        }
        if (Files.isRegularFile(target) && expectedSha1 != null) {
            String localSha1 = Sha1Utils.sha1(target);
            if (expectedSha1.equalsIgnoreCase(localSha1)) {
                return false;
            }
        }

        Files.createDirectories(target.getParent());
        Path tmp = target.resolveSibling(target.getFileName() + ".download");
        DownloadTaskException lastError = null;

        for (int candidateIndex = 0; candidateIndex < urls.size(); candidateIndex++) {
            String url = urls.get(candidateIndex);
            for (int attempt = 1; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
                Files.deleteIfExists(tmp);

                try {
                    HttpRequest request = HttpRequest.newBuilder()
                            .GET()
                            .uri(URI.create(url))
                            .timeout(Duration.ofMinutes(2))
                            .build();
                    HttpResponse<Path> response = httpClient.send(request, HttpResponse.BodyHandlers.ofFile(tmp));
                    if (response.statusCode() >= 400) {
                        DownloadTaskException statusError = DownloadTaskException.fromStatusCode(
                                artifactType,
                                target,
                                url,
                                attempt,
                                DOWNLOAD_RETRY_ATTEMPTS,
                                response.statusCode()
                        );
                        if (attempt < DOWNLOAD_RETRY_ATTEMPTS && isRetryableHttpStatus(response.statusCode())) {
                            logProgress(
                                    "download",
                                    "Retry " + (attempt + 1) + "/" + DOWNLOAD_RETRY_ATTEMPTS
                                            + " for " + target.getFileName()
                                            + " due to HTTP " + response.statusCode()
                            );
                            continue;
                        }
                        lastError = statusError;
                        break;
                    }

                    if (expectedSha1 != null) {
                        String downloadedSha1 = Sha1Utils.sha1(tmp);
                        if (!expectedSha1.equalsIgnoreCase(downloadedSha1)) {
                            throw DownloadTaskException.fromDetail(
                                    artifactType,
                                    target,
                                    url,
                                    attempt,
                                    DOWNLOAD_RETRY_ATTEMPTS,
                                    "SHA1 mismatch expected=" + expectedSha1 + " actual=" + downloadedSha1,
                                    null
                            );
                        }
                    }

                    Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                    return true;
                } catch (InterruptedException e) {
                    Files.deleteIfExists(tmp);
                    Thread.currentThread().interrupt();
                    throw e;
                } catch (DownloadTaskException e) {
                    Files.deleteIfExists(tmp);
                    if (attempt < DOWNLOAD_RETRY_ATTEMPTS && shouldRetryDownloadException(e)) {
                        logProgress(
                                "download",
                                "Retry " + (attempt + 1) + "/" + DOWNLOAD_RETRY_ATTEMPTS
                                        + " for " + target.getFileName()
                                        + " reason=" + e.getReason()
                        );
                        continue;
                    }
                    lastError = e;
                    break;
                } catch (IOException e) {
                    Files.deleteIfExists(tmp);
                    DownloadTaskException wrapped = DownloadTaskException.fromDetail(
                            artifactType,
                            target,
                            url,
                            attempt,
                            DOWNLOAD_RETRY_ATTEMPTS,
                            summarizeException(e),
                            e
                    );
                    if (attempt < DOWNLOAD_RETRY_ATTEMPTS && shouldRetryDownloadException(wrapped)) {
                        logProgress(
                                "download",
                                "Retry " + (attempt + 1) + "/" + DOWNLOAD_RETRY_ATTEMPTS
                                        + " for " + target.getFileName()
                                        + " reason=" + wrapped.getReason()
                        );
                        continue;
                    }
                    lastError = wrapped;
                    break;
                }
            }

            if (candidateIndex + 1 < urls.size()) {
                logProgress(
                        "download",
                        "Switching download source for " + target.getFileName()
                                + " to fallback candidate " + (candidateIndex + 2) + "/" + urls.size()
                );
            }
        }

        if (lastError != null) {
            throw lastError;
        }
        throw DownloadTaskException.fromDetail(
                artifactType,
                target,
                urls.get(0),
                DOWNLOAD_RETRY_ATTEMPTS,
                DOWNLOAD_RETRY_ATTEMPTS,
                "Unknown download failure",
                null
        );
    }

    private boolean shouldRetryDownloadException(DownloadTaskException error) {
        if (isRetryableHttpStatus(error.getStatusCode())) {
            return true;
        }
        String reason = error.getReason().toLowerCase(Locale.ROOT);
        return reason.contains("connection reset")
                || reason.contains("connection aborted")
                || reason.contains("connection closed")
                || reason.contains("connection refused")
                || reason.contains("timed out")
                || reason.contains("timeout")
                || reason.contains("broken pipe")
                || reason.contains("premature eof")
                || reason.contains("temporarily unavailable")
                || reason.contains("buffer_underflow")
                || reason.contains("non decrypted")
                || reason.contains("sslflowdelegate")
                || reason.contains("insufficient bytes");
    }

    private boolean isRetryableHttpStatus(Integer statusCode) {
        if (statusCode == null) {
            return false;
        }
        return statusCode == 408
                || statusCode == 425
                || statusCode == 429
                || statusCode == 500
                || statusCode == 502
                || statusCode == 503
                || statusCode == 504;
    }

    private String summarizeException(Throwable error) {
        if (error == null) {
            return "unknown";
        }
        String message = error.getMessage();
        if (message == null || message.isBlank()) {
            return error.getClass().getSimpleName();
        }
        return message;
    }

    private <T> List<T> runParallelJobs(String label, List<Callable<T>> jobs) throws IOException, InterruptedException {
        if (jobs.isEmpty()) {
            return List.of();
        }

        ExecutorService pool = Executors.newFixedThreadPool(downloadThreadCount(), new DownloadThreadFactory());
        try {
            List<Future<T>> futures = pool.invokeAll(jobs);
            List<T> results = new ArrayList<>(futures.size());
            for (Future<T> future : futures) {
                try {
                    results.add(future.get());
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    if (cause instanceof IOException ioException) {
                        throw ioException;
                    }
                    if (cause instanceof InterruptedException interruptedException) {
                        Thread.currentThread().interrupt();
                        throw interruptedException;
                    }
                    throw new IOException("Parallel " + label + " failed: " + cause.getMessage(), cause);
                }
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }

    private int downloadThreadCount() {
        int base = Runtime.getRuntime().availableProcessors() * 2;
        return Math.max(4, Math.min(16, base));
    }

    private void logProgress(String stage, String message) {
        System.err.println("[launcher-core][" + stage + "] " + message);
        System.err.flush();
    }

    private static final class DownloadThreadFactory implements ThreadFactory {
        private final AtomicInteger index = new AtomicInteger(1);

        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "launcher-download-" + index.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        }
    }

    private JsonObject getJson(String url) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .GET()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("Request failed url=" + url + " status=" + response.statusCode());
        }
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    private JsonArray getJsonArray(String url) throws IOException, InterruptedException {
        return JsonParser.parseString(getText(url)).getAsJsonArray();
    }

    private JsonObject getFabricProfile(String url) throws IOException, InterruptedException {
        JsonElement payload = JsonParser.parseString(getText(url));
        if (payload.isJsonArray()) {
            JsonArray array = payload.getAsJsonArray();
            if (array.isEmpty()) {
                throw new IOException("Fabric profile not found: empty response from " + url);
            }
            return array.get(0).getAsJsonObject();
        }
        if (payload.isJsonObject()) {
            return payload.getAsJsonObject();
        }
        throw new IOException("Invalid fabric profile payload from " + url + ": " + payload);
    }

    private String getText(String url) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .GET()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("Request failed url=" + url + " status=" + response.statusCode());
        }
        return response.body();
    }

    private JsonObject findVersionFromManifest(String versionId, DownloadSource downloadSource) throws IOException, InterruptedException {
        JsonObject manifest = getJson(downloadSource.versionManifestUrl());
        JsonArray versions = manifest.getAsJsonArray("versions");
        for (JsonElement versionElement : versions) {
            JsonObject version = versionElement.getAsJsonObject();
            if (Objects.equals(versionId, version.get("id").getAsString())) {
                return version;
            }
        }
        throw new IOException("Version not found in manifest: " + versionId);
    }

    private void writeJson(Path path, JsonObject jsonObject) throws IOException {
        Files.createDirectories(path.getParent());
        Files.writeString(path, gson.toJson(jsonObject));
    }

    private String normalizeBaseUrl(String url) {
        if (url.endsWith("/")) {
            return url;
        }
        return url + "/";
    }

    public record LaunchRequest(
            Path gameDirectory,
            String versionId,
            String playerName,
            String uuid,
            String accessToken,
            Path javaExecutable,
            int maxMemoryMb,
            String fpsAuthToken,
            String serverAddress
    ) {
        public LaunchRequest {
            if (fpsAuthToken == null) {
                fpsAuthToken = "";
            }
            if (serverAddress == null) {
                serverAddress = "";
            }
        }
    }

    public record InstallResult(String versionId, Path versionJsonPath, int librariesDownloaded, int assetsDownloaded) {
    }

    public record LaunchPlan(List<String> command, String classpath, String mainClass, Path nativesDirectory) {
    }

    public record LaunchExecutionResult(
            String versionId,
            long pid,
            boolean waitForExit,
            Integer exitCode,
            String mainClass,
            List<String> command
    ) {
    }

    public record JavaRuntimeRequirement(String versionId, int majorVersion, String component) {
    }

    public record FabricInstallResult(String profileId, String loaderVersion, Path profileJsonPath, int librariesDownloaded) {
    }

    public record ForgeInstallResult(String profileId, String forgeVersion, Path profileJsonPath, String installerUrl) {
    }

    private record ResolvedVersionDescriptor(JsonObject merged, JsonObject raw, String jarVersionId) {
    }

    private record ResolvedLibrary(Path path, List<String> downloadUrls, String sha1, boolean classpathEntry, boolean nativeEntry) {
    }

    private record AssetDownload(Path target, List<String> urls, String sha1, int references) {
        private AssetDownload withAdditionalReference() {
            return new AssetDownload(target, urls, sha1, references + 1);
        }
    }

    private record MavenCoordinates(String group, String artifact, String version) {
        static MavenCoordinates parse(String descriptor) {
            String[] parts = descriptor.split(":");
            if (parts.length < 3) {
                throw new IllegalArgumentException("Invalid maven descriptor: " + descriptor);
            }
            return new MavenCoordinates(parts[0], parts[1], parts[2]);
        }

        String toJarPath() {
            return group.replace('.', '/') + "/" + artifact + "/" + version + "/" + artifact + "-" + version + ".jar";
        }
    }
}
