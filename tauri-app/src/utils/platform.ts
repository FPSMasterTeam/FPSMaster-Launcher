// Platform detection for window-chrome decisions.
//
// Prefer navigator.platform over the user agent: WebKitGTK on some Linux
// distros ships a site-compat UA that impersonates macOS Safari ("Macintosh;
// Intel Mac OS X ..."), which would hide our window controls on a window that
// has no native ones. navigator.platform stays truthful in all three webviews
// (WKWebView "MacIntel", WebView2 "Win32", WebKitGTK "Linux x86_64"); the UA
// is only a fallback for environments where platform is empty.
export const IS_MAC =
  typeof navigator !== "undefined" &&
  (navigator.platform
    ? navigator.platform.toLowerCase().includes("mac")
    : /Mac/i.test(navigator.userAgent));

export const IS_WINDOWS =
  typeof navigator !== "undefined" &&
  (navigator.platform
    ? navigator.platform.toLowerCase().includes("win")
    : /Windows/i.test(navigator.userAgent));

// Width reserved on the left of custom title bars for the native macOS
// traffic-light buttons (positioned via trafficLightPosition in tauri config).
export const MAC_TRAFFIC_LIGHT_INSET = 78;
