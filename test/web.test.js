// La web, como la usa Emiliano: entrar con clave, crear y corregir fichas,
// subir archivos, ver el historial, hacer copias y restaurarlas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { unzipSync, strFromU8 } from 'fflate';
import { prepararBase, cerrar, ALEX } from './ayuda.js';
import { crearApp } from '../src/servidor.js';
import { config } from '../src/config.js';
import { consultar } from '../src/db.js';
import * as n from '../src/nucleo.js';
import { restaurar, TABLAS, copiaDelDiaSiFalta, listarCopias } from '../src/exportar.js';

const BASE = config.urlPublica.origin;
let servidor;
let galleta = '';

before(async () => {
  await fs.rm(config.dirDatos, { recursive: true, force: true });
  await prepararBase();
  servidor = crearApp().listen(config.puerto);
  await new Promise((r) => servidor.once('listening', r));
});
after(async () => {
  await new Promise((r) => servidor.close(r));
  await cerrar();
});

const ver = (ruta, opciones = {}) =>
  fetch(BASE + ruta, { redirect: 'manual', ...opciones, headers: { cookie: galleta, ...(opciones.headers ?? {}) } });
const enviar = (ruta, datos, extra = {}) =>
  ver(ruta, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE, ...extra },
    body: new URLSearchParams(datos),
  });
const idDe = (r) => /\/ficha\/([0-9a-f-]{36})/.exec(r.headers.get('location'))[1];

test('sin clave no se ve nada; con la clave equivocada tampoco', async () => {
  for (const ruta of ['/', '/historial', '/capa/vinculos', '/accesos', '/exportar', '/copias', '/buscar?q=a']) {
    const r = await ver(ruta);
    assert.equal(r.status, 303, ruta);
    assert.match(r.headers.get('location'), /^\/entrar\?volver=/);
  }
  assert.equal((await enviar('/nueva', { capa: 'gustos', titulo: 'x' })).status, 401);
  const mal = await enviar('/entrar', { clave: 'no-es', volver: '/' });
  assert.equal(mal.status, 401);
  assert.equal(mal.headers.get('set-cookie'), null);
});

test('con la clave entra y vuelve adonde iba; no se deja mandar a otro sitio', async () => {
  const r = await enviar('/entrar', { clave: config.clave, volver: '/historial' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/historial');
  const puesta = r.headers.get('set-cookie');
  assert.match(puesta, /HttpOnly/);
  assert.match(puesta, /SameSite=Lax/);
  galleta = puesta.split(';')[0];
  const afuera = await enviar('/entrar', { clave: config.clave, volver: '//malo.example/x' });
  assert.equal(afuera.headers.get('location'), '/');
  const inicio = await ver('/');
  assert.equal(inicio.status, 200);
  const html = await inicio.text();
  for (const capa of ['Lo que pasó', 'Vínculos', 'Proyectos y temas', 'Gustos', 'Quién es', 'Manual de Alex']) assert.ok(html.includes(capa), capa);
  assert.match(inicio.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(inicio.headers.get('cache-control'), 'no-store');
});

test('un formulario que viene de otro sitio se rechaza', async () => {
  const r = await enviar('/nueva', { capa: 'gustos', titulo: 'Desde afuera' }, { origin: 'https://otro.example' });
  assert.equal(r.status, 403);
});

let personaId;
let hechoId;

test('crea fichas, avisa si hay una parecida, edita y deja todo en el historial', async () => {
  const r = await enviar('/nueva', {
    capa: 'vinculos', tipo: 'Persona', titulo: 'Julia <b>Prueba</b> Sosa', alias: 'la Juli, contadora de prueba',
    cuerpo: 'Texto con **negrita** y <script>alert(1)</script> y [[Otra ficha]].', datos: 'cargo: contadora\nhijos: 2\ntel: 0383 4123',
  });
  assert.equal(r.status, 303);
  personaId = idDe(r);
  const pagina = await (await ver(`/ficha/${personaId}`)).text();
  assert.ok(pagina.includes('Julia &lt;b&gt;Prueba&lt;/b&gt; Sosa'));
  assert.ok(pagina.includes('<strong>negrita</strong>'));
  assert.ok(!pagina.includes('<script>alert'));
  assert.ok(pagina.includes('href="/buscar?q=Otra%20ficha"'));
  assert.ok(pagina.includes('También: la Juli, contadora de prueba'));
  const ficha = await n.leerFicha(personaId);
  assert.deepEqual(ficha.datos, { cargo: 'contadora', hijos: 2, tel: '0383 4123' });

  const repetida = await enviar('/nueva', { capa: 'vinculos', titulo: 'Julia <b>Prueba</b> Sosa' });
  assert.equal(repetida.status, 409);
  assert.match(await repetida.text(), /Ya hay fichas parecidas/);

  const editada = await enviar(`/ficha/${personaId}`, {
    capa: 'vinculos', tipo: 'persona', titulo: 'Julia Prueba Sosa', alias: 'la Juli', cuerpo: 'Resumen nuevo.',
    datos: 'cargo: tesorera', motivo: 'La ascendieron',
  });
  assert.equal(editada.status, 303);
  const historia = await (await ver(`/ficha/${personaId}/historial`)).text();
  assert.match(historia, /Emiliano cambió la ficha/);
  assert.match(historia, /Motivo: La ascendieron/);
  assert.match(historia, /contadora/);
  assert.match(historia, /tesorera/);
});

test('apuntes, enlaces y la línea de tiempo de una persona', async () => {
  const h = await enviar('/nueva', { capa: 'hechos', tipo: 'reunión', titulo: 'Reunión de prueba con Julia', fecha: '2026-11-24' });
  hechoId = idDe(h);
  assert.equal((await enviar(`/ficha/${personaId}/apunte`, { texto: 'Le gusta el mate amargo.', fecha: '2026-11-24', base: 'dicho_por_otro', origen: 'whatsapp' })).status, 303);
  const [viejo] = (await n.leerFicha(personaId)).apuntes;
  assert.equal((await enviar(`/ficha/${personaId}/apunte`, { texto: 'Ahora toma mate dulce.', fecha: '2026-11-25', base: 'dicho_por_emiliano', reemplaza: viejo.id })).status, 303);
  const buscar = await (await ver(`/ficha/${personaId}/enlazar?q=reunion+de+prueba`)).text();
  assert.ok(buscar.includes(hechoId));
  assert.equal((await enviar(`/ficha/${personaId}/enlace`, { hacia: hechoId, relacion: 'Participó' })).status, 303);
  const pagina = await (await ver(`/ficha/${personaId}`)).text();
  assert.match(pagina, /Ya no vigente/);
  assert.match(pagina, /Lo dijo otra persona, por whatsapp/);
  assert.match(pagina, /Reunión de prueba con Julia/);
  assert.match(pagina, /participó, 24 nov 2026/);
  // Corregir un apunte y quitar un enlace.
  const [nuevo] = (await n.leerFicha(personaId)).apuntes;
  assert.equal((await ver(`/apunte/${nuevo.id}/editar`)).status, 200);
  assert.equal((await enviar(`/apunte/${nuevo.id}`, { texto: 'Ahora toma mate dulce, con miel.', fecha: '2026-11-25', base: 'dicho_por_emiliano', vigente: 'si' })).status, 303);
  const enlace = (await n.leerFicha(personaId)).enlaces[0];
  assert.equal((await enviar(`/enlace/${enlace.id}/borrar`, { volver: personaId })).status, 303);
  assert.equal((await n.leerFicha(personaId)).enlaces.length, 0);
  await n.enlazar({ quien: 'emiliano' }, { desde: hechoId, hacia: personaId, relacion: 'participó' });
});

let imagenId;

test('sube una imagen (se achica), rechaza audio, y solo se ve con sesión', async () => {
  const foto = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#2b7558' } }).jpeg().toBuffer();
  const cuerpo = new FormData();
  cuerpo.set('archivo', new Blob([foto], { type: 'image/jpeg' }), 'foto de montaña.jpg');
  cuerpo.set('descripcion', 'Prueba');
  const r = await ver(`/ficha/${personaId}/archivo`, { method: 'POST', body: cuerpo, headers: { origin: BASE } });
  assert.equal(r.status, 303);
  const [archivo] = (await n.leerFicha(personaId)).archivos;
  imagenId = archivo.id;
  assert.equal(archivo.tipo, 'image/webp');
  assert.equal(archivo.nombre, 'foto de montaña.webp');
  assert.deepEqual([archivo.ancho, archivo.alto], [2000, 1500]);
  assert.ok(archivo.bytes < foto.length);
  const vista = await ver(`/archivo/${imagenId}`);
  assert.equal(vista.status, 200);
  assert.equal(vista.headers.get('content-type'), 'image/webp');
  assert.equal((await sharp(Buffer.from(await vista.arrayBuffer())).metadata()).width, 2000);
  assert.equal((await fetch(BASE + `/archivo/${imagenId}`, { redirect: 'manual' })).status, 303);

  const audio = new FormData();
  audio.set('archivo', new Blob([Buffer.from('ID3' + 'x'.repeat(50))], { type: 'audio/mpeg' }), 'nota de voz.mp3');
  const rechazo = await ver(`/ficha/${personaId}/archivo`, { method: 'POST', body: audio, headers: { origin: BASE } });
  assert.equal(rechazo.status, 400);
  assert.match(await rechazo.text(), /audio y de video no se guardan/);
  // Un video disfrazado de documento tampoco pasa.
  const disfraz = new FormData();
  disfraz.set('archivo', new Blob([Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(40)])]), 'informe.pdf');
  assert.equal((await ver(`/ficha/${personaId}/archivo`, { method: 'POST', body: disfraz, headers: { origin: BASE } })).status, 400);
});

test('todas las pantallas abren', async () => {
  await n.bandejaAgregar(ALEX, { contenido: 'Transcripción cruda de prueba', origen: 'plaud', fecha: '2026-11-25' });
  const [pendiente] = await n.bandejaListar();
  const rutas = ['/', '/buscar', '/buscar?q=julia', '/buscar?q=zzzz', '/capa/vinculos', '/capa/hechos?orden=titulo', '/capa/vinculos?tipo=persona',
    '/capa/manual', '/nueva', '/nueva?capa=hechos', `/ficha/${personaId}`, `/ficha/${personaId}/editar`, `/ficha/${hechoId}`,
    `/ficha/${personaId}/historial`, '/historial', '/historial?quien=emiliano', '/historial?quien=alex', '/bandeja', '/bandeja?estado=archivado',
    `/bandeja/${pendiente.id}`, '/accesos', '/copias'];
  for (const ruta of rutas) {
    const r = await ver(ruta);
    assert.equal(r.status, 200, ruta);
    const html = await r.text();
    assert.ok(html.startsWith('<!doctype html>'), ruta);
    assert.ok(!html.includes('undefined') && !html.includes('[object Object]') && !html.includes('NaN'), ruta);
  }
  assert.equal((await ver('/capa/inventada')).status, 404);
  assert.equal((await ver('/ficha/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await ver('/ficha/cualquiercosa')).status, 400);
  assert.equal((await ver('/no-existe')).status, 404);
  assert.equal((await enviar(`/bandeja/${pendiente.id}`, { estado: 'descartado', nota: 'Era ruido' })).status, 303);
  assert.equal((await n.bandejaListar()).length, 0);
});

test('la copia trae todo y se puede restaurar en un fichero vacío', async () => {
  assert.equal((await enviar('/copias', {})).status, 303);
  const [copia] = await listarCopias();
  assert.match(copia.nombre, /^meetmymind-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  assert.equal((await ver('/copias/' + copia.nombre)).status, 200);
  assert.equal((await ver('/copias/..%2F..%2Fetc%2Fpasswd')).status, 404);

  const r = await ver('/exportar?archivos=1');
  assert.equal(r.status, 200);
  const zip = unzipSync(new Uint8Array(await r.arrayBuffer()));
  const nombres = Object.keys(zip);
  assert.ok(nombres.includes('LEEME.txt'));
  for (const t of TABLAS) assert.ok(nombres.includes(`datos/${t}.json`), t);
  const md = nombres.find((x) => x.startsWith('fichas/vinculos/julia-prueba-sosa--'));
  const textoFicha = strFromU8(zip[md]);
  assert.match(textoFicha, /^---\nid: /);
  assert.match(textoFicha, /# Julia Prueba Sosa/);
  assert.match(textoFicha, /- cargo: tesorera/);
  assert.match(textoFicha, /Ahora toma mate dulce, con miel\.\n  \(2026-11-25; Lo dijo Emiliano\)/);
  assert.match(textoFicha, /ya no vigente/);
  assert.match(textoFicha, /- participó: \[\[Reunión de prueba con Julia\]\]/);
  assert.equal(nombres.filter((x) => x.startsWith('archivos/')).length, 1);
  // Nada de claves ni accesos en la copia.
  assert.ok(!nombres.some((x) => /sesion|oauth|llave|acceso|intento/.test(x)));

  const tablas = Object.fromEntries(TABLAS.map((t) => [t, JSON.parse(strFromU8(zip[`datos/${t}.json`]))]));
  const antes = {
    ficha: await n.leerFicha(personaId),
    historial: await n.historial({ limite: 500 }),
    busqueda: (await n.buscar({ texto: 'mate dulce' })).map((f) => f.id),
  };
  // Restaurar sobre un fichero con fichas se niega.
  await assert.rejects(restaurar(tablas), /ya tiene fichas/);
  await prepararBase();
  const resultado = await restaurar(tablas);
  assert.equal(resultado.restaurado.fichas, tablas.fichas.length);
  const despues = {
    ficha: await n.leerFicha(personaId),
    historial: await n.historial({ limite: 500 }),
    busqueda: (await n.buscar({ texto: 'mate dulce' })).map((f) => f.id),
  };
  assert.deepEqual(despues, antes);
  // Y después de restaurar se sigue trabajando normalmente, con el historial en orden.
  await n.agregarApunte({ quien: 'emiliano' }, { ficha_id: personaId, texto: 'Apunte posterior a la restauración.' });
  const ultimo = (await n.historial({ limite: 1 }))[0];
  assert.equal(ultimo.accion, 'crear');
  assert.ok(ultimo.id > antes.historial[0].id);
});

test('la copia diaria se hace una vez por día', async () => {
  const hechas = (await listarCopias()).length;
  const nombre = await copiaDelDiaSiFalta();
  if (nombre) {
    assert.match(nombre, /^meetmymind-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.equal((await listarCopias()).length, hechas + 1);
    assert.equal(await copiaDelDiaSiFalta(), null);
  }
});

test('salir cierra la sesión', async () => {
  // La sesión se guardó antes de restaurar: hay que entrar de nuevo.
  const r = await enviar('/entrar', { clave: config.clave, volver: '/' });
  galleta = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await ver('/')).status, 200);
  assert.equal((await enviar('/salir', {})).status, 303);
  assert.equal((await ver('/')).status, 303);
});

test('muchos intentos fallidos frenan la entrada, también con la clave buena', async () => {
  await consultar('delete from intentos');
  for (let i = 0; i < 8; i += 1) assert.equal((await enviar('/entrar', { clave: 'mala' + i })).status, 401);
  assert.equal((await enviar('/entrar', { clave: config.clave })).status, 429);
  await consultar('delete from intentos');
  assert.equal((await enviar('/entrar', { clave: config.clave })).status, 303);
});

test('el mapa: las pantallas abren y los datos respetan los filtros', async () => {
  const r0 = await enviar('/entrar', { clave: config.clave, volver: '/' });
  galleta = r0.headers.get('set-cookie').split(';')[0];
  const [persona] = await n.buscar({ texto: 'Julia Prueba Sosa' });
  for (const ruta of ['/mapa', '/mapa?capa=vinculos&capa=hechos&sueltas=1', `/ficha/${persona.id}/mapa`, `/ficha/${persona.id}/mapa?niveles=1&capa=hechos`]) {
    const r = await ver(ruta);
    assert.equal(r.status, 200, ruta);
    const html = await r.text();
    assert.ok(html.includes('/estatico/mapa.js') && html.includes('data-mapa'), ruta);
  }
  const conFiltro = await (await ver(`/ficha/${persona.id}/mapa?niveles=1&capa=hechos`)).text();
  assert.match(conFiltro, /value="hechos" checked/);
  assert.doesNotMatch(conFiltro, /value="gustos" checked/);
  assert.match(conFiltro, /value="1" checked/);

  const datos = await (await ver(`/mapa/datos?centro=${persona.id}&niveles=2`)).json();
  assert.equal(datos.centro, persona.id);
  assert.ok(datos.nodos.some((x) => x.titulo === 'Reunión de prueba con Julia' && x.nivel === 1));
  assert.equal(datos.capas.vinculos, 'Vínculos');
  const general = await (await ver('/mapa/datos?capa=vinculos')).json();
  assert.ok(general.nodos.every((x) => x.capa === 'vinculos'));
  assert.equal((await ver('/mapa/datos?centro=00000000-0000-4000-8000-000000000000')).status, 404);
  // Sin sesión, los datos no salen y se responde "hay que entrar", no una página.
  const sin = await fetch(BASE + '/mapa/datos', { redirect: 'manual' });
  assert.equal(sin.status, 401);
  // Los archivos del mapa se sirven.
  for (const f of ['/estatico/mapa.js', '/estatico/mapa-motor.js']) assert.equal((await fetch(BASE + f)).status, 200);
  // La ficha y el inicio enlazan al mapa.
  assert.match(await (await ver(`/ficha/${persona.id}`)).text(), new RegExp(`/ficha/${persona.id}/mapa`));
  assert.match(await (await ver('/')).text(), /Ver el mapa de conexiones/);
});
