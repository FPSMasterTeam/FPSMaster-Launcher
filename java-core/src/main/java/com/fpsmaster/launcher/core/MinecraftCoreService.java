package com.fpsmaster.launcher.core;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class MinecraftCoreService {
    private static final String VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    private static final String FABRIC_LOADER_URL = "https://meta.fabricmc.net/v2/versions/loader";
    private static final String HMCL_FORGE_METADATA_URL = "https://hmcl.glavo.site/metadata/forge/";
    private static final String DEFAULT_LIBRARY_REPO = "https://libraries.minecraft.net/";
    private static final String DEFAULT_ASSET_REPO = "https://resources.download.minecraft.net/";

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
        JsonObject manifest = getJson(VERSION_MANIFEST_URL);
        JsonArray versions = manifest.getAsJsonArray("versions");
        List<String> result = new ArrayList<>();
        for (JsonElement versionElement : versions) {
            result.add(versionElement.getAsJsonObject().get("id").getAsString());
        }
        return result;
    }

    public InstallResult installVanilla(Path gameDirectory, String versionId) throws IOException, InterruptedException {
        Path normalizedGameDir = gameDirectory.toAbsolutePath().normalize();
        Files.createDirectories(normalizedGameDir);

        JsonObject versionInfo = findVersionFromManifest(versionId);
        String versionJsonUrl = versionInfo.get("url").getAsString();

        JsonObject versionJson = getJson(versionJsonUrl);
        Path versionDir = normalizedGameDir.resolve("versions").resolve(versionId);
        Files.createDirectories(versionDir);

        Path versionJsonPath = versionDir.resolve(versionId + ".json");
        writeJson(versionJsonPath, versionJson);

        downloadClient(versionJson, versionDir, versionId);
        List<Path> downloadedLibraries = downloadLibraries(versionJson, normalizedGameDir, versionId);
        int assetsCount = downloadAssets(versionJson, normalizedGameDir, versionId);

        return new InstallResult(versionId, versionJsonPath, downloadedLibraries.size(), assetsCount);
    }

    public LaunchPlan buildVanillaLaunchPlan(LaunchRequest request) throws IOException {
        Path gameDir = request.gameDirectory().toAbsolutePath().normalize();
        String versionId = request.versionId();
        Path versionDir = gameDir.resolve("versions").resolve(versionId);
        Path versionJsonPath = versionDir.resolve(versionId + ".json");

        if (!Files.isRegularFile(versionJsonPath)) {
            throw new IOException("Version metadata not found: " + versionJsonPath);
        }

        JsonObject versionJson = JsonParser.parseString(Files.readString(versionJsonPath)).getAsJsonObject();

        Path nativesDir = versionDir.resolve("natives");
        Files.createDirectories(nativesDir);

        List<Path> classPathEntries = new ArrayList<>();
        for (ResolvedLibrary library : resolveLibraries(versionJson, gameDir, versionId)) {
            if (library.classpathEntry()) {
                classPathEntries.add(library.path());
            }
            if (library.nativeEntry()) {
                extractNativeJar(library.path(), nativesDir);
            }
        }

        Path clientJar = versionDir.resolve(versionId + ".jar");
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

        if (versionJson.has("arguments") && versionJson.getAsJsonObject("arguments").has("jvm")) {
            jvmArgs.addAll(resolveArgumentArray(versionJson.getAsJsonObject("arguments").getAsJsonArray("jvm"), variables));
        }

        String mainClass = versionJson.get("mainClass").getAsString();
        List<String> gameArgs = new ArrayList<>();
        if (versionJson.has("arguments") && versionJson.getAsJsonObject("arguments").has("game")) {
            gameArgs.addAll(resolveArgumentArray(versionJson.getAsJsonObject("arguments").getAsJsonArray("game"), variables));
        } else if (versionJson.has("minecraftArguments")) {
            for (String token : versionJson.get("minecraftArguments").getAsString().split(" ")) {
                if (!token.isBlank()) {
                    gameArgs.add(replaceVariables(token, variables));
                }
            }
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

    public List<String> listFabricLoaderVersions(String gameVersion) throws IOException, InterruptedException {
        JsonArray versions = getJsonArray(FABRIC_LOADER_URL + "/" + gameVersion);
        List<String> result = new ArrayList<>();
        for (JsonElement element : versions) {
            JsonObject row = element.getAsJsonObject();
            JsonObject loader = row.getAsJsonObject("loader");
            result.add(loader.get("version").getAsString());
        }
        return result;
    }

    public FabricInstallResult installFabric(Path gameDirectory, String gameVersion, String requestedLoaderVersion) throws IOException, InterruptedException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        Path baseVersionJson = gameDir.resolve("versions").resolve(gameVersion).resolve(gameVersion + ".json");
        if (!Files.exists(baseVersionJson)) {
            installVanilla(gameDir, gameVersion);
        }

        String loaderVersion = requestedLoaderVersion;
        if (loaderVersion == null || loaderVersion.isBlank()) {
            JsonArray allLoaders = getJsonArray(FABRIC_LOADER_URL);
            loaderVersion = chooseLatestStableLoader(allLoaders);
        }

        JsonArray profileRows = getJsonArray(FABRIC_LOADER_URL + "/" + gameVersion + "/" + loaderVersion);
        if (profileRows.isEmpty()) {
            throw new IOException("Fabric profile not found for game=" + gameVersion + " loader=" + loaderVersion);
        }

        JsonObject row = profileRows.get(0).getAsJsonObject();
        JsonObject launcherMeta = row.getAsJsonObject("launcherMeta");
        JsonObject intermediary = row.getAsJsonObject("intermediary");
        JsonObject loader = row.getAsJsonObject("loader");

        String profileId = "fabric-loader-" + loaderVersion + "-" + gameVersion;
        JsonObject versionJson = new JsonObject();
        versionJson.addProperty("id", profileId);
        versionJson.addProperty("inheritsFrom", gameVersion);
        versionJson.addProperty("time", row.get("created").getAsString());
        versionJson.addProperty("releaseTime", row.get("created").getAsString());

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

        addFabricMavenLibrary(libraries, intermediary.get("maven").getAsString());
        addFabricMavenLibrary(libraries, loader.get("maven").getAsString());
        versionJson.add("libraries", libraries);

        Path profileDir = gameDir.resolve("versions").resolve(profileId);
        Files.createDirectories(profileDir);
        Path profileJson = profileDir.resolve(profileId + ".json");
        writeJson(profileJson, versionJson);

        List<Path> downloadedLibraries = downloadLibraries(versionJson, gameDir, profileId);
        return new FabricInstallResult(profileId, loaderVersion, profileJson, downloadedLibraries.size());
    }

    public List<String> listForgeVersions(String gameVersion) throws IOException, InterruptedException {
        JsonObject root = getJson(HMCL_FORGE_METADATA_URL);
        JsonObject mcVersionMap = root.getAsJsonObject("mcversion");
        if (!mcVersionMap.has(gameVersion)) {
            return List.of();
        }
        JsonArray numberIds = mcVersionMap.getAsJsonArray(gameVersion);
        JsonObject numberMap = root.getAsJsonObject("number");

        List<String> versions = new ArrayList<>();
        for (JsonElement idElement : numberIds) {
            String id = idElement.getAsString();
            if (!numberMap.has(id)) {
                continue;
            }
            JsonObject forge = numberMap.getAsJsonObject(id);
            versions.add(forge.get("version").getAsString());
        }
        return versions.stream().distinct().collect(Collectors.toList());
    }

    public ForgeInstallResult installForge(Path gameDirectory, String gameVersion, String requestedForgeVersion, Path javaExecutable) throws IOException, InterruptedException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        Path baseVersionJson = gameDir.resolve("versions").resolve(gameVersion).resolve(gameVersion + ".json");
        if (!Files.exists(baseVersionJson)) {
            installVanilla(gameDir, gameVersion);
        }

        JsonObject root = getJson(HMCL_FORGE_METADATA_URL);
        JsonObject mcVersionMap = root.getAsJsonObject("mcversion");
        JsonObject numberMap = root.getAsJsonObject("number");
        String artifactName = root.get("artifact").getAsString();
        String webPath = root.get("webpath").getAsString();

        if (!mcVersionMap.has(gameVersion)) {
            throw new IOException("No forge metadata for game version " + gameVersion);
        }

        JsonArray numberIds = mcVersionMap.getAsJsonArray(gameVersion);
        JsonObject selected = null;
        for (JsonElement idElement : numberIds) {
            JsonObject candidate = numberMap.getAsJsonObject(idElement.getAsString());
            String candidateVersion = candidate.get("version").getAsString();
            if (requestedForgeVersion == null || requestedForgeVersion.isBlank() || requestedForgeVersion.equals(candidateVersion)) {
                selected = candidate;
            }
        }

        if (selected == null) {
            throw new IOException("Unable to resolve forge version for game=" + gameVersion + " requested=" + requestedForgeVersion);
        }

        String forgeVersion = selected.get("version").getAsString();
        String branch = selected.has("branch") && !selected.get("branch").isJsonNull() ? selected.get("branch").getAsString() : null;
        String classifier = gameVersion + "-" + forgeVersion + ((branch != null && !branch.isBlank()) ? "-" + branch : "");

        String extension = "jar";
        JsonArray filesArray = selected.getAsJsonArray("files");
        for (JsonElement fileEntry : filesArray) {
            JsonArray fileParts = fileEntry.getAsJsonArray();
            if (fileParts.size() > 1 && "installer".equals(fileParts.get(1).getAsString())) {
                extension = fileParts.get(0).getAsString();
                break;
            }
        }

        String installerFileName = artifactName + "-" + classifier + "-installer." + extension;
        String installerUrl = webPath + classifier + "/" + installerFileName;

        Path tempInstaller = Files.createTempFile("forge-installer-", "." + extension);
        downloadFile(installerUrl, tempInstaller, null);

        List<String> command = List.of(
                javaExecutable.toAbsolutePath().toString(),
                "-jar",
                tempInstaller.toAbsolutePath().toString(),
                "--installClient",
                gameDir.toAbsolutePath().toString()
        );

        Process process = new ProcessBuilder(command)
                .directory(gameDir.toFile())
                .inheritIO()
                .start();

        int exitCode;
        try {
            exitCode = process.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw e;
        } finally {
            Files.deleteIfExists(tempInstaller);
        }

        if (exitCode != 0) {
            throw new IOException("Forge installer exited with code " + exitCode);
        }

        Path versionsDir = gameDir.resolve("versions");
        Path installedProfile = findLatestForgeProfile(versionsDir, gameVersion);
        return new ForgeInstallResult(installedProfile.getFileName().toString(), forgeVersion, installedProfile.resolve(installedProfile.getFileName() + ".json"), installerUrl);
    }

    private Path findLatestForgeProfile(Path versionsDir, String gameVersion) throws IOException {
        try (var stream = Files.list(versionsDir)) {
            return stream
                    .filter(Files::isDirectory)
                    .filter(path -> path.getFileName().toString().contains("forge") && path.getFileName().toString().contains(gameVersion))
                    .max(Comparator.comparingLong(path -> path.toFile().lastModified()))
                    .orElseThrow(() -> new IOException("Forge profile not found after installation"));
        }
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

    private void addFabricMavenLibrary(JsonArray libraries, String mavenCoordinate) {
        JsonObject library = new JsonObject();
        library.addProperty("name", mavenCoordinate);
        library.addProperty("url", "https://maven.fabricmc.net/");
        libraries.add(library);
    }

    private boolean containsClasspathArg(List<String> args) {
        for (String arg : args) {
            if ("-cp".equals(arg) || "-classpath".equals(arg) || arg.startsWith("-Djava.class.path=")) {
                return true;
            }
        }
        return false;
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
        variables.put("${clientid}", "fpsmaster-launcher");
        return variables;
    }

    private List<String> resolveArgumentArray(JsonArray argumentArray, Map<String, String> variables) {
        List<String> arguments = new ArrayList<>();
        for (JsonElement element : argumentArray) {
            if (element.isJsonPrimitive()) {
                arguments.add(replaceVariables(element.getAsString(), variables));
                continue;
            }
            JsonObject argumentObject = element.getAsJsonObject();
            if (!rulesMatch(argumentObject.getAsJsonArray("rules"))) {
                continue;
            }
            JsonElement valueElement = argumentObject.get("value");
            if (valueElement.isJsonArray()) {
                for (JsonElement nested : valueElement.getAsJsonArray()) {
                    arguments.add(replaceVariables(nested.getAsString(), variables));
                }
            } else {
                arguments.add(replaceVariables(valueElement.getAsString(), variables));
            }
        }
        return arguments;
    }

    private String replaceVariables(String input, Map<String, String> variables) {
        String result = input;
        for (Map.Entry<String, String> entry : variables.entrySet()) {
            result = result.replace(entry.getKey(), entry.getValue());
        }
        return result;
    }

    private int downloadAssets(JsonObject versionJson, Path gameDirectory, String versionId) throws IOException, InterruptedException {
        JsonObject assetIndex = versionJson.getAsJsonObject("assetIndex");
        String assetIndexId = assetIndex.get("id").getAsString();
        String assetIndexUrl = assetIndex.get("url").getAsString();
        String assetIndexSha1 = assetIndex.has("sha1") ? assetIndex.get("sha1").getAsString() : null;

        Path assetIndexPath = gameDirectory.resolve("assets").resolve("indexes").resolve(assetIndexId + ".json");
        downloadFile(assetIndexUrl, assetIndexPath, assetIndexSha1);

        JsonObject indexObject = JsonParser.parseString(Files.readString(assetIndexPath)).getAsJsonObject();
        JsonObject objects = indexObject.getAsJsonObject("objects");

        int downloaded = 0;
        for (Map.Entry<String, JsonElement> entry : objects.entrySet()) {
            JsonObject object = entry.getValue().getAsJsonObject();
            String hash = object.get("hash").getAsString();
            String prefix = hash.substring(0, 2);
            String url = DEFAULT_ASSET_REPO + prefix + "/" + hash;
            Path objectPath = gameDirectory.resolve("assets").resolve("objects").resolve(prefix).resolve(hash);
            downloadFile(url, objectPath, hash);
            downloaded++;
        }

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
        return downloaded;
    }

    private List<Path> downloadLibraries(JsonObject versionJson, Path gameDirectory, String versionId) throws IOException, InterruptedException {
        List<Path> downloaded = new ArrayList<>();
        List<ResolvedLibrary> libraries = resolveLibraries(versionJson, gameDirectory, versionId);
        for (ResolvedLibrary library : libraries) {
            if (library.downloadUrl() == null) {
                continue;
            }
            downloadFile(library.downloadUrl(), library.path(), library.sha1());
            downloaded.add(library.path());
        }
        return downloaded;
    }

    private List<ResolvedLibrary> resolveLibraries(JsonObject versionJson, Path gameDirectory, String versionId) {
        JsonArray libraries = versionJson.getAsJsonArray("libraries");
        List<ResolvedLibrary> resolved = new ArrayList<>();

        for (JsonElement libraryElement : libraries) {
            JsonObject library = libraryElement.getAsJsonObject();
            if (!rulesMatch(library.has("rules") ? library.getAsJsonArray("rules") : null)) {
                continue;
            }

            String name = library.get("name").getAsString();
            String libraryRepo = library.has("url") ? library.get("url").getAsString() : DEFAULT_LIBRARY_REPO;

            if (library.has("downloads") && library.getAsJsonObject("downloads").has("artifact")) {
                JsonObject artifact = library.getAsJsonObject("downloads").getAsJsonObject("artifact");
                String path = artifact.get("path").getAsString();
                Path target = gameDirectory.resolve("libraries").resolve(path);
                String url = artifact.has("url") ? artifact.get("url").getAsString() : normalizeBaseUrl(libraryRepo) + path;
                String sha1 = artifact.has("sha1") ? artifact.get("sha1").getAsString() : null;
                resolved.add(new ResolvedLibrary(target, url, sha1, true, false));
            } else {
                MavenCoordinates coordinates = MavenCoordinates.parse(name);
                String path = coordinates.toJarPath();
                Path target = gameDirectory.resolve("libraries").resolve(path);
                String url = normalizeBaseUrl(libraryRepo) + path;
                resolved.add(new ResolvedLibrary(target, url, null, true, false));
            }

            if (library.has("natives") && library.has("downloads") && library.getAsJsonObject("downloads").has("classifiers")) {
                JsonObject classifiers = library.getAsJsonObject("downloads").getAsJsonObject("classifiers");
                String osName = OsUtils.minecraftOsName();
                String nativeKey = null;
                if (library.getAsJsonObject("natives").has(osName)) {
                    nativeKey = library.getAsJsonObject("natives").get(osName).getAsString();
                    nativeKey = nativeKey.replace("${arch}", OsUtils.archToken());
                }
                if (nativeKey != null && classifiers.has(nativeKey)) {
                    JsonObject classifier = classifiers.getAsJsonObject(nativeKey);
                    String path = classifier.get("path").getAsString();
                    Path target = gameDirectory.resolve("libraries").resolve(path);
                    String url = classifier.has("url") ? classifier.get("url").getAsString() : normalizeBaseUrl(libraryRepo) + path;
                    String sha1 = classifier.has("sha1") ? classifier.get("sha1").getAsString() : null;
                    resolved.add(new ResolvedLibrary(target, url, sha1, false, true));
                }
            }
        }
        return resolved;
    }

    private boolean rulesMatch(JsonArray rules) {
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

    private void downloadClient(JsonObject versionJson, Path versionDir, String versionId) throws IOException, InterruptedException {
        JsonObject clientDownload = versionJson.getAsJsonObject("downloads").getAsJsonObject("client");
        String url = clientDownload.get("url").getAsString();
        String sha1 = clientDownload.has("sha1") ? clientDownload.get("sha1").getAsString() : null;
        Path target = versionDir.resolve(versionId + ".jar");
        downloadFile(url, target, sha1);
    }

    private void downloadFile(String url, Path target, String expectedSha1) throws IOException, InterruptedException {
        if (Files.isRegularFile(target) && expectedSha1 != null) {
            String localSha1 = Sha1Utils.sha1(target);
            if (expectedSha1.equalsIgnoreCase(localSha1)) {
                return;
            }
        }

        Files.createDirectories(target.getParent());
        HttpRequest request = HttpRequest.newBuilder()
                .GET()
                .uri(URI.create(url))
                .timeout(Duration.ofMinutes(2))
                .build();
        Path tmp = target.resolveSibling(target.getFileName() + ".download");
        HttpResponse<Path> response = httpClient.send(request, HttpResponse.BodyHandlers.ofFile(tmp));
        if (response.statusCode() >= 400) {
            throw new IOException("Download failed for " + url + " status=" + response.statusCode());
        }

        if (expectedSha1 != null) {
            String downloadedSha1 = Sha1Utils.sha1(tmp);
            if (!expectedSha1.equalsIgnoreCase(downloadedSha1)) {
                throw new IOException("SHA1 mismatch for " + url + " expected=" + expectedSha1 + " actual=" + downloadedSha1);
            }
        }

        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
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
        HttpRequest request = HttpRequest.newBuilder()
                .GET()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(60))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 400) {
            throw new IOException("Request failed url=" + url + " status=" + response.statusCode());
        }
        return JsonParser.parseString(response.body()).getAsJsonArray();
    }

    private JsonObject findVersionFromManifest(String versionId) throws IOException, InterruptedException {
        JsonObject manifest = getJson(VERSION_MANIFEST_URL);
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
            int maxMemoryMb
    ) {
    }

    public record InstallResult(String versionId, Path versionJsonPath, int librariesDownloaded, int assetsDownloaded) {
    }

    public record LaunchPlan(List<String> command, String classpath, String mainClass, Path nativesDirectory) {
    }

    public record FabricInstallResult(String profileId, String loaderVersion, Path profileJsonPath, int librariesDownloaded) {
    }

    public record ForgeInstallResult(String profileId, String forgeVersion, Path profileJsonPath, String installerUrl) {
    }

    private record ResolvedLibrary(Path path, String downloadUrl, String sha1, boolean classpathEntry, boolean nativeEntry) {
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
