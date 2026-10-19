"use strict";

// The developer login (POST /api/auth/dev-session) hands out a valid token for ANY user id, admin included,
// without a password. It must only ever exist on a developer's own machine, so being "on" takes more than the
// AUTH_DEV_MODE flag:
//   - NODE_ENV=production always turns it off;
//   - so does running on Azure App Service (WEBSITE_SITE_NAME is set by the platform), because nothing guarantees
//     NODE_ENV was ever set there;
//   - so does ADMIN_WEB_LOOPBACK_ONLY=true, which marks the school VM (a host with a public IP).
// A flag edited by mistake on one of those hosts therefore cannot open the backdoor.

function readBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

// Why dev mode cannot be on here whatever AUTH_DEV_MODE says, or null if nothing blocks it. Kept separate so the
// server can tell a developer why their flag is being ignored instead of silently answering 404.
function devAuthModeBlockedReason(env = process.env) {
  if (env.NODE_ENV === "production") return "NODE_ENV=production";
  if (env.WEBSITE_SITE_NAME) return "this is Azure App Service";
  if (readBoolean(env.ADMIN_WEB_LOOPBACK_ONLY)) return "ADMIN_WEB_LOOPBACK_ONLY=true marks a host with a public IP";
  return null;
}

function isDevAuthModeEnabled(env = process.env) {
  if (devAuthModeBlockedReason(env)) return false;
  return readBoolean(env.AUTH_DEV_MODE);
}

module.exports = { isDevAuthModeEnabled, devAuthModeBlockedReason };
