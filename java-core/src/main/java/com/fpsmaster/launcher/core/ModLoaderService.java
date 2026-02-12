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

public final class ModLoaderService {
    private static final String FABRIC_META = "https://meta.fabricmc.net";
    private static final String FORGE_MAVEN = "https://maven.minecraftforge.net";

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

        String installerName = "forge-" + forgeVersion + "-installer.jar";
        String artifactBase = FORGE_MAVEN + "/net/minecraftforge/forge/" + forgeVersion + "/";
        String installerUrl = artifactBase + installerName;

        Path installerPath = gameDir.resolve("installers").resolve(installerName);
        downloadFile(installerUrl, installerPath, null);

        ProcessBuilder firstAttempt = new ProcessBuilder(
                javaPath,
                "-jar",
                installerPath.toString(),
                "--installClient",
                "--installDir",
                gameDir.toString()
        );
        ProcessResult firstResult = runProcess(firstAttempt);
        if (firstResult.exitCode() == 0) {
            return new ForgeInstallResult(forgeVersion, installerPath, firstResult.exitCode(), firstResult.output());
        }

        ProcessBuilder fallbackAttempt = new ProcessBuilder(
                javaPath,
                "-jar",
                installerPath.toString(),
                "--installClient"
        );
        fallbackAttempt.directory(gameDir.toFile());
        ProcessResult fallbackResult = runProcess(fallbackAttempt);
        if (fallbackResult.exitCode() != 0) {
            throw new IOException("Forge installer failed. first=" + firstResult.output() + " fallback=" + fallbackResult.output());
        }

        return new ForgeInstallResult(forgeVersion, installerPath, fallbackResult.exitCode(), fallbackResult.output());
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

    public record ForgeInstallResult(String forgeVersion, Path installerPath, int exitCode, String installerOutput) {
    }

    private record ProcessResult(int exitCode, String output) {
    }

    private record MavenArtifact(String group, String artifact, String version) {
        static MavenArtifact parse(String descriptor) {
            String[] parts = descriptor.split(":");
            if (parts.length < 3) {
                throw new IllegalArgumentException("Invalid maven descriptor: " + descriptor);
            }
            return new MavenArtifact(parts[0], parts[1], parts[2]);
        }

        String jarPath() {
            return group.replace('.', '/') + "/" + artifact + "/" + version + "/" + artifact + "-" + version + ".jar";
        }
    }
}
