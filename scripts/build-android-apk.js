"use strict";

// Builds the Android release APK locally and saves it as mobile/apk/<MMDD>.apk (today's month+day,
// e.g. 1004.apk), so every build has an obvious name instead of always being "app-release.apk".
//
//   npm run mobile:apk              full build: prebuild (no --clean) + gradle assembleRelease + rename
//   npm run mobile:apk -- --copy-only   only copy the last built app-release.apk to today's name
//
// A second build on the same day overwrites that day's file. Why prebuild runs WITHOUT --clean and why
// the demo flag is refused: see mobile/README.md ("推播通知（Android）設定" and "離線展示模式").

const fs = require("node:fs");
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

function build() {
  // The demo flag is inlined into the JS bundle at build time; a demo APK would show fake data to everyone.
  if (process.env.EXPO_PUBLIC_DEMO_MODE) {
    throw new Error("EXPO_PUBLIC_DEMO_MODE is set in this shell -- refusing to build a release APK with demo mode.");
  }
  const env = { ...process.env, NODE_ENV: "production", CI: "1" };
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const gradle = process.platform === "win32" ? ["cmd", ["/c", "gradlew.bat", "assembleRelease"]] : ["./gradlew", ["assembleRelease"]];

  // Not --clean: that regenerates android/app/debug.keystore, changing the signing SHA-1 Google sign-in is registered to.
  run(npx, ["expo", "prebuild", "--platform", "android", "--no-install"], { cwd: mobileDir, env, shell: process.platform === "win32" });
  run(gradle[0], gradle[1], { cwd: androidDir, env });
}

function saveWithDateName() {
  if (!fs.existsSync(builtApk)) {
    throw new Error(`No built APK at ${builtApk} -- run without --copy-only first.`);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, `${todayStamp()}.apk`);
  fs.copyFileSync(builtApk, target);
  const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`APK saved: ${target} (${sizeMb} MB)`);
  return target;
}

if (require.main === module) {
  try {
    if (!process.argv.includes("--copy-only")) build();
    saveWithDateName();
  } catch (error) {
    console.error(`build-android-apk failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { todayStamp };
