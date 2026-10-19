"use strict";

// Real backend, real HTTP, throwaway schema (run through scripts/with-temp-schema.js, as `npm run test:db` does).
// Guards the two settings that decide whether the admin login and the developer backdoor can be abused:
//   1. the admin-login lockout must keep counting when every attempt carries a different FORGED first
//      X-Forwarded-For entry (Azure appends its own entry last; the first one is whatever the caller wrote);
//   2. AUTH_DEV_MODE=true must be ignored (with a warning) on Azure and on a host with ADMIN_WEB_LOOPBACK_ONLY=true.
// The unit tests cover the helpers; this covers the wiring from the request to the behaviour. The only password
// ever sent is the throwaway one below.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");

async function withBackend(extraEnv, work) {
  const port = 39600 + (process.pid % 300) + Math.floor(Math.random() * 90);
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: "",
    AUTH_DEV_MODE: "",
    ADMIN_WEB_LOOPBACK_ONLY: "",
    WEBSITE_SITE_NAME: "",
    ADMIN_WEB_PASSWORDS: "throwaway-correct-password-for-test",
    SETTLEMENT_SCHEDULER_ENABLED: "false",
    PICKUP_EXPIRATION_SCHEDULER_ENABLED: "false",
    ...extraEnv,
  };
  const child = spawn(process.execPath, ["backend/server.js"], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 60 && !healthy; attempt += 1) {
      try {
        healthy = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(healthy, `backend did not become healthy\n${output}`);
    return await work({ base: `http://127.0.0.1:${port}`, getOutput: () => output });
  } finally {
    child.kill();
  }
}

async function wrongPasswordAttempt(base, forwardedFor) {
  const response = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": forwardedFor },
    body: "password=wrong-password",
  });
  return response.status;
}

async function verifyLockout() {
  // Azure-style: forged first entry differs on every attempt, the entry Azure appended stays the same.
  await withBackend({ WEBSITE_SITE_NAME: "app" }, async ({ base }) => {
    const statuses = [];
    for (let index = 1; index <= 7; index += 1) {
      statuses.push(await wrongPasswordAttempt(base, `10.0.0.${index}, 203.0.113.9:${5000 + index}`));
    }
    assert.deepEqual(statuses, [302, 302, 302, 302, 302, 429, 429], `Azure-style lockout: ${statuses}`);
    // Someone else's failures do not lock out a different real client.
    assert.equal(await wrongPasswordAttempt(base, "10.9.9.9, 198.51.100.7:1"), 302);
  });

  // School VM / developer machine: the header is ignored, the connection's own address is counted.
  await withBackend({}, async ({ base }) => {
    const statuses = [];
    for (let index = 1; index <= 7; index += 1) statuses.push(await wrongPasswordAttempt(base, `10.0.0.${index}`));
    assert.deepEqual(statuses, [302, 302, 302, 302, 302, 429, 429], `non-Azure lockout: ${statuses}`);
  });
}

async function verifyDevModeSwitch() {
  const cases = [
    { env: { AUTH_DEV_MODE: "true", ADMIN_WEB_LOOPBACK_ONLY: "true" }, status: 404, warning: /ignored: ADMIN_WEB_LOOPBACK_ONLY/ },
    { env: { AUTH_DEV_MODE: "true", WEBSITE_SITE_NAME: "app" }, status: 404, warning: /ignored: this is Azure App Service/ },
    { env: { AUTH_DEV_MODE: "true" }, status: 200, warning: null },
    { env: {}, status: 404, warning: null },
  ];
  for (const { env, status, warning } of cases) {
    await withBackend(env, async ({ base, getOutput }) => {
      const response = await fetch(`${base}/api/auth/dev-users`);
      assert.equal(response.status, status, `dev-users with ${JSON.stringify(env)}`);
      if (warning) assert.match(getOutput(), warning);
      else assert.doesNotMatch(getOutput(), /\[dev-auth\]/);
    });
  }
}

async function main() {
  await verifyLockout();
  await verifyDevModeSwitch();
  console.log("Auth hardening HTTP proof passed: forged X-Forwarded-For cannot dodge the admin lockout, and the dev login stays off on Azure and the school VM.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
