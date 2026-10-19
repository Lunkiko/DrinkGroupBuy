"use strict";

// Which address counts as "the caller" when the admin login tallies failed attempts.
//
// On Azure App Service the request reaches Node through Azure's front end, which APPENDS the address it saw to
// X-Forwarded-For. Everything before that last entry was written by the client and can be anything, so the first
// entry must never be used: a caller could send a different fake value with every attempt and never reach the
// lockout. The last entry is the one our own infrastructure added.
//
// Anywhere else (local development, the school VM) nothing sits in front of Node, so the header is entirely
// client-supplied and is ignored; the connection's own address is used.

// An IPv6 subscriber normally controls a whole /64, so counting per full address would let a caller rotate the host
// part for free. We count the first four 16-bit groups instead. That also makes an unbracketed "address:port"
// (where the port cannot be told apart from the last group) harmless, because the port only ever lands in the last
// group, never in the first four.
function ipv6Network(address) {
  const [head, tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = address.includes("::") && tail ? tail.split(":") : [];
  const zeroGroups = address.includes("::") ? Math.max(0, 8 - headGroups.length - tailGroups.length) : 0;
  const groups = [...headGroups, ...Array(zeroGroups).fill("0"), ...tailGroups];
  return groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}

function normalizeAddress(address) {
  const bracketed = address.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return ipv6Network(bracketed[1]);
  const ipv4WithPort = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) return ipv4WithPort[1];
  const looksLikeIpv6 = (address.match(/:/g) || []).length >= 2 && !address.includes(".");
  return looksLikeIpv6 ? ipv6Network(address) : address;
}

function resolveClientAddress({ headers = {}, socketAddress, env = process.env } = {}) {
  const fallback = socketAddress || "unknown";
  if (!env.WEBSITE_SITE_NAME) return fallback;

  const forwardedFor = headers["x-forwarded-for"];
  if (typeof forwardedFor !== "string") return fallback;

  const entries = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
  const appendedByAzure = entries[entries.length - 1];
  return appendedByAzure ? normalizeAddress(appendedByAzure) : fallback;
}

module.exports = { resolveClientAddress };
