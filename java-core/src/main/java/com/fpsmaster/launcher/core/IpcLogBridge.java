package com.fpsmaster.launcher.core;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

public final class IpcLogBridge {
    private static final Gson GSON = new Gson();
    private static volatile String sessionId;

    private IpcLogBridge() {
    }

    public static void setSessionId(String session) {
        if (session == null || session.isBlank()) {
            sessionId = null;
            return;
        }
        sessionId = session.trim();
    }

    public static void installPhaseStart(String phase, String stage, String message) {
        emit("phase-start", phase, stage, null, null, null, null, message, null);
    }

    public static void installProgress(
            String phase,
            String stage,
            Integer current,
            Integer total,
            Integer downloaded,
            Integer cached,
            String message
    ) {
        emit("progress", phase, stage, current, total, downloaded, cached, message, null);
    }

    public static void installPhaseComplete(String phase, String stage, String message) {
        emit("phase-complete", phase, stage, null, null, null, null, message, null);
    }

    public static void installError(String phase, String stage, String message) {
        emit("error", phase, stage, null, null, null, null, message, message);
    }

    private static void emit(
            String event,
            String phase,
            String stage,
            Integer current,
            Integer total,
            Integer downloaded,
            Integer cached,
            String message,
            String error
    ) {
        JsonObject payload = new JsonObject();
        payload.addProperty("channel", "install");
        payload.addProperty("event", event);
        payload.addProperty("phase", phase);
        payload.addProperty("stage", stage);
        if (sessionId != null && !sessionId.isBlank()) {
            payload.addProperty("session", sessionId);
        }
        if (current != null) {
            payload.addProperty("current", current);
        }
        if (total != null) {
            payload.addProperty("total", total);
        }
        if (downloaded != null) {
            payload.addProperty("downloaded", downloaded);
        }
        if (cached != null) {
            payload.addProperty("cached", cached);
        }
        if (message != null && !message.isBlank()) {
            payload.addProperty("message", message);
        }
        if (error != null && !error.isBlank()) {
            payload.addProperty("error", error);
        }

        System.err.println("[ipc]" + GSON.toJson(payload));
        System.err.flush();
    }
}
