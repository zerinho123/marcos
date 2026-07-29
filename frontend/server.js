// ============================================================================
// server.js - CF Finance frontend (financeiro.cfsistema.site)
// ----------------------------------------------------------------------------
// Servidor estatico minimo (Express) para encaixar no modelo de deploy do
// Hostinger ("Web app Node.js" exige um Arquivo de entrada). Serve a SPA em
// /public e replica as regras do .htaccess original (MIME de ES modules,
// headers de seguranca/CSP, cache-control granular, URLs amigaveis).
// ============================================================================
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');

// Headers de seguranca / CSP (espelha o .htaccess)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // script-src sem 'unsafe-inline': todo JS e externo (redirect.js / login-boot.js
        // substituem os antigos <script> inline). style-src mantem unsafe-inline (innerHTML).
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'", 'https://apifinanceiro.cfsistema.site'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Bloqueia dotfiles e backups (espelha .htaccess)
app.use((req, res, next) => {
  if (
    /(^|\/)\.(env|git|gitignore|gitattributes|htaccess|htpasswd|DS_Store)/i.test(req.path) ||
    /\.(bak|backup|swp|swo|orig|save|old|tmp|log)$/i.test(req.path)
  ) {
    return res.status(404).end();
  }
  next();
});

// Assets estaticos: MIME correto para ES modules + cache-control granular
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    setHeaders: (res, filePath) => {
      if (/\.(html?)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      } else if (/\.(js|mjs|css|svg)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      } else if (/\.(woff2?|ttf|otf)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      if (/\.(js|mjs)$/i.test(filePath)) {
        res.type('text/javascript; charset=utf-8');
      }
    },
  })
);

// URLs amigaveis: /login -> login.html, /app -> app.html, /cadastro -> cadastro.html
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/cadastro', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cadastro.html')));

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`[boot] CF Finance frontend listening on ${HOST}:${PORT}`);
});
