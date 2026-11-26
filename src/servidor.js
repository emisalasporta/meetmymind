// El programa que se enciende en el servidor: junta la web, la entrada para
// las IA y las tareas de fondo (copia diaria y limpieza).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, esHttps, urlEntrada, revisarConfig } from './config.js';
import { migrar, cerrar } from './db.js';
import { sembrar } from './semilla.js';
import { Portero, limpiarVencidos } from './acceso.js';
import { crearEntrada } from './entrada.js';
import { rutasWeb } from './web/rutas.js';
import { copiaDelDiaSiFalta } from './exportar.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));

export function crearApp() {
  const app = express();
  // Los intermediarios de delante informan la dirección real de quien se
  // conecta; sirve para frenar a quien pruebe claves.
  app.set('trust proxy', config.intermediarios);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self'",
        "script-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        // Al autorizar una IA, el formulario termina en la dirección de esa IA.
        "form-action 'self' https: http://localhost:* http://127.0.0.1:*",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (esHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.use(
    '/estatico',
    express.static(path.join(aqui, '..', 'public'), {
      index: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=3600'),
    }),
  );

  // --- la entrada para las IA -----------------------------------------------

  const portero = new Portero();
  app.use(
    mcpAuthRouter({
      provider: portero,
      issuerUrl: config.urlPublica,
      resourceServerUrl: urlEntrada,
      scopesSupported: ['mente'],
      resourceName: 'MeetMyMind',
    }),
  );

  const conPase = requireBearerAuth({
    verifier: portero,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(urlEntrada),
  });

  app.post('/mcp', conPase, express.json({ limit: '12mb' }), async (req, res) => {
    const entrada = crearEntrada({ quien: req.auth?.extra?.quien ?? 'alex' });
    const transporte = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transporte.close().catch(() => {});
      entrada.close().catch(() => {});
    });
    try {
      await entrada.connect(transporte);
      await transporte.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Falla en la entrada para las IA:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Falla interna' }, id: null });
      }
    }
  });

  app.all('/mcp', conPase, (req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Solo se aceptan pedidos POST.' }, id: null });
  });

  // --- la web ---------------------------------------------------------------

  app.use(rutasWeb());

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return res.status(413).send('El pedido es demasiado grande.');
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).send('El pedido llegó mal armado.');
    }
    console.error('Falla sin atender:', error);
    if (res.headersSent) return res.end();
    res.status(500).send('MeetMyMind tuvo una falla. No se guardó nada de este pedido.');
  });

  return app;
}

async function tareasDeFondo() {
  try {
    await limpiarVencidos();
  } catch (error) {
    console.error('No se pudo limpiar lo vencido:', error.message);
  }
  try {
    const copia = await copiaDelDiaSiFalta();
    if (copia) console.log('Copia diaria hecha:', copia);
  } catch (error) {
    console.error('No se pudo hacer la copia diaria:', error.message);
  }
}

async function encender() {
  revisarConfig();
  try {
    await fs.mkdir(config.dirDatos, { recursive: true });
    await fs.access(config.dirDatos, fs.constants.W_OK);
  } catch {
    throw new Error(`No se puede escribir en la carpeta de datos (${config.dirDatos}).`);
  }
  const aplicadas = await migrar();
  if (aplicadas.length) console.log('Fichero actualizado:', aplicadas.join(', '));
  await sembrar();

  const app = crearApp();
  const servidor = app.listen(config.puerto, () => {
    console.log(`MeetMyMind encendido en el puerto ${config.puerto} (${config.urlPublica.href})`);
  });

  await tareasDeFondo();
  const reloj = setInterval(tareasDeFondo, 30 * 60 * 1000);

  const apagar = () => {
    clearInterval(reloj);
    servidor.close(async () => {
      await cerrar();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  encender().catch((error) => {
    console.error('MeetMyMind no pudo encender:', error.message);
    process.exit(1);
  });
}
