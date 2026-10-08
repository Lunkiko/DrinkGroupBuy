"use strict";

// The operator-only surfaces of the backend: the server-rendered admin console, the local dev console and the
// admin JSON API. With ADMIN_WEB_LOOPBACK_ONLY=true they answer only requests that come from the machine
// itself (someone using a browser inside the VM over Remote Desktop) and look like "not found" to anyone else.
//
// Why it exists: the school VM has a public IP and, without a domain name, serves plain HTTP, so the admin
// password would cross the network unencrypted and the login page would be open to the whole internet. The
// customer app and the LINE Pay redirect routes are NOT affected -- they must stay reachable.
//
// Only correct when clients connect to Node directly. Behind a reverse proxy on the same machine every
// request arrives from 127.0.0.1 (X-Forwarded-For is deliberately not trusted), which would silently
// switch the guard off -- do not combine this flag with a local reverse proxy.

function isAdminSurfacePath(pathname) {
  return pathname === "/admin"
    || pathname.startsWith("/admin/")
    || pathname === "/dev-console"
    || pathname.startsWith("/dev-console/")
    || pathname.startsWith("/api/admin/");
}

function shouldBlockAdminSurface({ pathname, loopbackOnly, isLoopback }) {
  return Boolean(loopbackOnly) && isAdminSurfacePath(pathname) && !isLoopback;
}

module.exports = { isAdminSurfacePath, shouldBlockAdminSurface };
