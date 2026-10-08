"use strict";

// Builds the Android release APK locally and saves it under mobile/apk/ named after today's month+day.
//
//   npm run mobile:apk                                   Azure build (backend URL from mobile/.env)  -> 1009.apk
//   npm run mobile:apk -- --backend-url http://1.2.3.4:3000   build for another backend (the school VM) -> 1009-vm.apk
//   npm run mobile:apk -- --demo                         offline demo mode, no backend at all         -> 1009-demo.apk
//   npm run mobile:apk -- --copy-only                    only copy the last built app-release.apk to today's name
//
// --backend-url and --demo builds are FROZEN (EAS Update off, see mobile/app.config.js) so a later
// `eas update` from this machine cannot switch them back to Azure or out of demo mode. An http:// backend
// URL also turns on cleartext HTTP for that APK. A second build on the same day overwrites that day's file.
// Why prebuild runs WITHOUT --clean: it would regenerate android/app/debug.keystore and change the signing
// SHA-1 Google sign-in depends on (mobile/README.md, "推播通知（Android）設定").

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const mobileDir = path.join(__dirname, "..", "mobile");
const androidDir = path.join(mobileDir, "android");
const builtApk = path.join(androidDir, "app", "build", "outputs", "apk", "release", "app-release.apk");
const outputDir = path.join(mobileDir, "apk");

function todayStamp(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${month}${day}`;
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status ?? "none"})`);
  }
}

// Decides the flavour of this build from the command line. Pure so it can be unit-tested.
function resolveBuildPlan(argv, env) {
  const demo = argv.includes("--demo");
  const backendUrlIndex = argv.indexOf("--backend-url");
  const backendUrlRaw = backendUrlIndex === -1 ? undefined : argv[backendUrlIndex + 1];
  if (backendUrlIndex !== -1 && (!backendUrlRaw || backendUrlRaw.startsWith("--"))) {
    throw new Error("--backend-url needs a value, e.g. --backend-url http://163.17.135.215:3000");
  }
  if (demo && backendUrlRaw) throw new Error("--demo and --backend-url cannot be combined: the demo APK uses no backend.");

  // A plain build must not inherit a demo flag from the shell (it is inlined into the JS bundle).
  if (!demo && env.EXPO_PUBLIC_DEMO_MODE) {
    throw new Error("EXPO_PUBLIC_DEMO_MODE is set in this shell -- refusing to build a release APK with demo mode. Use --demo on purpose instead.");
  }
  if (demo) {
    return { suffix: "-demo", extraEnv: { EXPO_PUBLIC_DEMO_MODE: "true", FREEZE_UPDATES: "true" } };
  }
  if (!backendUrlRaw) return { suffix: "", extraEnv: {} };

  let url;
  try { url = new URL(backendUrlRaw); } catch { throw new Error(`--backend-url is not a valid URL: ${backendUrlRaw}`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("--backend-url must start with http:// or https://");
  if (["localhost", "127.0.0.1", "::1", "10.0.2.2"].includes(url.hostname)) {
    throw new Error(`--backend-url ${url.hostname} is only reachable from the build machine or an emulator, not from a phone.`);
  }
  const backendUrl = `${url.protocol}//${url.host}`;
  return {
    suffix: "-vm",
    extraEnv: {
      EXPO_PUBLIC_BACKEND_URL: backendUrl,
      FREEZE_UPDATES: "true",
      ...(url.protocol === "http:" ? { ALLOW_CLEARTEXT_HTTP: "true" } : {})
    }
  };
}

// EXPO_PUBLIC_* values (the backend URL, the demo flag) are inlined into the JS bundle at build time, but
// neither Metro's transform cache nor Gradle's "JS bundle is up to date" check notices when only an
// environment variable changed. Without this, an APK built for the school VM can still contain the Azure
// URL (found by inspecting the bundle of the first --backend-url build). So every build starts from a
// fresh JS bundle.
function clearStaleBundles() {
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp)) {
    if (entry === "metro-cache" || entry.startsWith("metro-file-map-")) {
      fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
    }
  }
  for (const dir of ["assets", "res"]) {
    fs.rmSync(path.join(androidDir, "app", "build", "generated", dir, "createBundleReleaseJsAndAssets"), { recursive: true, force: true });
  }
}

function build(plan) {
  // These switches must come only from the plan above, never from a stale shell.
  const env = { ...process.env, NODE_ENV: "production", CI: "1", ALLOW_CLEARTEXT_HTTP: "", FREEZE_UPDATES: "", ...plan.extraEnv };
  if (!plan.extraEnv.EXPO_PUBLIC_DEMO_MODE) delete env.EXPO_PUBLIC_DEMO_MODE;
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const gradle = process.platform === "win32" ? ["cmd", ["/c", ".\\gradlew.bat", "assembleRelease"]] : ["./gradlew", ["assembleRelease"]];

  clearStaleBundles();

  // Not --clean: that regenerates android/app/debug.keystore, changing the signing SHA-1 Google sign-in is registered to.
  run(npx, ["expo", "prebuild", "--platform", "android", "--no-install"], { cwd: mobileDir, env, shell: process.platform === "win32" });
  run(gradle[0], gradle[1], { cwd: androidDir, env });
}

function saveWithDateName(suffix = "") {
  if (!fs.existsSync(builtApk)) {
    throw new Error(`No built APK at ${builtApk} -- run without --copy-only first.`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, `${todayStamp()}${suffix}.apk`);
  fs.copyFileSync(builtApk, target);
  const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`APK saved: ${target} (${sizeMb} MB)`);
  return target;
}

if (require.main === module) {
  try {
    const plan = resolveBuildPlan(process.argv, process.env);
    if (!process.argv.includes("--copy-only")) build(plan);
    saveWithDateName(plan.suffix);
  } catch (error) {
    console.error(`build-android-apk failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { todayStamp, resolveBuildPlan };
