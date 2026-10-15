"use strict";

// Decides whether DATABASE_URL points at this computer. Shared by every script that writes to a database
// (seed-demo-data, import-demo-menus, localize-menu-categories, with-temp-schema), so the check that stops a write
// to the wrong database exists once and a fix reaches all of them.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function describeTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  // pg lets a ?host= / ?hostaddr= query parameter override the host in the URL, so a URL that says
  // "localhost" could still connect somewhere else; treat any such override as remote.
  const hostOverridden = url.searchParams.has("host") || url.searchParams.has("hostaddr");
  return {
    host: hostOverridden ? `${url.hostname}（連線參數改指定了其他主機）` : url.hostname,
    database: url.pathname.replace(/^\//, ""),
    isLocal: LOCAL_HOSTS.has(url.hostname) && !hostOverridden,
  };
}

module.exports = { LOCAL_HOSTS, describeTarget };
