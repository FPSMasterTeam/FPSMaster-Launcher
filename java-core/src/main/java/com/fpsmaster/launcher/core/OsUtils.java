package com.fpsmaster.launcher.core;

enum OsType {
    WINDOWS,
    LINUX,
    OSX,
    UNKNOWN
}

final class OsUtils {
    private OsUtils() {
    }

    static OsType current() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("win")) {
            return OsType.WINDOWS;
        }
        if (os.contains("mac") || os.contains("darwin")) {
            return OsType.OSX;
        }
        if (os.contains("nix") || os.contains("nux") || os.contains("aix")) {
            return OsType.LINUX;
        }
        return OsType.UNKNOWN;
    }

    static String minecraftOsName() {
        return switch (current()) {
            case WINDOWS -> "windows";
            case LINUX -> "linux";
            case OSX -> "osx";
            default -> "unknown";
        };
    }

    static String classPathSeparator() {
        return current() == OsType.WINDOWS ? ";" : ":";
    }

    static String javaExecutableName() {
        return current() == OsType.WINDOWS ? "javaw.exe" : "java";
    }

    static String archToken() {
        String arch = System.getProperty("os.arch", "").toLowerCase();
        return arch.contains("64") ? "64" : "32";
    }
}
