package com.fpsmaster.launcher.core;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DownloadSourceTest {

    @Test
    void bmclapiRewritesKnownOfficialEndpoints() {
        assertEquals(
                "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                DownloadSource.BMCLAPI.versionManifestUrl()
        );
        assertEquals(
                "https://bmclapi2.bangbang93.com/libraries/com/example/demo/1.0/demo-1.0.jar",
                DownloadSource.BMCLAPI.rewriteUrl("https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar")
        );
        assertEquals(
                "https://bmclapi2.bangbang93.com/assets/ab/abcdef",
                DownloadSource.BMCLAPI.assetObjectUrl("abcdef")
        );
        assertEquals(
                "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1",
                DownloadSource.BMCLAPI.rewriteUrl("https://meta.fabricmc.net/v2/versions/loader/1.20.1")
        );
        assertEquals(
                "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.xml",
                DownloadSource.BMCLAPI.forgeMavenMetadataUrl()
        );
    }

    @Test
    void officialLeavesUrlsUntouched() {
        String url = "https://libraries.minecraft.net/com/example/demo/1.0/demo-1.0.jar";
        assertEquals(url, DownloadSource.OFFICIAL.rewriteUrl(url));
    }

    @Test
    void aliasesResolveToExpectedSources() {
        assertEquals(DownloadSource.OFFICIAL, DownloadSource.fromId("mojang"));
        assertEquals(DownloadSource.BMCLAPI, DownloadSource.fromId("mirror"));
    }
}
