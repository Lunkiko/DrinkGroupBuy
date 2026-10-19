"use strict";

// Browser-facing safety headers for every response the backend sends (set once at the top of the request handler;
// the later writeHead() calls merge with them instead of replacing them).
//
// The Content-Security-Policy is deliberately narrow. The admin pages and the LINE Pay result page rely on inline
// <style>, inline <script> and inline onsubmit handlers, so restricting script-src/style-src would break them;
// moving those inline pieces out (or to nonces) is a separate piece of work. What is limited here costs nothing:
// nobody frames these pages, uses <base> or plugins, or posts a form to another site.

function buildSecurityHeaders(env = process.env) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
  };
  // HSTS is only meaningful (and only honoured) over HTTPS. Azure App Service serves HTTPS; the school VM and local
  // machines speak plain HTTP. No includeSubDomains/preload: azurewebsites.net is a domain shared with other apps.
  if (env.WEBSITE_SITE_NAME) headers["Strict-Transport-Security"] = "max-age=15552000";
  return headers;
}

function applySecurityHeaders(response, env = process.env) {
  for (const [name, value] of Object.entries(buildSecurityHeaders(env))) response.setHeader(name, value);
}

module.exports = { buildSecurityHeaders, applySecurityHeaders };
