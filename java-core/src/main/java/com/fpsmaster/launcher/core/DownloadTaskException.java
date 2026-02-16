package com.fpsmaster.launcher.core;

import java.io.IOException;
import java.nio.file.Path;

public final class DownloadTaskException extends IOException {
    private final String artifactType;
    private final Path target;
    private final String url;
    private final int attempt;
    private final int maxAttempts;
    private final String reason;
    private final Integer statusCode;

    private DownloadTaskException(
            String artifactType,
            Path target,
            String url,
            int attempt,
            int maxAttempts,
            String reason,
            Integer statusCode,
            Throwable cause
    ) {
        super(buildMessage(artifactType, target, url, attempt, maxAttempts, reason), cause);
        this.artifactType = artifactType;
        this.target = target;
        this.url = url;
        this.attempt = attempt;
        this.maxAttempts = maxAttempts;
        this.reason = reason;
        this.statusCode = statusCode;
    }

    public static DownloadTaskException fromStatusCode(
            String artifactType,
            Path target,
            String url,
            int attempt,
            int maxAttempts,
            int statusCode
    ) {
        return new DownloadTaskException(
                artifactType,
                target,
                url,
                attempt,
                maxAttempts,
                "HTTP " + statusCode,
                statusCode,
                null
        );
    }

    public static DownloadTaskException fromDetail(
            String artifactType,
            Path target,
            String url,
            int attempt,
            int maxAttempts,
            String reason,
            Throwable cause
    ) {
        return new DownloadTaskException(
                artifactType,
                target,
                url,
                attempt,
                maxAttempts,
                reason,
                null,
                cause
        );
    }

    public Integer getStatusCode() {
        return statusCode;
    }

    public String getReason() {
        return reason == null || reason.isBlank() ? "unknown" : reason;
    }

    @SuppressWarnings("unused")
    public String getArtifactType() {
        return artifactType;
    }

    @SuppressWarnings("unused")
    public Path getTarget() {
        return target;
    }

    @SuppressWarnings("unused")
    public String getUrl() {
        return url;
    }

    @SuppressWarnings("unused")
    public int getAttempt() {
        return attempt;
    }

    @SuppressWarnings("unused")
    public int getMaxAttempts() {
        return maxAttempts;
    }

    private static String buildMessage(
            String artifactType,
            Path target,
            String url,
            int attempt,
            int maxAttempts,
            String reason
    ) {
        String name = target != null && target.getFileName() != null
                ? target.getFileName().toString()
                : String.valueOf(target);
        String type = artifactType == null || artifactType.isBlank() ? "artifact" : artifactType;
        String detail = reason == null || reason.isBlank() ? "unknown error" : reason;
        return "Download failed [" + type + "] file=" + name
                + " attempt=" + attempt + "/" + maxAttempts
                + " reason=" + detail
                + " url=" + url;
    }
}
