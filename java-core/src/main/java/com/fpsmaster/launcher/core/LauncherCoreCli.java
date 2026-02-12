package com.fpsmaster.launcher.core;

import com.google.gson.Gson;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class LauncherCoreCli {
    private static final Gson GSON = new Gson();

    private LauncherCoreCli() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            printUsage();
            return;
        }

        MinecraftCoreService service = new MinecraftCoreService();
        ModLoaderService modLoaderService = new ModLoaderService();
        String command = args[0];

        switch (command) {
            case "list-versions" -> {
                List<String> versions = service.listVanillaVersions();
                System.out.println(GSON.toJson(versions));
            }
            case "install-vanilla" -> {
                Map<String, String> options = parseOptions(args);
                Path gameDir = requiredPath(options, "--game-dir");
                String versionId = required(options, "--version");
                MinecraftCoreService.InstallResult result = service.installVanilla(gameDir, versionId);
                System.out.println(GSON.toJson(result));
            }
            case "build-launch-plan" -> {
                Map<String, String> options = parseOptions(args);
                Path gameDir = requiredPath(options, "--game-dir");
                String versionId = required(options, "--version");
                String playerName = options.getOrDefault("--player", "Player");
                String uuid = options.getOrDefault("--uuid", "00000000-0000-0000-0000-000000000000");
                String token = options.getOrDefault("--access-token", "offline");
                Path javaPath = options.containsKey("--java")
                        ? Path.of(options.get("--java"))
                        : gameDir.resolve("runtime").resolve("bin").resolve(OsUtils.javaExecutableName());
                int maxMemory = Integer.parseInt(options.getOrDefault("--max-memory", "4096"));

                MinecraftCoreService.LaunchRequest request = new MinecraftCoreService.LaunchRequest(
                        gameDir,
                        versionId,
                        playerName,
                        uuid,
                        token,
                        javaPath,
                        maxMemory
                );
                MinecraftCoreService.LaunchPlan result = service.buildVanillaLaunchPlan(request);
                System.out.println(GSON.toJson(result));
            }
            case "list-fabric-loaders" -> {
                Map<String, String> options = parseOptions(args);
                String gameVersion = required(options, "--game-version");
                System.out.println(GSON.toJson(modLoaderService.listFabricLoaderVersions(gameVersion)));
            }
            case "install-fabric" -> {
                Map<String, String> options = parseOptions(args);
                Path gameDir = requiredPath(options, "--game-dir");
                String gameVersion = required(options, "--game-version");
                String loaderVersion = required(options, "--loader-version");
                System.out.println(GSON.toJson(modLoaderService.installFabric(gameDir, gameVersion, loaderVersion)));
            }
            case "list-forge-versions" -> {
                Map<String, String> options = parseOptions(args);
                String gameVersion = required(options, "--game-version");
                System.out.println(GSON.toJson(modLoaderService.listForgeVersions(gameVersion)));
            }
            case "install-forge" -> {
                Map<String, String> options = parseOptions(args);
                Path gameDir = requiredPath(options, "--game-dir");
                String forgeVersion = required(options, "--forge-version");
                String javaPath = options.getOrDefault("--java", "java");
                System.out.println(GSON.toJson(modLoaderService.installForge(gameDir, forgeVersion, javaPath)));
            }
            default -> throw new IllegalArgumentException("Unknown command: " + command);
        }
    }

    private static String required(Map<String, String> options, String key) {
        String value = options.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing required option: " + key);
        }
        return value;
    }

    private static Path requiredPath(Map<String, String> options, String key) {
        return Path.of(required(options, key));
    }

    private static Map<String, String> parseOptions(String[] args) {
        Map<String, String> options = new HashMap<>();
        for (int i = 1; i < args.length; i++) {
            String token = args[i];
            if (!token.startsWith("--")) {
                continue;
            }
            if (i + 1 >= args.length) {
                throw new IllegalArgumentException("Option requires value: " + token);
            }
            options.put(token, args[++i]);
        }
        return options;
    }

    private static void printUsage() {
        System.out.println("FPSMaster Launcher Core CLI");
        System.out.println("Commands:");
        System.out.println("  list-versions");
        System.out.println("  install-vanilla --game-dir <path> --version <id>");
        System.out.println("  build-launch-plan --game-dir <path> --version <id> [--player <name>] [--uuid <uuid>] [--access-token <token>] [--java <path>] [--max-memory <mb>]");
        System.out.println("  list-fabric-loaders --game-version <id>");
        System.out.println("  install-fabric --game-dir <path> --game-version <id> --loader-version <id>");
        System.out.println("  list-forge-versions --game-version <id>");
        System.out.println("  install-forge --game-dir <path> --forge-version <minecraft-forge-version> [--java <path>]");
    }
}
