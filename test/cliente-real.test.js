// La misma conexión que haría una IA de verdad: el cliente oficial de MCP
// descubre solo dónde pedir permiso, se registra, pide autorización y
// recién entonces entra. Nada de esto está armado a mano en la prueba.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { prepararBase, cerrar } from './ayuda.js';
import { crearApp } from '../src/servidor.js';
import { config } from '../src/config.js';
import * as acceso from '../src/acceso.js';

const BASE = config.urlPublica.origin;
let servidor;

before(async () => {
  await prepararBase();
  servidor = crearApp().listen(config.puerto);
  await new Promise((r) => servidor.once('listening', r));
});
after(async () => {
  await new Promise((r) => servidor.close(r));
  await cerrar();
});

function proveedor() {
  const estado = { cliente: undefined, pases: undefined, verificador: undefined, destino: undefined };
  return {
    estado,
    get redirectUrl() {
      return 'http://localhost:53999/callback';
    },
    get clientMetadata() {
      return {
        client_name: 'IA de prueba',
        redirect_uris: ['http://localhost:53999/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => estado.cliente,
    saveClientInformation: (c) => { estado.cliente = c; },
    tokens: () => estado.pases,
    saveTokens: (t) => { estado.pases = t; },
    redirectToAuthorization: (url) => { estado.destino = url; },
    saveCodeVerifier: (v) => { estado.verificador = v; },
    codeVerifier: () => estado.verificador,
  };
}

test('un cliente estándar descubre, se registra, pide permiso y entra', async () => {
  const auth = proveedor();
  const transporte = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { authProvider: auth });
  const cliente = new Client({ name: 'ia-de-prueba', version: '1' });
  await assert.rejects(cliente.connect(transporte), UnauthorizedError);

  // El cliente quedó esperando que la persona autorice en el navegador.
  assert.ok(auth.estado.cliente?.client_id, 'se registró solo');
  const pedido = auth.estado.destino;
  assert.equal(pedido.origin + pedido.pathname, BASE + '/authorize');
  assert.equal(pedido.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(pedido.searchParams.get('resource'), BASE + '/mcp');

  // Lo que haría Emiliano en el navegador.
  const paso1 = await fetch(pedido, { redirect: 'manual' });
  const pantalla = new URL(paso1.headers.get('location'), BASE);
  const html = await (await fetch(pantalla)).text();
  assert.match(html, /IA de prueba quiere conectarse/);
  assert.match(html, /corre en tu propia computadora/);
  const paso2 = await fetch(BASE + '/autorizar', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pedido: pantalla.searchParams.get('pedido'), decision: 'si', clave: config.clave }),
    redirect: 'manual',
  });
  const vuelta = new URL(paso2.headers.get('location'));
  assert.equal(vuelta.host, 'localhost:53999');

  await transporte.finishAuth(vuelta.searchParams.get('code'));
  const conectado = new Client({ name: 'ia-de-prueba', version: '1' });
  await conectado.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { authProvider: auth }));
  const manual = await conectado.callTool({ name: 'leer_manual', arguments: {} });
  assert.match(manual.content[0].text, /Manual de Alex/);
  await conectado.close();

  const [permiso] = await acceso.listarAccesos();
  assert.equal(permiso.nombre, 'IA de prueba');
  assert.equal(permiso.revocado, null);
});
