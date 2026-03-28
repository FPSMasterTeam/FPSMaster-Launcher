package com.fpsmaster.launcher.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MinecraftCoreServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void buildLaunchPlanSkipsFeatureGatedDemoArgByDefault() throws Exception {
        MinecraftCoreService service = new MinecraftCoreService();
        Path versionDir = tempDir.resolve("versions").resolve("test-version");
        Files.createDirectories(versionDir);
        Files.writeString(versionDir.resolve("test-version.jar"), "");

        JsonObject versionJson = new JsonObject();
        versionJson.addProperty("id", "test-version");
        versionJson.addProperty("mainClass", "net.minecraft.client.main.Main");
        versionJson.add("libraries", new JsonArray());

        JsonObject assetIndex = new JsonObject();
        assetIndex.addProperty("id", "test-assets");
        versionJson.add("assetIndex", assetIndex);

        JsonObject arguments = new JsonObject();
        JsonArray jvm = new JsonArray();
        jvm.add("-Djava.library.path");
        jvm.add("${natives_directory}");
        arguments.add("jvm", jvm);

        JsonArray game = new JsonArray();
        game.add(featureFlagArgument("is_demo_user", "--demo"));
        game.add(featureResolutionArgument());
        game.add("--username");
        game.add("${auth_player_name}");
        arguments.add("game", game);

        versionJson.add("arguments", arguments);
        Files.writeString(versionDir.resolve("test-version.json"), versionJson.toString());

        MinecraftCoreService.LaunchPlan plan = service.buildVanillaLaunchPlan(new MinecraftCoreService.LaunchRequest(
                tempDir,
                "test-version",
                "Player",
                "00000000-0000-0000-0000-000000000000",
                "offline",
                Path.of("java"),
                1024
        ));

        assertFalse(plan.command().contains("--demo"));
        assertTrue(plan.command().contains("--username"));
        assertTrue(plan.command().contains("Player"));
    }

    private static JsonObject featureFlagArgument(String featureName, String value) {
        JsonObject argument = new JsonObject();
        JsonArray rules = new JsonArray();
        JsonObject rule = new JsonObject();
        rule.addProperty("action", "allow");
        JsonObject features = new JsonObject();
        features.addProperty(featureName, true);
        rule.add("features", features);
        rules.add(rule);
        argument.add("rules", rules);
        argument.addProperty("value", value);
        return argument;
    }

    private static JsonObject featureResolutionArgument() {
        JsonObject argument = new JsonObject();
        JsonArray rules = new JsonArray();
        JsonObject rule = new JsonObject();
        rule.addProperty("action", "allow");
        JsonObject features = new JsonObject();
        features.addProperty("has_custom_resolution", true);
        rule.add("features", features);
        rules.add(rule);
        argument.add("rules", rules);

        JsonArray values = new JsonArray();
        values.add("--width");
        values.add("${resolution_width}");
        values.add("--height");
        values.add("${resolution_height}");
        argument.add("value", values);
        return argument;
    }
}
