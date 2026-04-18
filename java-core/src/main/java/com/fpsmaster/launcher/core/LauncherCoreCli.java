package com.fpsmaster.launcher.core;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSerializer;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class LauncherCoreCli {
    private static final Gson GSON = new GsonBuilder()
            .registerTypeHierarchyAdapter(Path.class, (JsonSerializer<Path>) (src, typeOfSrc, context) -> new JsonPrimitive(src.toString()))
            .create();

    private LauncherCoreCli() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0) {
            printUsage();
            return;
        }

        String command = args[0];
        Map<String, String> options = parseOptions(args);
        MinecraftCoreService service = new MinecraftCoreService(parseDownloadThreads(options));
        IpcLogBridge.setSessionId(options.get("--ipc-session"));
        try {
            DownloadSource downloadSource = parseDownloadSource(options);
            switch (command) {
                case "list-versions" -> {
                    List<String> versions = service.listVanillaVersions(downloadSource);
                    System.out.println(GSON.toJson(versions));
                }
                case "install-vanilla" -> {
                    Path gameDir = requiredPath(options, "--game-dir");
                    String versionId = required(options, "--version");
                    MinecraftCoreService.InstallResult result = service.installVanilla(gameDir, versionId, downloadSource);
                    System.out.println(GSON.toJson(result));
                }
                case "build-launch-plan" -> {
                    MinecraftCoreService.LaunchRequest request = buildLaunchRequest(options);
                    MinecraftCoreService.LaunchPlan result = service.buildVanillaLaunchPlan(request, downloadSource);
                    System.out.println(GSON.toJson(result));
                }
                case "launch-vanilla" -> {
                    MinecraftCoreService.LaunchRequest request = buildLaunchRequest(options);
                    boolean wait = isFlagEnabled(options, "--wait");
                    MinecraftCoreService.LaunchExecutionResult result = service.launchVanilla(request, wait, downloadSource);
                    System.out.println(GSON.toJson(result));
                }
                case "resolve-java-major" -> {
                    String versionId = required(options, "--version");
                    MinecraftCoreService.JavaRuntimeRequirement result;
                    if (options.containsKey("--game-dir")) {
                        result = service.resolveJavaRuntimeRequirement(requiredPath(options, "--game-dir"), versionId, downloadSource);
                    } else {
                        result = service.resolveJavaRuntimeRequirement(null, versionId, downloadSource);
                    }
                    System.out.println(GSON.toJson(result));
                }
                case "list-fabric-loaders" -> {
                    String gameVersion = required(options, "--game-version");
                    System.out.println(GSON.toJson(service.listFabricLoaderVersions(gameVersion, downloadSource)));
                }
                case "install-fabric" -> {
                    Path gameDir = requiredPath(options, "--game-dir");
                    String gameVersion = required(options, "--game-version");
                    String loaderVersion = required(options, "--loader-version");
                    System.out.println(GSON.toJson(service.installFabric(gameDir, gameVersion, loaderVersion, downloadSource)));
                }
                case "list-forge-versions" -> {
                    String gameVersion = required(options, "--game-version");
                    System.out.println(GSON.toJson(service.listForgeVersions(gameVersion, downloadSource)));
                }
                case "install-forge" -> {
                    Path gameDir = requiredPath(options, "--game-dir");
                    String forgeVersion = required(options, "--forge-version");
                    String javaPath = options.getOrDefault("--java", "java");
                    String gameVersion = forgeVersion.split("-", 2)[0];
                    System.out.println(GSON.toJson(service.installForge(gameDir, gameVersion, forgeVersion, Path.of(javaPath), downloadSource)));
                }
                case "launch-forge" -> {
                    MinecraftCoreService.LaunchRequest request = buildLaunchRequest(options);
                    boolean wait = isFlagEnabled(options, "--wait");
                    MinecraftCoreService.LaunchExecutionResult result = service.launchVanilla(request, wait, downloadSource);
                    System.out.println(GSON.toJson(result));
                }
                default -> throw new IllegalArgumentException("Unknown command: " + command);
            }
        } catch (Exception e) {
            String phase = switch (command) {
                case "install-vanilla" -> "vanilla";
                case "install-fabric" -> "fabric";
                case "install-forge" -> "forge";
                default -> null;
            };
            if (phase != null) {
                IpcLogBridge.installError(phase, "failed", e.getMessage());
            }
            throw e;
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
            if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
                options.put(token, "true");
                continue;
            }
            options.put(token, args[++i]);
        }
        return options;
    }

    private static boolean isFlagEnabled(Map<String, String> options, String key) {
        return options.containsKey(key) && Boolean.parseBoolean(options.get(key));
    }

    private static DownloadSource parseDownloadSource(Map<String, String> options) {
        return DownloadSource.fromId(options.getOrDefault("--download-source", "official"));
    }

    private static int parseDownloadThreads(Map<String, String> options) {
        String raw = options.get("--download-threads");
        if (raw == null || raw.isBlank()) {
            return Runtime.getRuntime().availableProcessors() * 2;
        }
        try {
            return Integer.parseInt(raw.trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Invalid --download-threads: " + raw);
        }
    }

    private static MinecraftCoreService.LaunchRequest buildLaunchRequest(Map<String, String> options) {
        Path gameDir = requiredPath(options, "--game-dir");
        String versionId = required(options, "--version");
        String playerName = options.getOrDefault("--player", "Player");
        String uuid = options.getOrDefault("--uuid", "00000000-0000-0000-0000-000000000000");
        String token = options.getOrDefault("--access-token", "offline");
        Path javaPath = options.containsKey("--java")
                ? Path.of(options.get("--java"))
                : gameDir.resolve("runtime").resolve("bin").resolve(OsUtils.javaExecutableName());
        int maxMemory = Integer.parseInt(options.getOrDefault("--max-memory", "4096"));
        String fpsAuthToken = options.getOrDefault("--fps-auth-token", "");
        String serverAddress = options.getOrDefault("--server", "");

        return new MinecraftCoreService.LaunchRequest(
                gameDir,
                versionId,
                playerName,
                uuid,
                token,
                javaPath,
                maxMemory,
                fpsAuthToken,
                serverAddress
        );
    }

    private static void printUsage() {
        System.out.println("FPSMaster Launcher Core CLI");
        System.out.println("Commands:");
        System.out.println("  list-versions [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  install-vanilla --game-dir <path> --version <id> [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  build-launch-plan --game-dir <path> --version <id> [--player <name>] [--uuid <uuid>] [--access-token <token>] [--fps-auth-token <token>] [--java <path>] [--max-memory <mb>] [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  launch-vanilla --game-dir <path> --version <id> [--player <name>] [--uuid <uuid>] [--access-token <token>] [--fps-auth-token <token>] [--java <path>] [--max-memory <mb>] [--wait] [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  resolve-java-major --version <id> [--game-dir <path>] [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  list-fabric-loaders --game-version <id> [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  install-fabric --game-dir <path> --game-version <id> --loader-version <id> [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  list-forge-versions --game-version <id> [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  install-forge --game-dir <path> --forge-version <minecraft-forge-version> [--java <path>] [--download-source <official|bmclapi>] [--download-threads <n>]");
        System.out.println("  launch-forge --game-dir <path> --version <forge-profile-id> [--player <name>] [--uuid <uuid>] [--access-token <token>] [--fps-auth-token <token>] [--java <path>] [--max-memory <mb>] [--wait] [--download-source <official|bmclapi>] [--download-threads <n>]");
    }
}
