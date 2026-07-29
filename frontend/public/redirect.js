// ============================================================================
// redirect.js — bootstrap do index.html
// ----------------------------------------------------------------------------
// Externalizado do <script> inline do index.html para permitir CSP sem
// 'unsafe-inline' em script-src. Redireciona para app.html mantendo query/hash;
// se o usuario nao tem sessao valida, o app.html detecta e manda para login.html.
// ============================================================================
(function () {
  var target = './app.html' + window.location.search + window.location.hash;
  if (!/\/app\.html$/i.test(window.location.pathname)) window.location.replace(target);
})();
