package com.fpsmaster.launcher.core;

import java.util.List;

public enum DownloadSource {
    OFFICIAL("official"),
    BMCLAPI("bmclapi");

    private static final String BMCLAPI_ROOT = "https://bmclapi2.bangbang93.com";

    private final String id;

    DownloadSource(String id) {
        this.id = id;
    }

    public String id() {
        return id;
    }

    public static DownloadSource fromId(String raw) {
        if (raw == null || raw.isBlank()) {
            return OFFICIAL;
        }

        return switch (raw.trim().toLowerCase()) {
            case "official", "mojang" -> OFFICIAL;
            case "bmclapi", "mirror" -> BMCLAPI;
            default -> throw new IllegalArgumentException("Unsupported download source: " + raw);
        };
    }

    public String versionManifestUrl() {
        return switch (this) {
            case OFFICIAL -> "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
            case BMCLAPI -> BMCLAPI_ROOT + "/mc/game/version_manifest_v2.json";
        };
    }

    public String fabricLoaderApiBase() {
        return switch (this) {
            case OFFICIAL -> "https://meta.fabricmc.net/v2/versions/loader";
            case BMCLAPI -> BMCLAPI_ROOT + "/fabric-meta/v2/versions/loader";
        };
    }

    public String forgeMavenMetadataUrl() {
        return forgeMavenBase() + "/net/minecraftforge/forge/maven-metadata.xml";
    }

    public String forgeMavenBase() {
        return switch (this) {
            case OFFICIAL -> "https://maven.minecraftforge.net";
            case BMCLAPI -> BMCLAPI_ROOT + "/maven";
        };
    }

    public String forgeInstallerBase() {
        return forgeMavenBase() + "/net/minecraftforge/forge/";
    }

    public String forgeVersionListUrl(String gameVersion) {
        return switch (this) {
            case OFFICIAL -> forgeMavenMetadataUrl();
            case BMCLAPI -> BMCLAPI_ROOT + "/forge/minecraft/" + normalizeForgeLookupVersion(gameVersion);
        };
    }

    public String defaultLibraryRepo() {
        return switch (this) {
            case OFFICIAL -> "https://libraries.minecraft.net/";
            case BMCLAPI -> BMCLAPI_ROOT + "/libraries/";
        };
    }

    public String defaultAssetRepo() {
        return switch (this) {
            case OFFICIAL -> "https://resources.download.minecraft.net/";
            case BMCLAPI -> BMCLAPI_ROOT + "/assets/";
        };
    }

    public String fabricMavenRepo() {
        return switch (this) {
            case OFFICIAL -> "https://maven.fabricmc.net/";
            case BMCLAPI -> BMCLAPI_ROOT + "/maven/";
        };
    }

    public String assetObjectUrl(String hash) {
        return defaultAssetRepo() + hash.substring(0, 2) + "/" + hash;
    }

    public List<String> assetObjectCandidates(String hash) {
        String official = OFFICIAL.assetObjectUrl(hash);
        if (this == OFFICIAL) {
            return List.of(official);
        }
        String preferred = assetObjectUrl(hash);
        if (preferred.equals(official)) {
            return List.of(official);
        }
        return List.of(preferred, official);
    }

    public String forgeInstallerUrl(String gameVersion, String forgeVersion) {
        return switch (this) {
            case OFFICIAL -> forgeInstallerBase() + forgeVersion + "/forge-" + forgeVersion + "-installer.jar";
            case BMCLAPI -> {
                String prefix = gameVersion + "-";
                String remainder = forgeVersion.startsWith(prefix) ? forgeVersion.substring(prefix.length()) : forgeVersion;
                String version = remainder;
                String branch = "";
                int branchDelimiter = remainder.indexOf('-');
                if (branchDelimiter >= 0) {
                    version = remainder.substring(0, branchDelimiter);
                    branch = remainder.substring(branchDelimiter + 1);
                }

                StringBuilder builder = new StringBuilder(BMCLAPI_ROOT)
                        .append("/forge/download?mcversion=")
                        .append(gameVersion)
                        .append("&version=")
                        .append(version)
                        .append("&category=installer&format=jar");
                if (!branch.isBlank()) {
                    builder.append("&branch=").append(branch);
                }
                yield builder.toString();
            }
        };
    }

    public String rewriteUrl(String url) {
        if (url == null || url.isBlank() || this == OFFICIAL) {
            return url;
        }

        return rewriteBmclapi(url);
    }

    public List<String> candidateUrls(String url) {
        if (url == null || url.isBlank()) {
            return List.of();
        }
        if (this == OFFICIAL) {
            return List.of(url);
        }

        String rewritten = rewriteUrl(url);
        if (rewritten.equals(url)) {
            return List.of(url);
        }
        return List.of(rewritten, url);
    }

    private static String rewriteBmclapi(String url) {
        String rewritten = url;
        rewritten = replacePrefixIfMatched(rewritten, "https://bmclapi2.bangbang93.com", BMCLAPI_ROOT);
        rewritten = replacePrefixIfMatched(rewritten, "https://launchermeta.mojang.com", BMCLAPI_ROOT);
        rewritten = replacePrefixIfMatched(rewritten, "https://piston-meta.mojang.com", BMCLAPI_ROOT);
        rewritten = replacePrefixIfMatched(rewritten, "https://piston-data.mojang.com", BMCLAPI_ROOT);
        rewritten = replacePrefixIfMatched(rewritten, "https://launcher.mojang.com", BMCLAPI_ROOT);
        rewritten = replacePrefixIfMatched(rewritten, "https://libraries.minecraft.net", BMCLAPI_ROOT + "/libraries");
        rewritten = replacePrefixIfMatched(rewritten, "https://resources.download.minecraft.net", BMCLAPI_ROOT + "/assets");
        rewritten = replacePrefixIfMatched(rewritten, "http://files.minecraftforge.net/maven", BMCLAPI_ROOT + "/maven");
        rewritten = replacePrefixIfMatched(rewritten, "https://files.minecraftforge.net/maven", BMCLAPI_ROOT + "/maven");
        rewritten = replacePrefixIfMatched(rewritten, "https://maven.minecraftforge.net", BMCLAPI_ROOT + "/maven");
        rewritten = replacePrefixIfMatched(rewritten, "https://meta.fabricmc.net", BMCLAPI_ROOT + "/fabric-meta");
        rewritten = replacePrefixIfMatched(rewritten, "https://maven.fabricmc.net", BMCLAPI_ROOT + "/maven");
        return rewritten;
    }

    private static String replacePrefixIfMatched(String url, String prefix, String replacement) {
        if (url.startsWith(prefix)) {
            return replacement + url.substring(prefix.length());
        }
        return url;
    }

    private static String normalizeForgeLookupVersion(String gameVersion) {
        if ("1.7.10-pre4".equals(gameVersion)) {
            return "1.7.10_pre4";
        }
        return gameVersion;
    }
}
