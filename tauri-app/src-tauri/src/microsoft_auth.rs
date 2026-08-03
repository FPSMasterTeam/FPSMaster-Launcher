use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{describe_http_error, emit_launch_prepare_ipc};

const DEFAULT_MINECRAFT_MICROSOFT_CLIENT_ID: &str = "057064c6-d180-43df-b010-834b4571532f";
const DEFAULT_MINECRAFT_MICROSOFT_REDIRECT_URL: &str = "http://localhost:3389/oauth";
const MINECRAFT_MICROSOFT_SCOPE: &str = "XboxLive.signin offline_access openid profile email";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftAuthConfigStatus {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configuration_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftAccountPayload {
    pub id: String,
    #[serde(rename = "type")]
    pub account_type: String,
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skin_url: Option<String>,
    pub expires_at: i64,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftDeviceLoginStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub expires_at: i64,
    pub interval: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftDeviceLoginPollResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<MinecraftAccountPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftTokenSuccessResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MicrosoftTokenErrorResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxAuthResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XboxDisplayClaims,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxDisplayClaims {
    #[serde(rename = "xui", default)]
    users: Vec<XboxUserClaim>,
}

#[derive(Debug, Clone, Deserialize)]
struct XboxUserClaim {
    #[serde(default)]
    uhs: Option<String>,
    #[serde(default)]
    xid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftLoginResponse {
    access_token: String,
    expires_in: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftProfileResponse {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftSessionProfileResponse {
    #[serde(default)]
    properties: Vec<MinecraftSessionProfileProperty>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftSessionProfileProperty {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftTexturesPayload {
    #[serde(default)]
    textures: MinecraftTextures,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct MinecraftTextures {
    #[serde(rename = "SKIN")]
    skin: Option<MinecraftSkinTexture>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftSkinTexture {
    url: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftEntitlementsResponse {
    #[serde(default)]
    items: Vec<MinecraftEntitlementItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct MinecraftEntitlementItem {
    name: String,
}

#[tauri::command]
pub fn get_minecraft_auth_config() -> MinecraftAuthConfigStatus {
    resolve_minecraft_auth_config_status()
}

#[tauri::command]
pub async fn start_minecraft_device_login() -> Result<MinecraftDeviceLoginStart, String> {
    tauri::async_runtime::spawn_blocking(start_minecraft_device_login_blocking)
        .await
        .map_err(|e| format!("Failed to join Minecraft device login task: {e}"))?
}

#[tauri::command]
pub async fn start_minecraft_browser_login(
    app: tauri::AppHandle,
) -> Result<MinecraftAccountPayload, String> {
    tauri::async_runtime::spawn_blocking(move || start_minecraft_browser_login_blocking(app))
        .await
        .map_err(|e| format!("Failed to join Minecraft browser login task: {e}"))?
}

#[tauri::command]
pub async fn poll_minecraft_device_login(
    device_code: String,
) -> Result<MinecraftDeviceLoginPollResult, String> {
    tauri::async_runtime::spawn_blocking(move || poll_minecraft_device_login_blocking(device_code))
        .await
        .map_err(|e| format!("Failed to join Minecraft device login polling task: {e}"))?
}

#[tauri::command]
pub async fn refresh_minecraft_account(
    refresh_token: String,
    ipc_session: Option<String>,
) -> Result<MinecraftAccountPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_minecraft_account_blocking(refresh_token, ipc_session.as_deref())
    })
    .await
    .map_err(|e| format!("Failed to join Minecraft refresh task: {e}"))?
}

fn resolve_minecraft_auth_config_status() -> MinecraftAuthConfigStatus {
    match resolve_minecraft_client_id() {
        Ok((_, source)) => MinecraftAuthConfigStatus {
            configured: true,
            client_id_source: Some(source),
            configuration_hint: None,
        },
        Err(_) => MinecraftAuthConfigStatus {
            configured: false,
            client_id_source: None,
            configuration_hint: Some(minecraft_auth_configuration_hint()),
        },
    }
}

fn start_minecraft_device_login_blocking() -> Result<MinecraftDeviceLoginStart, String> {
    let (client_id, _) = resolve_minecraft_client_id()?;
    let client = build_minecraft_auth_http_client()?;
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode")
        .form(&[
            ("client_id", client_id.as_str()),
            ("scope", MINECRAFT_MICROSOFT_SCOPE),
        ])
        .send()
        .map_err(|e| format!("Failed to start Microsoft device login: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft device login response: {e}"))?;
    if !status.is_success() {
        return Err(parse_microsoft_error_response(
            status,
            &text,
            "Failed to start Microsoft device login",
        ));
    }
    let payload: MicrosoftDeviceCodeResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Microsoft device login response: {e}"))?;
    let interval = payload.interval.unwrap_or(5).max(1);
    Ok(MinecraftDeviceLoginStart {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload.verification_uri,
        verification_uri_complete: payload.verification_uri_complete,
        expires_in: payload.expires_in,
        expires_at: unix_timestamp_millis().saturating_add(
            i64::try_from(payload.expires_in.saturating_mul(1000)).unwrap_or(i64::MAX),
        ),
        interval,
        message: payload.message,
    })
}

fn start_minecraft_browser_login_blocking(
    app: AppHandle,
) -> Result<MinecraftAccountPayload, String> {
    let (client_id, _) = resolve_minecraft_client_id()?;
    let redirect_url = resolve_minecraft_redirect_url()?;
    let client = build_minecraft_auth_http_client()?;
    let state = create_oauth_random_token(24);
    let code_verifier = create_oauth_random_token(64);
    let code_challenge = create_pkce_code_challenge(&code_verifier);

    let listener = bind_minecraft_redirect_listener(&redirect_url)?;
    let authorize_url =
        build_minecraft_authorize_url(&client_id, &redirect_url, &state, &code_challenge)?;

    let auth_window_label = format!("minecraft-auth-{}", create_oauth_random_token(8));
    let auth_window_data_dir =
        open_minecraft_auth_window(&app, &auth_window_label, authorize_url.as_str())?;
    let code = match wait_for_minecraft_oauth_callback(
        listener,
        &redirect_url,
        &state,
        &app,
        &auth_window_label,
    ) {
        Ok(code) => {
            close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
            code
        }
        Err(error) => {
            close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
            return Err(error);
        }
    };

    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_url.as_str()),
            ("code_verifier", code_verifier.as_str()),
            ("scope", MINECRAFT_MICROSOFT_SCOPE),
        ])
        .send()
        .map_err(|e| format!("Failed to exchange Microsoft authorization code: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft authorization response: {e}"))?;
    if !status.is_success() {
        close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
        return Err(parse_microsoft_error_response(
            status,
            &text,
            "Microsoft browser login failed",
        ));
    }
    let token: MicrosoftTokenSuccessResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Microsoft authorization response: {e}"))?;
    let result = complete_minecraft_microsoft_account(
        &client,
        token.access_token,
        token.refresh_token,
        None,
    );
    close_auth_window(&app, &auth_window_label, Some(&auth_window_data_dir));
    result
}

fn poll_minecraft_device_login_blocking(
    device_code: String,
) -> Result<MinecraftDeviceLoginPollResult, String> {
    let trimmed_device_code = device_code.trim().to_string();
    if trimmed_device_code.is_empty() {
        return Err("Minecraft device code is empty".to_string());
    }
    let (client_id, _) = resolve_minecraft_client_id()?;
    let client = build_minecraft_auth_http_client()?;
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id.as_str()),
            ("device_code", trimmed_device_code.as_str()),
        ])
        .send()
        .map_err(|e| format!("Failed to poll Microsoft device login: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft token response: {e}"))?;
    if status.is_success() {
        let token: MicrosoftTokenSuccessResponse = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to decode Microsoft token response: {e}"))?;
        let account = complete_minecraft_microsoft_account(
            &client,
            token.access_token,
            token.refresh_token,
            None,
        )?;
        return Ok(MinecraftDeviceLoginPollResult {
            status: "completed".to_string(),
            interval: None,
            account: Some(account),
            error: None,
        });
    }

    let error_response: MicrosoftTokenErrorResponse = serde_json::from_str(&text).map_err(|e| {
        format!(
            "{} ({e})",
            parse_microsoft_error_response(status, &text, "Failed to poll Microsoft device login")
        )
    })?;
    let error_code = error_response.error.trim().to_ascii_lowercase();
    let error_text = normalize_microsoft_error_description(
        error_response.error_description.as_deref(),
        "Microsoft device login has not completed yet.",
    );
    match error_code.as_str() {
        "authorization_pending" => Ok(MinecraftDeviceLoginPollResult {
            status: "pending".to_string(),
            interval: Some(5),
            account: None,
            error: Some(error_text),
        }),
        "slow_down" => Ok(MinecraftDeviceLoginPollResult {
            status: "slow_down".to_string(),
            interval: Some(8),
            account: None,
            error: Some(error_text),
        }),
        "authorization_declined" | "access_denied" => Ok(MinecraftDeviceLoginPollResult {
            status: "denied".to_string(),
            interval: None,
            account: None,
            error: Some(normalize_microsoft_error_description(
                error_response.error_description.as_deref(),
                "Microsoft device login was cancelled.",
            )),
        }),
        "expired_token" | "bad_verification_code" => Ok(MinecraftDeviceLoginPollResult {
            status: "expired".to_string(),
            interval: None,
            account: None,
            error: Some(normalize_microsoft_error_description(
                error_response.error_description.as_deref(),
                "Microsoft device login code expired. Please start again.",
            )),
        }),
        _ => Err(format!(
            "Microsoft device login failed: {}",
            normalize_microsoft_error_description(
                error_response.error_description.as_deref(),
                &error_response.error
            )
        )),
    }
}

fn refresh_minecraft_account_blocking(
    refresh_token: String,
    ipc_session: Option<&str>,
) -> Result<MinecraftAccountPayload, String> {
    let trimmed_refresh_token = refresh_token.trim().to_string();
    if trimmed_refresh_token.is_empty() {
        return Err("Minecraft refresh token is empty".to_string());
    }
    let (client_id, _) = resolve_minecraft_client_id()?;
    let client = build_minecraft_auth_http_client()?;
    emit_launch_prepare_ipc(
        ipc_session,
        "progress",
        "login",
        "microsoft",
        Some(1),
        Some(5),
        "Refreshing Microsoft login...",
        None,
    );
    let response = client
        .post("https://login.microsoftonline.com/consumers/oauth2/v2.0/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", trimmed_refresh_token.as_str()),
            ("scope", MINECRAFT_MICROSOFT_SCOPE),
        ])
        .send()
        .map_err(|e| format!("Failed to refresh Microsoft login: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Microsoft refresh response: {e}"))?;
    if !status.is_success() {
        let fallback = "Microsoft premium account refresh failed. Please sign in again.";
        let error = serde_json::from_str::<MicrosoftTokenErrorResponse>(&text)
            .ok()
            .map(|value| {
                normalize_microsoft_error_description(value.error_description.as_deref(), fallback)
            })
            .unwrap_or_else(|| parse_microsoft_error_response(status, &text, fallback));
        return Err(error);
    }
    let token: MicrosoftTokenSuccessResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Microsoft refresh response: {e}"))?;
    complete_minecraft_microsoft_account(
        &client,
        token.access_token,
        token.refresh_token.or(Some(trimmed_refresh_token)),
        ipc_session,
    )
}

fn complete_minecraft_microsoft_account(
    client: &reqwest::blocking::Client,
    microsoft_access_token: String,
    refresh_token: Option<String>,
    ipc_session: Option<&str>,
) -> Result<MinecraftAccountPayload, String> {
    emit_launch_prepare_ipc(
        ipc_session,
        "progress",
        "login",
        "xbox",
        Some(2),
        Some(5),
        "Authenticating with Xbox Live...",
        None,
    );
    let xbox_response = client
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&serde_json::json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={microsoft_access_token}"),
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
        }))
        .send()
        .map_err(|e| format!("Failed to authenticate with Xbox Live: {}", describe_http_error(&e)))?;
    let xbox_status = xbox_response.status();
    let xbox_text = xbox_response
        .text()
        .map_err(|e| format!("Failed to read Xbox Live authentication response: {e}"))?;
    if !xbox_status.is_success() {
        return Err(parse_microsoft_error_response(
            xbox_status,
            &xbox_text,
            "Xbox Live authentication failed",
        ));
    }
    let xbox_payload: XboxAuthResponse = serde_json::from_str(&xbox_text)
        .map_err(|e| format!("Failed to decode Xbox Live authentication response: {e}"))?;
    let xbox_user = xbox_payload
        .display_claims
        .users
        .into_iter()
        .next()
        .ok_or_else(|| {
            "Xbox Live authentication response did not include a user hash".to_string()
        })?;
    let user_hash = xbox_user
        .uhs
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Xbox Live authentication response did not include a user hash".to_string()
        })?;

    emit_launch_prepare_ipc(
        ipc_session,
        "progress",
        "login",
        "xsts",
        Some(3),
        Some(5),
        "Authorizing XSTS token...",
        None,
    );
    let xsts_response = client
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(&serde_json::json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbox_payload.token],
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT",
        }))
        .send()
        .map_err(|e| format!("Failed to authorize XSTS token: {}", describe_http_error(&e)))?;
    let xsts_status = xsts_response.status();
    let xsts_text = xsts_response
        .text()
        .map_err(|e| format!("Failed to read XSTS response: {e}"))?;
    if !xsts_status.is_success() {
        return Err(parse_microsoft_error_response(
            xsts_status,
            &xsts_text,
            "Minecraft premium account is not eligible for Xbox authorization",
        ));
    }
    let xsts_payload: XboxAuthResponse = serde_json::from_str(&xsts_text)
        .map_err(|e| format!("Failed to decode XSTS response: {e}"))?;
    let xsts_user = xsts_payload
        .display_claims
        .users
        .into_iter()
        .next()
        .unwrap_or(XboxUserClaim {
            uhs: Some(user_hash.clone()),
            xid: None,
        });

    emit_launch_prepare_ipc(
        ipc_session,
        "progress",
        "login",
        "minecraft",
        Some(4),
        Some(5),
        "Signing in to Minecraft Services...",
        None,
    );
    let minecraft_login_response = client
        .post("https://api.minecraftservices.com/authentication/login_with_xbox")
        .json(&serde_json::json!({
            "identityToken": format!("XBL3.0 x={};{}", user_hash, xsts_payload.token),
        }))
        .send()
        .map_err(|e| format!("Failed to sign in to Minecraft Services: {}", describe_http_error(&e)))?;
    let minecraft_login_status = minecraft_login_response.status();
    let minecraft_login_text = minecraft_login_response
        .text()
        .map_err(|e| format!("Failed to read Minecraft Services login response: {e}"))?;
    if !minecraft_login_status.is_success() {
        return Err(parse_microsoft_error_response(
            minecraft_login_status,
            &minecraft_login_text,
            "Minecraft Services login failed",
        ));
    }
    let minecraft_login_payload: MinecraftLoginResponse =
        serde_json::from_str(&minecraft_login_text)
            .map_err(|e| format!("Failed to decode Minecraft Services login response: {e}"))?;

    let entitlements_response = client
        .get("https://api.minecraftservices.com/entitlements/mcstore")
        .bearer_auth(&minecraft_login_payload.access_token)
        .send()
        .map_err(|e| format!("Failed to fetch Minecraft entitlements: {}", describe_http_error(&e)))?;
    let entitlements_status = entitlements_response.status();
    let entitlements_text = entitlements_response
        .text()
        .map_err(|e| format!("Failed to read Minecraft entitlements response: {e}"))?;
    if !entitlements_status.is_success() {
        let fallback = if entitlements_status.as_u16() == 403 {
            "Minecraft Services API access was denied. Make sure this Azure app has been granted Minecraft API access."
        } else {
            "Failed to fetch Minecraft entitlements"
        };
        return Err(parse_microsoft_error_response(
            entitlements_status,
            &entitlements_text,
            fallback,
        ));
    }
    let entitlements_payload: MinecraftEntitlementsResponse =
        serde_json::from_str(&entitlements_text)
            .map_err(|e| format!("Failed to decode Minecraft entitlements response: {e}"))?;
    let has_minecraft_license = entitlements_payload.items.iter().any(|item| {
        let name = item.name.trim();
        name.eq_ignore_ascii_case("product_minecraft")
            || name.eq_ignore_ascii_case("game_minecraft")
    });
    if !has_minecraft_license {
        return Err(
            "This Microsoft account does not own Minecraft Java Edition, or its entitlement is unavailable."
                .to_string(),
        );
    }

    emit_launch_prepare_ipc(
        ipc_session,
        "progress",
        "login",
        "profile",
        Some(5),
        Some(5),
        "Loading Minecraft profile...",
        None,
    );
    let profile_response = client
        .get("https://api.minecraftservices.com/minecraft/profile")
        .bearer_auth(&minecraft_login_payload.access_token)
        .send()
        .map_err(|e| format!("Failed to fetch Minecraft profile: {}", describe_http_error(&e)))?;
    let profile_status = profile_response.status();
    let profile_text = profile_response
        .text()
        .map_err(|e| format!("Failed to read Minecraft profile response: {e}"))?;
    if !profile_status.is_success() {
        let fallback = match profile_status.as_u16() {
            403 => {
                "Minecraft Services API access was denied. Make sure this Azure app has been granted Minecraft API access."
            }
            404 => "This Microsoft account does not have a Minecraft Java Edition profile yet.",
            _ => "Failed to fetch Minecraft profile",
        };
        return Err(parse_microsoft_error_response(
            profile_status,
            &profile_text,
            fallback,
        ));
    }
    let profile_payload: MinecraftProfileResponse = serde_json::from_str(&profile_text)
        .map_err(|e| format!("Failed to decode Minecraft profile response: {e}"))?;
    let skin_url = fetch_minecraft_skin_url(client, &profile_payload.id)
        .ok()
        .flatten();
    let now = unix_timestamp_millis();
    let expires_at = now.saturating_add(
        i64::try_from(minecraft_login_payload.expires_in.saturating_mul(1000)).unwrap_or(i64::MAX),
    );
    Ok(MinecraftAccountPayload {
        id: create_microsoft_account_id(&profile_payload.id),
        account_type: "microsoft".to_string(),
        username: profile_payload.name,
        uuid: profile_payload.id,
        access_token: minecraft_login_payload.access_token,
        refresh_token,
        xuid: xsts_user.xid.filter(|value| !value.trim().is_empty()),
        skin_url,
        expires_at,
        added_at: now,
    })
}

fn fetch_minecraft_skin_url(
    client: &reqwest::blocking::Client,
    uuid: &str,
) -> Result<Option<String>, String> {
    let normalized_uuid = uuid.trim().replace('-', "");
    if normalized_uuid.is_empty() {
        return Ok(None);
    }

    let response = client
        .get(format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{normalized_uuid}"
        ))
        .send()
        .map_err(|e| format!("Failed to fetch Minecraft session profile: {}", describe_http_error(&e)))?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Failed to read Minecraft session profile response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Failed to fetch Minecraft session profile: HTTP {status}"
        ));
    }

    let profile: MinecraftSessionProfileResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to decode Minecraft session profile response: {e}"))?;
    let Some(textures_property) = profile
        .properties
        .into_iter()
        .find(|property| property.name == "textures")
    else {
        return Ok(None);
    };

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(textures_property.value)
        .map_err(|e| format!("Failed to decode Minecraft textures payload: {e}"))?;
    let textures_payload: MinecraftTexturesPayload = serde_json::from_slice(&decoded)
        .map_err(|e| format!("Failed to parse Minecraft textures payload: {e}"))?;

    Ok(textures_payload
        .textures
        .skin
        .map(|skin| skin.url)
        .filter(|url| !url.trim().is_empty()))
}

fn resolve_minecraft_redirect_url() -> Result<String, String> {
    if let Some(value) = read_runtime_env("FPSMASTER_MINECRAFT_REDIRECT_URL") {
        return validate_minecraft_redirect_url(&value);
    }
    if let Some(value) = read_runtime_env("MICROSOFT_REDIRECT_URL") {
        return validate_minecraft_redirect_url(&value);
    }
    if let Some(value) = option_env!("FPSMASTER_MINECRAFT_REDIRECT_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return validate_minecraft_redirect_url(value);
    }
    if let Some(value) = option_env!("MICROSOFT_REDIRECT_URL")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return validate_minecraft_redirect_url(value);
    }
    validate_minecraft_redirect_url(DEFAULT_MINECRAFT_MICROSOFT_REDIRECT_URL)
}

fn validate_minecraft_redirect_url(raw: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(raw.trim())
        .map_err(|e| format!("Invalid Minecraft redirect URL: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Minecraft redirect URL must use http or https".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Minecraft redirect URL must include a host".to_string());
    }
    Ok(parsed.to_string())
}

fn bind_minecraft_redirect_listener(redirect_url: &str) -> Result<TcpListener, String> {
    let parsed = reqwest::Url::parse(redirect_url)
        .map_err(|e| format!("Invalid Minecraft redirect URL: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Minecraft redirect URL is missing host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Minecraft redirect URL is missing port".to_string())?;
    let bind_target = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_target).map_err(|e| {
        let kind = e.kind();
        if matches!(
            kind,
            std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
        ) {
            format!(
                "Cannot bind the Microsoft OAuth callback listener on {bind_target} ({e}). \
                 The port is already in use (port {port} is the Windows Remote Desktop port by default). \
                 Override the redirect URL by setting the FPSMASTER_MINECRAFT_REDIRECT_URL environment \
                 variable to e.g. http://localhost:43289/oauth, then make sure the same redirect URI is \
                 registered in your Microsoft Entra application."
            )
        } else {
            format!("Failed to bind Minecraft OAuth redirect listener on {bind_target}: {e}")
        }
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Failed to configure Minecraft OAuth redirect listener: {e}"))?;
    Ok(listener)
}

fn build_minecraft_authorize_url(
    client_id: &str,
    redirect_url: &str,
    state: &str,
    code_challenge: &str,
) -> Result<reqwest::Url, String> {
    let mut url =
        reqwest::Url::parse("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize")
            .map_err(|e| format!("Failed to prepare Microsoft authorize URL: {e}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_url)
        .append_pair("response_mode", "query")
        .append_pair("scope", MINECRAFT_MICROSOFT_SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

fn wait_for_minecraft_oauth_callback(
    listener: TcpListener,
    redirect_url: &str,
    expected_state: &str,
    app: &AppHandle,
    auth_window_label: &str,
) -> Result<String, String> {
    let redirect_base = reqwest::Url::parse(redirect_url)
        .map_err(|e| format!("Invalid Minecraft redirect URL: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        if app.get_webview_window(auth_window_label).is_none() {
            return Err(
                "Microsoft login window was closed before authentication completed.".to_string(),
            );
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for Microsoft browser login callback".to_string());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut request_line = String::new();
                {
                    let mut reader = BufReader::new(&mut stream);
                    reader.read_line(&mut request_line).map_err(|e| {
                        format!("Failed to read Microsoft OAuth callback request: {e}")
                    })?;
                }
                let path = request_line.split_whitespace().nth(1).ok_or_else(|| {
                    "Microsoft OAuth callback request line is invalid".to_string()
                })?;
                let callback_url = reqwest::Url::parse(&format!(
                    "{}://{}{}",
                    redirect_base.scheme(),
                    redirect_base
                        .host_str()
                        .ok_or_else(|| "Minecraft redirect URL is missing host".to_string())?,
                    if let Some(port) = redirect_base.port() {
                        format!(":{port}{path}")
                    } else {
                        path.to_string()
                    }
                ))
                .or_else(|_| reqwest::Url::parse(&format!("http://callback{path}")))
                .map_err(|e| format!("Failed to parse Microsoft OAuth callback URL: {e}"))?;

                let query: HashMap<String, String> =
                    callback_url.query_pairs().into_owned().collect();
                if let Some(error) = query.get("error") {
                    let description = query
                        .get("error_description")
                        .map(String::as_str)
                        .unwrap_or(error);
                    let message = normalize_microsoft_error_description(
                        Some(description),
                        "Microsoft login was cancelled.",
                    );
                    let _ = write_browser_callback_page(
                        &mut stream,
                        400,
                        "Microsoft login failed",
                        &message,
                    );
                    return Err(message);
                }
                let returned_state = query.get("state").map(String::as_str).unwrap_or_default();
                if returned_state != expected_state {
                    let message =
                        "Microsoft login callback state did not match the launcher session.";
                    let _ = write_browser_callback_page(
                        &mut stream,
                        400,
                        "Microsoft login failed",
                        message,
                    );
                    return Err(message.to_string());
                }
                let code = query.get("code").cloned().ok_or_else(|| {
                    "Microsoft login callback did not contain an authorization code".to_string()
                })?;
                let _ = write_browser_callback_page(
                    &mut stream,
                    200,
                    "Microsoft login completed",
                    "You can return to FPSMaster Launcher now.",
                );
                return Ok(code);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(150));
            }
            Err(error) => {
                return Err(format!(
                    "Failed while waiting for Microsoft OAuth callback: {error}"
                ));
            }
        }
    }
}

fn open_minecraft_auth_window(
    app: &AppHandle,
    label: &str,
    authorize_url: &str,
) -> Result<PathBuf, String> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.close();
    }
    let url = reqwest::Url::parse(authorize_url)
        .map_err(|e| format!("Invalid Microsoft authorize URL: {e}"))?;
    let data_dir = create_minecraft_auth_data_directory(label)?;
    WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("Microsoft Login")
        .inner_size(980.0, 760.0)
        .min_inner_size(720.0, 560.0)
        .resizable(true)
        .focused(true)
        .center()
        .incognito(true)
        .data_directory(data_dir.clone())
        .build()
        .map_err(|e| format!("Failed to create Microsoft login window: {e}"))?;
    Ok(data_dir)
}

fn close_auth_window(app: &AppHandle, label: &str, data_dir: Option<&Path>) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
    if let Some(path) = data_dir {
        cleanup_minecraft_auth_data_directory(path);
    }
}

fn create_minecraft_auth_data_directory(label: &str) -> Result<PathBuf, String> {
    let dir = env::temp_dir()
        .join("fpsmaster-launcher")
        .join("microsoft-auth")
        .join(label);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to reset Microsoft auth data directory: {e}"))?;
    }
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create Microsoft auth data directory: {e}"))?;
    Ok(dir)
}

fn cleanup_minecraft_auth_data_directory(path: &Path) {
    for _ in 0..8 {
        if !path.exists() {
            return;
        }
        match fs::remove_dir_all(path) {
            Ok(_) => return,
            Err(_) => thread::sleep(Duration::from_millis(120)),
        }
    }
}

fn write_browser_callback_page(
    stream: &mut std::net::TcpStream,
    status_code: u16,
    title: &str,
    message: &str,
) -> Result<(), String> {
    let body = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>{}</title></head><body style=\"font-family:Segoe UI,sans-serif;background:#10161c;color:#eef3f7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;\"><div style=\"max-width:480px;padding:32px;border-radius:20px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);box-shadow:0 18px 40px rgba(0,0,0,0.22);\"><h1 style=\"margin:0 0 12px;font-size:22px;\">{}</h1><p style=\"margin:0;font-size:14px;line-height:1.7;color:#c7d2de;\">{}</p></div></body></html>",
        title, title, message
    );
    let response = format!(
        "HTTP/1.1 {} OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_code,
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|e| format!("Failed to write Microsoft OAuth callback response: {e}"))
}

fn create_oauth_random_token(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn create_pkce_code_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn build_minecraft_auth_http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build Minecraft auth HTTP client: {e}"))
}

fn resolve_minecraft_client_id() -> Result<(String, String), String> {
    if let Some(value) = read_runtime_env("FPSMASTER_MINECRAFT_CLIENT_ID") {
        return Ok((
            value,
            "environment:FPSMASTER_MINECRAFT_CLIENT_ID".to_string(),
        ));
    }
    if let Some(value) = read_runtime_env("MICROSOFT_CLIENT_ID") {
        return Ok((value, "environment:MICROSOFT_CLIENT_ID".to_string()));
    }
    if let Some(value) = option_env!("FPSMASTER_MINECRAFT_CLIENT_ID")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok((
            value.to_string(),
            "build:FPSMASTER_MINECRAFT_CLIENT_ID".to_string(),
        ));
    }
    if let Some(value) = option_env!("MICROSOFT_CLIENT_ID")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok((value.to_string(), "build:MICROSOFT_CLIENT_ID".to_string()));
    }
    Ok((
        DEFAULT_MINECRAFT_MICROSOFT_CLIENT_ID.to_string(),
        "builtin:DEFAULT_MINECRAFT_MICROSOFT_CLIENT_ID".to_string(),
    ))
}

fn read_runtime_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn minecraft_auth_configuration_hint() -> String {
    "Minecraft premium login is not configured. Set FPSMASTER_MINECRAFT_CLIENT_ID (or MICROSOFT_CLIENT_ID) before launching the launcher.".to_string()
}

fn normalize_microsoft_error_description(raw: Option<&str>, fallback: &str) -> String {
    raw.map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.replace("\r\n", " ").replace('\n', " "))
        .unwrap_or_else(|| fallback.to_string())
}

fn parse_microsoft_error_response(
    status: reqwest::StatusCode,
    text: &str,
    fallback: &str,
) -> String {
    if let Ok(payload) = serde_json::from_str::<MicrosoftTokenErrorResponse>(text) {
        return format!(
            "{}: {}",
            fallback,
            normalize_microsoft_error_description(
                payload.error_description.as_deref(),
                &payload.error
            )
        );
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return format!("{fallback}: HTTP {status}");
    }
    format!("{fallback}: {trimmed}")
}

fn create_microsoft_account_id(uuid: &str) -> String {
    format!("microsoft-{}", uuid.trim().to_ascii_lowercase())
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}
