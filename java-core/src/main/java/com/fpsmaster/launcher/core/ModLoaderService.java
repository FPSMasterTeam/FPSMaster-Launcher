package com.fpsmaster.launcher.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import javax.xml.parsers.DocumentBuilderFactory;
import java.io.ByteArrayInputStream;
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
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public final class ModLoaderService {
    private static final String FABRIC_META = "https://meta.fabricmc.net";
    private static final String FORGE_MAVEN = "https://maven.minecraftforge.net";
    private static final String MINECRAFT_LIBRARIES = "https://libraries.minecraft.net";

    private final HttpClient httpClient;

    public ModLoaderService() {
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(30))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    public List<String> listFabricLoaderVersions(String gameVersion) throws IOException, InterruptedException {
        String url = FABRIC_META + "/v2/versions/loader/" + gameVersion;
        JsonArray payload = getJsonArray(url);
        List<String> result = new ArrayList<>();
        for (JsonElement element : payload) {
            JsonObject loader = element.getAsJsonObject().getAsJsonObject("loader");
            if (loader != null && loader.has("version")) {
                result.add(loader.get("version").getAsString());
            }
        }
        return result;
    }

    public FabricInstallResult installFabric(Path gameDirectory, String gameVersion, String loaderVersion) throws IOException, InterruptedException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        Files.createDirectories(gameDir);

        String profileUrl = FABRIC_META + "/v2/versions/loader/" + gameVersion + "/" + loaderVersion + "/profile/json";
        JsonObject profile = getJsonObject(profileUrl);
        String profileId = profile.get("id").getAsString();

        Path profileDir = gameDir.resolve("versions").resolve(profileId);
        Files.createDirectories(profileDir);
        Path profileJsonPath = profileDir.resolve(profileId + ".json");
        Files.writeString(profileJsonPath, profile.toString());

        int downloaded = 0;
        JsonArray libraries = profile.getAsJsonArray("libraries");
        for (JsonElement libraryElement : libraries) {
            JsonObject library = libraryElement.getAsJsonObject();
            String name = library.get("name").getAsString();
            String baseUrl = library.has("url") ? library.get("url").getAsString() : "https://maven.fabricmc.net/";
            String sha1 = library.has("sha1") ? library.get("sha1").getAsString() : null;

            MavenArtifact artifact = MavenArtifact.parse(name);
            Path libPath = gameDir.resolve("libraries").resolve(artifact.jarPath());
            downloadFile(normalizeBaseUrl(baseUrl) + artifact.jarPath(), libPath, sha1);
            downloaded++;
        }

        return new FabricInstallResult(profileId, profileJsonPath, downloaded);
    }

    public List<String> listForgeVersions(String gameVersion) throws Exception {
        String metadataUrl = FORGE_MAVEN + "/net/minecraftforge/forge/maven-metadata.xml";
        String xml = getText(metadataUrl);

        var document = DocumentBuilderFactory.newInstance()
                .newDocumentBuilder()
                .parse(new ByteArrayInputStream(xml.getBytes()));
        var versions = document.getElementsByTagName("version");

        List<String> result = new ArrayList<>();
        String prefix = gameVersion + "-";
        for (int i = 0; i < versions.getLength(); i++) {
            String version = versions.item(i).getTextContent();
            if (version.startsWith(prefix)) {
                result.add(version);
            }
        }
        result.sort((a, b) -> compareForgeVersions(b, a));
        return result;
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

    public ForgeInstallResult installForge(Path gameDirectory, String forgeVersion, String javaPath) throws IOException, InterruptedException {
        Path gameDir = gameDirectory.toAbsolutePath().normalize();
        Files.createDirectories(gameDir);
        ensureLauncherProfiles(gameDir);
        IpcLogBridge.installPhaseStart("forge", "prepare", "Preparing forge installer environment");

        String installerName = "forge-" + forgeVersion + "-installer.jar";
        String artifactBase = FORGE_MAVEN + "/net/minecraftforge/forge/" + forgeVersion + "/";
        String installerUrl = artifactBase + installerName;

        Path installerPath = gameDir.resolve("installers").resolve(installerName);
        IpcLogBridge.installProgress("forge", "download-installer", 0, 1, 0, 1, "Downloading forge installer");
        downloadFile(installerUrl, installerPath, null);
        IpcLogBridge.installProgress("forge", "download-installer", 1, 1, 1, 0, "Forge installer ready");

        ForgeInstallerProfile profile = inspectInstaller(installerPath);
        if (!profile.newStyle()) {
            IpcLogBridge.installPhaseStart("forge", "legacy-profile", "Detected legacy forge installer profile");
            return installForgeOldProfile(gameDir, forgeVersion, installerPath, profile.installProfile());
        }

        IpcLogBridge.installPhaseStart("forge", "run-installer", "Running forge installer (first attempt)");
        ProcessBuilder firstAttempt = new ProcessBuilder(
                javaPath,
                "-jar",
                installerPath.toString(),
                "--installClient",
                "--installDir",
                gameDir.toString()
        );
        firstAttempt.directory(gameDir.toFile());
        ProcessResult firstResult = runProcess(firstAttempt);
        if (firstResult.exitCode() == 0) {
            String profileId = findLatestForgeProfileId(gameDir, forgeVersion);
            IpcLogBridge.installPhaseComplete("forge", "run-installer", "Forge installer succeeded on first attempt");
            return new ForgeInstallResult(forgeVersion, profileId, installerPath, firstResult.exitCode(), firstResult.output());
        }

        IpcLogBridge.installPhaseStart("forge", "fallback-installer", "Retry forge installer with fallback args");
        ProcessBuilder fallbackAttempt = new ProcessBuilder(
                javaPath,
                "-jar",
                installerPath.toString(),
                "--installClient"
        );
        fallbackAttempt.directory(gameDir.toFile());
        ProcessResult fallbackResult = runProcess(fallbackAttempt);
        if (fallbackResult.exitCode() != 0) {
            IpcLogBridge.installError("forge", "run-installer", "Forge installer failed after fallback attempt");
            throw new IOException("Forge installer failed. first=" + firstResult.output() + " fallback=" + fallbackResult.output());
        }

        String profileId = findLatestForgeProfileId(gameDir, forgeVersion);
        IpcLogBridge.installPhaseComplete("forge", "fallback-installer", "Forge installer succeeded with fallback args");
        return new ForgeInstallResult(forgeVersion, profileId, installerPath, fallbackResult.exitCode(), fallbackResult.output());
    }

    private void ensureLauncherProfiles(Path gameDir) throws IOException {
        Path launcherProfiles = gameDir.resolve("launcher_profiles.json");
        if (Files.exists(launcherProfiles)) {
            return;
        }

        String json = """
                {
                  "profiles": {
                    "FPSMaster": {
                      "name": "FPSMaster",
                      "type": "custom",
                      "lastVersionId": "latest-release"
                    }
                  },
                  "selectedProfile": "FPSMaster",
                  "clientToken": "00000000000000000000000000000000",
                  "authenticationDatabase": {},
                  "settings": {},
                  "version": 3
                }
                """;
        Files.writeString(launcherProfiles, json);
    }

    private ForgeInstallResult installForgeOldProfile(Path gameDir, String forgeVersion, Path installerPath, JsonObject installProfile) throws IOException {
        JsonObject install = installProfile.getAsJsonObject("install");
        JsonObject versionInfo = installProfile.getAsJsonObject("versionInfo");
        if (install == null || versionInfo == null) {
            throw new IOException("Old forge installer is missing install or versionInfo block");
        }

        String filePath = install.get("filePath").getAsString();
        String pathDescriptor = install.get("path").getAsString();

        MavenArtifact artifact = MavenArtifact.parse(pathDescriptor);
        Path targetLibrary = gameDir.resolve("libraries").resolve(artifact.jarPath());
        Files.createDirectories(targetLibrary.getParent());

        try (ZipFile zip = new ZipFile(installerPath.toFile())) {
            ZipEntry universalEntry = zip.getEntry(filePath);
            if (universalEntry == null) {
                throw new IOException("Old forge installer universal jar not found: " + filePath);
            }
            Files.copy(zip.getInputStream(universalEntry), targetLibrary, StandardCopyOption.REPLACE_EXISTING);
        }

        String versionId = versionInfo.get("id").getAsString();
        Path versionDir = gameDir.resolve("versions").resolve(versionId);
        Files.createDirectories(versionDir);
        Path versionJsonPath = versionDir.resolve(versionId + ".json");
        Files.writeString(versionJsonPath, versionInfo.toString());
        IpcLogBridge.installPhaseComplete("forge", "legacy-profile", "Forge legacy profile installed");

        return new ForgeInstallResult(
                forgeVersion,
                versionId,
                installerPath,
                0,
                "Installed with legacy forge installer profile"
        );
    }

    private String findLatestForgeProfileId(Path gameDir, String forgeVersion) throws IOException {
        Path versionsDir = gameDir.resolve("versions");
        if (!Files.isDirectory(versionsDir)) {
            throw new IOException("Forge installation finished but versions directory is missing");
        }

        String[] versionParts = forgeVersion.split("-", 2);
        String gameVersion = versionParts.length > 0 ? versionParts[0] : forgeVersion;

        try (var stream = Files.list(versionsDir)) {
            return stream
                    .filter(Files::isDirectory)
                    .map(path -> path.getFileName().toString())
                    .filter(name -> name.contains("forge") && name.contains(gameVersion))
                    .max(String::compareTo)
                    .orElseThrow(() -> new IOException("Forge profile not found after installer run"));
        }
    }


    private ForgeInstallerProfile inspectInstaller(Path installerPath) throws IOException {
        try (ZipFile zip = new ZipFile(installerPath.toFile())) {
            ZipEntry profileEntry = zip.getEntry("install_profile.json");
            if (profileEntry == null) {
                throw new IOException("forge installer missing install_profile.json");
            }
            String profileText = new String(zip.getInputStream(profileEntry).readAllBytes());
            JsonObject installProfile = JsonParser.parseString(profileText).getAsJsonObject();
            boolean newStyle = installProfile.has("spec");
            return new ForgeInstallerProfile(newStyle, installProfile);
        }
    }

    private ProcessResult runProcess(ProcessBuilder builder) throws IOException, InterruptedException {
        Process process = builder.redirectErrorStream(true).start();
        String output = new String(process.getInputStream().readAllBytes());
        int exitCode = process.waitFor();
        return new ProcessResult(exitCode, output);
    }

    private void downloadFile(String url, Path target, String expectedSha1) throws IOException, InterruptedException {
        Files.createDirectories(target.getParent());

        if (Files.isRegularFile(target) && expectedSha1 != null) {
            String localSha1 = Sha1Utils.sha1(target);
            if (expectedSha1.equalsIgnoreCase(localSha1)) {
                return;
            }
        }

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

    private JsonObject getJsonObject(String url) throws IOException, InterruptedException {
        return JsonParser.parseString(getText(url)).getAsJsonObject();
    }

    private JsonArray getJsonArray(String url) throws IOException, InterruptedException {
        return JsonParser.parseString(getText(url)).getAsJsonArray();
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

    private String normalizeBaseUrl(String url) {
        return url.endsWith("/") ? url : (url + "/");
    }

    public record FabricInstallResult(String profileId, Path profilePath, int librariesDownloaded) {
    }

    public record ForgeInstallResult(String forgeVersion, String profileId, Path installerPath, int exitCode, String installerOutput) {
    }

    private record ProcessResult(int exitCode, String output) {
    }

    private record ForgeInstallerProfile(boolean newStyle, JsonObject installProfile) {
    }

    private static final class MavenArtifact {
        private final String group;
        private final String artifact;
        private final String version;
        private final String fileName;

        private MavenArtifact(String group, String artifact, String version, String fileName) {
            this.group = group;
            this.artifact = artifact;
            this.version = version;
            this.fileName = fileName;
        }

        static MavenArtifact parse(String descriptor) {
            String normalized = descriptor;
            String extension = "jar";
            int at = normalized.indexOf('@');
            if (at >= 0) {
                extension = normalized.substring(at + 1);
                normalized = normalized.substring(0, at);
            }

            String classifier = null;
            String[] parts = normalized.split(":");
            if (parts.length < 3) {
                throw new IllegalArgumentException("Invalid maven descriptor: " + descriptor);
            }

            if (parts.length >= 4) {
                classifier = parts[3];
            }

            String group = parts[0];
            String artifact = parts[1];
            String version = parts[2];
            String file = classifier == null
                    ? artifact + "-" + version + "." + extension
                    : artifact + "-" + version + "-" + classifier + "." + extension;

            return new MavenArtifact(group, artifact, version, file);
        }

        String jarPath() {
            return group.replace('.', '/') + "/" + artifact + "/" + version + "/" + fileName;
        }

    }
}
