// ============================================================================
// landing-boot.js — script mínimo da landing pública (CSP-safe, sem inline).
// Só preenche o ano do rodapé; toda a navegação é por <a href>.
// ============================================================================
(function () {
  var yr = document.getElementById('yr');
  if (yr) yr.textContent = String(new Date().getFullYear());
})();
