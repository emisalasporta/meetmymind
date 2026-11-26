// La entrada para las IA, de punta a punta: una IA pide permiso, Emiliano la
// autoriza con su clave, y recién ahí la IA puede leer y escribir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { prepararBase, cerrar } from './ayuda.js';
import { crearApp } from '../src/servidor.js';
import { config } from '../src/config.js';
import { consultar } from '../src/db.js';
import * as acceso from '../src/acceso.js';

const BASE = config.urlPublica.origin;
const RETORNO = 'https://claude.ai/api/mcp/auth_callback';
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

const formulario = (datos) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(datos),
  redirect: 'manual',
});

async function registrar(nombre = 'Claude') {
  const r = await fetch(BASE + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: nombre,
      redirect_uris: [RETORNO],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  assert.equal(r.status, 201);
  return (await r.json()).client_id;
}

async function pedirPermiso(clientId) {
  const verificador = crypto.randomBytes(40).toString('base64url');
  const desafio = crypto.createHash('sha256').update(verificador).digest('base64url');
  const url = new URL(BASE + '/authorize');
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: RETORNO, code_challenge: desafio,
    code_challenge_method: 'S256', state: 'estado-123', scope: 'mente', resource: BASE + '/mcp',
  });
  const r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const pedido = new URL(r.headers.get('location'), BASE).searchParams.get('pedido');
  assert.ok(pedido);
  return { pedido, verificador };
}

async function autorizar(clientId) {
  const { pedido, verificador } = await pedirPermiso(clientId);
  const r = await fetch(BASE + '/autorizar', formulario({ pedido, decision: 'si', clave: config.clave }));
  assert.equal(r.status, 303);
  const vuelta = new URL(r.headers.get('location'));
  assert.equal(vuelta.origin + vuelta.pathname, RETORNO);
  assert.equal(vuelta.searchParams.get('state'), 'estado-123');
  return { codigo: vuelta.searchParams.get('code'), verificador };
}

const canjear = (clientId, codigo, verificador) =>
  fetch(BASE + '/token', formulario({ grant_type: 'authorization_code', code: codigo, code_verifier: verificador, client_id: clientId, redirect_uri: RETORNO }));

async function conectar(pase) {
  const cliente = new Client({ name: 'prueba', version: '1' });
  await cliente.connect(
    new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + pase } } }),
  );
  return cliente;
}

const texto = (r) => r.content[0].text;
const json = (r) => JSON.parse(texto(r));

let clientId;
let pases;

test('sin pase, la entrada rechaza y dice dónde pedir permiso', async () => {
  const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const recurso = await (await fetch(BASE + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(recurso.resource, BASE + '/mcp');
  const servidorAuth = await (await fetch(BASE + '/.well-known/oauth-authorization-server')).json();
  assert.ok(servidorAuth.registration_endpoint && servidorAuth.code_challenge_methods_supported.includes('S256'));
  const malo = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer inventado' }, body: '{}' });
  assert.equal(malo.status, 401);
});

test('la pantalla de permiso muestra quién pide y exige la clave', async () => {
  clientId = await registrar();
  const { pedido } = await pedirPermiso(clientId);
  const pantalla = await (await fetch(BASE + '/autorizar?pedido=' + pedido)).text();
  assert.match(pantalla, /Claude quiere conectarse/);
  assert.match(pantalla, /claude\.ai/);
  const sinClave = await fetch(BASE + '/autorizar', formulario({ pedido, decision: 'si', clave: 'otra-cosa' }));
  assert.equal(sinClave.status, 401);
  const no = await fetch(BASE + '/autorizar', formulario({ pedido, decision: 'no' }));
  assert.equal(no.status, 303);
  assert.equal(new URL(no.headers.get('location')).searchParams.get('error'), 'access_denied');
  // El pedido rechazado ya no sirve.
  const otraVez = await fetch(BASE + '/autorizar', formulario({ pedido, decision: 'si', clave: config.clave }));
  assert.equal(otraVez.status, 400);
});

test('con la clave se autoriza; el código sirve una sola vez y solo con su verificador', async () => {
  const { codigo, verificador } = await autorizar(clientId);
  const mal = await canjear(clientId, codigo, 'verificador-equivocado-verificador-equivocado-xx');
  assert.equal(mal.status, 400);
  assert.equal((await mal.json()).error, 'invalid_grant');
  const bien = await canjear(clientId, codigo, verificador);
  assert.equal(bien.status, 200);
  pases = await bien.json();
  assert.equal(pases.token_type, 'Bearer');
  assert.ok(pases.access_token && pases.refresh_token && pases.expires_in === 3600);
  // En el fichero no queda ningún pase tal cual, solo huellas.
  const guardados = await consultar('select token_hash from oauth_tokens');
  assert.ok(guardados.rows.every((f) => f.token_hash !== pases.access_token && f.token_hash !== pases.refresh_token));
});

test('Alex lee el manual y trabaja; todo queda a su nombre en el historial', async () => {
  const alex = await conectar(pases.access_token);
  const { tools } = await alex.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['adjuntar_archivo', 'agregar_apunte', 'bandeja_agregar', 'bandeja_resolver', 'bandeja_ver', 'borrar', 'buscar', 'crear_ficha',
     'desenlazar', 'editar_apunte', 'editar_ficha', 'enlazar', 'leer_ficha', 'leer_manual', 'listar_fichas', 'restaurar', 'ver_historial'],
  );
  assert.ok(tools.every((t) => t.description.length > 40));
  assert.match(alex.getInstructions(), /leer_manual/);

  const manual = texto(await alex.callTool({ name: 'leer_manual', arguments: {} }));
  assert.match(manual, /Los criterios son pocos y no se apilan/);
  assert.match(manual, /Vínculos\*\* \(capa "vinculos"\): 0 fichas/);

  const persona = json(await alex.callTool({ name: 'crear_ficha', arguments: {
    capa: 'vinculos', tipo: 'persona', titulo: 'Rosa Quiroga de Prueba', alias: ['la Rosa'],
    apuntes: [{ texto: 'Es la contadora del club.', base: 'dicho_por_emiliano', fecha: '2026-11-25', origen: 'conversación con Alex' }],
    motivo: 'Emiliano la nombró por primera vez',
  } }));
  const hecho = json(await alex.callTool({ name: 'crear_ficha', arguments: {
    capa: 'hechos', tipo: 'llamada', titulo: 'Llamada de prueba con Rosa', fecha: '2026-11-25',
    enlaces: [{ hacia: persona.id, relacion: 'participó' }],
  } }));
  // Repetida: no la crea y avisa cuál es la parecida.
  const repetida = await alex.callTool({ name: 'crear_ficha', arguments: { capa: 'vinculos', titulo: 'Rosa Quiroga de prueba' } });
  assert.equal(repetida.isError, true);
  assert.equal(json(repetida).parecidas[0].id, persona.id);

  const apunte = json(await alex.callTool({ name: 'agregar_apunte', arguments: {
    ficha_id: persona.id, texto: 'Parece que prefiere el teléfono al mail.', base: 'deducido_por_alex', hecho_id: hecho.id,
  } }));
  assert.equal(apunte.base, 'deducido_por_alex');

  const leida = json(await alex.callTool({ name: 'leer_ficha', arguments: { id: persona.id } }));
  assert.equal(leida.apuntes.length, 2);
  assert.equal(leida.enlaces[0].titulo, 'Llamada de prueba con Rosa');

  const encontrada = json(await alex.callTool({ name: 'buscar', arguments: { texto: 'la rosa' } }));
  assert.equal(encontrada[0].id, persona.id);

  const cambios = json(await alex.callTool({ name: 'ver_historial', arguments: { ficha_id: persona.id } }));
  assert.ok(cambios.length >= 3);
  assert.ok(cambios.every((c) => c.quien === 'alex (Claude)'));
  assert.equal(cambios.at(-1).motivo, 'Emiliano la nombró por primera vez');

  // Un pedido mal armado vuelve como error entendible, sin romper nada.
  const mala = await alex.callTool({ name: 'leer_ficha', arguments: { id: 'no-es-un-id' } });
  assert.equal(mala.isError, true);
  assert.match(json(mala).error, /no es válido/);
  const audio = await alex.callTool({ name: 'adjuntar_archivo', arguments: { ficha_id: persona.id, nombre: 'nota.mp3', contenido_base64: Buffer.from('ID3xxxxxxxxxxxxxxxx').toString('base64') } });
  assert.equal(audio.isError, true);
  assert.match(json(audio).error, /audio y de video no se guardan/);
  await alex.close();

  const accesos = await acceso.listarAccesos();
  assert.equal(accesos.filter((a) => !a.revocado).length, 1);
  assert.ok(accesos[0].ultimo_uso);
});

test('el pase se renueva; una renovación vieja que reaparece corta el acceso', async () => {
  const renovar = (token) => fetch(BASE + '/token', formulario({ grant_type: 'refresh_token', refresh_token: token, client_id: clientId }));
  const r1 = await renovar(pases.refresh_token);
  assert.equal(r1.status, 200);
  const nuevos = await r1.json();
  assert.notEqual(nuevos.refresh_token, pases.refresh_token);
  await (await conectar(nuevos.access_token)).close();
  // Un reintento inmediato con la misma renovación se tolera (falla de red).
  assert.equal((await renovar(pases.refresh_token)).status, 200);
  // Pasado un rato, la misma renovación es señal de robo.
  await consultar("update oauth_tokens set usado = now() - interval '10 minutes' where usado is not null");
  const robo = await renovar(pases.refresh_token);
  assert.equal(robo.status, 400);
  assert.equal((await robo.json()).error, 'invalid_grant');
  await assert.rejects(conectar(nuevos.access_token));
  assert.equal((await acceso.listarAccesos()).filter((a) => !a.revocado).length, 0);
});

test('un código usado dos veces corta el acceso; cortar desde la web también', async () => {
  const { codigo, verificador } = await autorizar(clientId);
  const ok = await (await canjear(clientId, codigo, verificador)).json();
  await (await conectar(ok.access_token)).close();
  const repetido = await canjear(clientId, codigo, verificador);
  assert.equal(repetido.status, 400);
  await assert.rejects(conectar(ok.access_token));

  const otro = await autorizar(clientId);
  const pasesOtro = await (await canjear(clientId, otro.codigo, otro.verificador)).json();
  await (await conectar(pasesOtro.access_token)).close();
  const vivo = (await acceso.listarAccesos()).find((a) => !a.revocado);
  await acceso.revocarAcceso(vivo.id);
  await assert.rejects(conectar(pasesOtro.access_token));
});

test('una llave propia entra hasta que se la revoca', async () => {
  const llave = await acceso.crearLlave('lector de prueba');
  assert.ok(llave.llave.startsWith('mmm_llave_'));
  const programa = await conectar(llave.llave);
  const f = json(await programa.callTool({ name: 'bandeja_agregar', arguments: { contenido: 'Texto crudo de prueba', origen: 'plaud' } }));
  assert.equal(f.estado, 'pendiente');
  const h = json(await programa.callTool({ name: 'ver_historial', arguments: { limite: 1 } }));
  assert.equal(h[0].quien, 'alex (lector de prueba)');
  await programa.close();
  await acceso.revocarLlave(llave.id);
  await assert.rejects(conectar(llave.llave));
});
