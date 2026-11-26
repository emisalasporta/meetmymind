import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepararBase, cerrar, EMI, ALEX } from './ayuda.js';
import * as n from '../src/nucleo.js';
import { consultar, migrar } from '../src/db.js';
import { sembrar } from '../src/semilla.js';

before(prepararBase);
let personaId;
const laPersona = async () => ({ id: personaId });
after(cerrar);

test('arranca con las seis capas y el manual cargado', async () => {
  const p = await n.panorama();
  assert.deepEqual(p.capas.map((c) => c.clave), ['hechos', 'vinculos', 'proyectos', 'gustos', 'identidad', 'manual']);
  assert.equal(p.capas.find((c) => c.clave === 'manual').fichas, 8);
  // Migrar y sembrar de nuevo no duplica nada.
  assert.deepEqual(await migrar(), []);
  assert.deepEqual(await sembrar(), { capasNuevas: 0, manualNuevo: 0 });
});

test('crea una ficha, la encuentra con y sin acentos, y la lee completa', async () => {
  const persona = await n.crearFicha(ALEX, {
    capa: 'vinculos', tipo: 'Persona', titulo: 'Martín Ibáñez Quiroga', alias: ['Tincho', 'el tesorero de prueba'],
    cuerpo: 'Persona de **prueba**.', datos: { rol: 'tesorero' },
  });
  assert.equal(persona.tipo, 'persona');
  personaId = persona.id;
  for (const q of ['ibañez', 'Ibanez', 'tincho', 'TESORERO de prueba', 'martin quiroga', 'Ibañes']) {
    const r = await n.buscar({ texto: q });
    assert.equal(r[0]?.id, persona.id, `buscando "${q}"`);
  }
  const completa = await n.leerFicha(persona.id);
  assert.equal(completa.datos.rol, 'tesorero');
  assert.deepEqual(completa.apuntes, []);
});

test('no crea duplicados sin confirmar', async () => {
  await assert.rejects(
    n.crearFicha(ALEX, { capa: 'vinculos', tipo: 'persona', titulo: 'Martin Ibañez Quiroga' }),
    (e) => e.codigo === 'parecidas' && e.datos.parecidas[0].titulo === 'Martín Ibáñez Quiroga',
  );
  // Por alias también lo detecta.
  await assert.rejects(n.crearFicha(ALEX, { capa: 'vinculos', titulo: 'Tincho' }), (e) => e.codigo === 'parecidas');
  // Confirmando, sí.
  const otra = await n.crearFicha(ALEX, { capa: 'vinculos', titulo: 'Martín Ibáñez Quiroga' }, { confirmar: true });
  await n.borrarFicha(ALEX, otra.id);
  await assert.rejects(n.leerFicha(otra.id), (e) => e.codigo === 'no_existe');
});

test('un hecho con apuntes y enlaces, y el reemplazo de un dato viejo', async () => {
  const persona = await laPersona();
  const hecho = await n.crearFicha(ALEX, {
    capa: 'hechos', tipo: 'reunión', titulo: 'Reunión de prueba por el presupuesto', fecha: '2026-11-20',
    origen: 'plaud', origen_ref: 'grabación 123',
    enlaces: [{ hacia: persona.id, relacion: 'Participó' }],
  });
  const viejo = await n.agregarApunte(ALEX, {
    ficha_id: persona.id, texto: 'Prefiere que le escriban a la mañana.', fecha: '2026-11-20',
    base: 'dicho_por_otro', origen: 'plaud', hecho_id: hecho.id,
  });
  const nuevo = await n.agregarApunte(EMI, {
    ficha_id: persona.id, texto: 'Ahora prefiere que lo llamen.', fecha: '2026-11-24', reemplaza: viejo.id,
  });
  const f = await n.leerFicha(persona.id);
  assert.equal(f.apuntes.length, 2);
  assert.equal(f.apuntes[0].id, nuevo.id);
  assert.equal(f.apuntes[0].vigente, true);
  assert.equal(f.apuntes[1].vigente, false);
  assert.equal(f.apuntes[1].reemplazado_por, nuevo.id);
  assert.equal(f.apuntes[1].hecho_titulo, 'Reunión de prueba por el presupuesto');
  assert.equal(f.apuntes[1].fecha, '2026-11-20');
  assert.equal(f.enlaces.length, 1);
  assert.equal(f.enlaces[0].sentido, 'entra');
  assert.equal(f.enlaces[0].relacion, 'participó');
  // Buscar por el texto de un apunte lleva a la ficha.
  const r = await n.buscar({ texto: 'prefiere que lo llamen' });
  assert.equal(r[0].id, persona.id);
  assert.match(r[0].apunte_coincidente, /llamen/);
  // Enlazar al revés con la misma relación no duplica.
  await n.enlazar(ALEX, { desde: persona.id, hacia: hecho.id, relacion: 'participó', nota: 'llegó tarde' });
  assert.equal((await n.leerFicha(hecho.id)).enlaces.length, 1);
  assert.equal((await n.leerFicha(hecho.id)).enlaces[0].nota, 'llegó tarde');
});

test('dos reuniones parecidas en días distintos son dos hechos; el mismo origen no se repite', async () => {
  const a = await n.crearFicha(ALEX, { capa: 'hechos', tipo: 'reunión', titulo: 'Reunión de prueba con Tincho', fecha: '2026-11-10', origen: 'plaud', origen_ref: 'grab-A' });
  const b = await n.crearFicha(ALEX, { capa: 'hechos', tipo: 'reunión', titulo: 'Reunión de prueba con Tincho', fecha: '2026-11-17', origen: 'plaud', origen_ref: 'grab-B' });
  assert.notEqual(a.id, b.id);
  await assert.rejects(
    n.crearFicha(ALEX, { capa: 'hechos', titulo: 'Reunion de prueba con tincho', fecha: '2026-11-17' }),
    (e) => e.codigo === 'parecidas' && e.datos.parecidas[0].id === b.id,
  );
  await assert.rejects(
    n.crearFicha(ALEX, { capa: 'hechos', titulo: 'Otro título totalmente distinto', fecha: '2026-12-01', origen_ref: 'grab-A' }),
    (e) => e.codigo === 'parecidas' && e.datos.parecidas[0].id === a.id && e.datos.parecidas[0].mismo_origen === true,
  );
  // Un hecho con nombre parecido al de una persona no frena la ficha de la persona, ni al revés.
  await n.crearFicha(ALEX, { capa: 'vinculos', tipo: 'institución', titulo: 'Reunión de prueba con Tincho SA' });
});

test('el historial registra quién, qué había antes y qué hay ahora', async () => {
  const persona = await laPersona();
  await n.editarFicha({ quien: 'emiliano', motivo: 'Cambió de puesto' }, persona.id, {
    datos_cambios: { rol: 'contador', telefono: null }, alias_agregar: ['Martín'],
  });
  const h = await n.historial({ ficha_id: persona.id, limite: 3 });
  assert.equal(h[0].quien, 'emiliano');
  assert.equal(h[0].accion, 'editar');
  assert.equal(h[0].motivo, 'Cambió de puesto');
  assert.equal(h[0].antes.datos.rol, 'tesorero');
  assert.equal(h[0].despues.datos.rol, 'contador');
  assert.deepEqual(Object.keys(h[0].despues).sort(), ['alias', 'datos']);
  // Un cambio que no cambia nada no deja registro.
  const antes = (await n.historial({ ficha_id: persona.id })).length;
  await n.editarFicha(EMI, persona.id, { titulo: 'Martín Ibáñez Quiroga' });
  assert.equal((await n.historial({ ficha_id: persona.id })).length, antes);
  // Lo que cambió Emiliano se puede filtrar.
  const deEmi = await n.historial({ quien: 'emiliano' });
  assert.ok(deEmi.length >= 2 && deEmi.every((x) => x.quien === 'emiliano'));
  // El historial no se puede tocar.
  await assert.rejects(consultar('delete from historial'), /no se modifica/);
  await assert.rejects(consultar("update historial set quien = 'otro'"), /no se modifica/);
});

test('borrar y restaurar quedan anotados; lo borrado deja de aparecer', async () => {
  const f = await n.crearFicha(EMI, { capa: 'gustos', tipo: 'libro', titulo: 'Libro de prueba para borrar' });
  await n.borrarFicha(EMI, f.id);
  assert.equal((await n.buscar({ texto: 'libro de prueba para borrar' })).length, 0);
  await n.restaurarFicha(EMI, f.id);
  assert.equal((await n.buscar({ texto: 'libro de prueba para borrar' })).length, 1);
  const h = await n.historial({ ficha_id: f.id });
  assert.deepEqual(h.map((x) => x.accion), ['restaurar', 'borrar', 'crear']);
});

test('la bandeja recibe, lista y resuelve', async () => {
  const item = await n.bandejaAgregar(ALEX, { contenido: 'Audio crudo de prueba', origen: 'whatsapp', fecha: '2026-11-25' });
  assert.equal((await n.bandejaListar()).length, 1);
  const persona = await laPersona();
  const r = await n.bandejaResolver(ALEX, item.id, { estado: 'archivado', nota: 'Fue a su ficha', fichas: [persona.id] });
  assert.equal(r.estado, 'archivado');
  assert.equal((await n.bandejaListar()).length, 0);
  assert.equal((await n.bandejaListar({ estado: 'todo' })).length, 1);
  assert.equal((await n.panorama()).bandeja_pendiente, 0);
});

test('rechaza pedidos mal armados con un mensaje claro', async () => {
  await assert.rejects(n.crearFicha(ALEX, { capa: 'inventada', titulo: 'X' }), /no existe. Las capas son/);
  await assert.rejects(n.crearFicha(ALEX, { capa: 'gustos', titulo: '   ' }), /necesita un título/);
  await assert.rejects(n.crearFicha(ALEX, { capa: 'hechos', titulo: 'Fecha mala', fecha: '2026-02-31' }), /no existe/);
  await assert.rejects(n.leerFicha('no-es-un-id'), /no es válido/);
  const p = await laPersona();
  await assert.rejects(n.agregarApunte(ALEX, { ficha_id: p.id, texto: 'x', base: 'me parece' }), /Las posibles son/);
  await assert.rejects(n.enlazar(ALEX, { desde: p.id, hacia: p.id }), /consigo misma/);
  // Si algo falla a mitad de camino, no queda nada a medias.
  const antes = (await n.listarFichas({ capa: 'hechos' })).length;
  await assert.rejects(n.crearFicha(ALEX, { capa: 'hechos', titulo: 'Hecho a medias de prueba', enlaces: [{ hacia: '00000000-0000-4000-8000-000000000000' }] }));
  assert.equal((await n.listarFichas({ capa: 'hechos' })).length, antes);
});

test('el mapa de una ficha llega hasta donde se pide y no pasa por lo borrado ni por capas apagadas', async () => {
  const c = (f) => n.crearFicha(ALEX, f, { confirmar: true });
  const a = await c({ capa: 'vinculos', titulo: 'Mapa A' });
  const b = await c({ capa: 'hechos', titulo: 'Mapa B', fecha: '2026-11-01' });
  const d = await c({ capa: 'vinculos', titulo: 'Mapa C' });
  const e = await c({ capa: 'proyectos', titulo: 'Mapa D' });
  const borrada = await c({ capa: 'vinculos', titulo: 'Mapa borrada' });
  await n.enlazar(ALEX, { desde: a.id, hacia: b.id, relacion: 'participó' });
  await n.enlazar(ALEX, { desde: b.id, hacia: d.id, relacion: 'participó' });
  await n.enlazar(ALEX, { desde: d.id, hacia: e.id });
  await n.enlazar(ALEX, { desde: a.id, hacia: borrada.id });
  await n.borrarFicha(ALEX, borrada.id);

  const uno = await n.mapa({ centro: a.id, niveles: 1 });
  assert.deepEqual(uno.nodos.map((x) => x.titulo).sort(), ['Mapa A', 'Mapa B']);
  assert.equal(uno.enlaces.length, 1);
  const tres = await n.mapa({ centro: a.id, niveles: 3 });
  const nivel = Object.fromEntries(tres.nodos.map((x) => [x.titulo, x.nivel]));
  assert.deepEqual(nivel, { 'Mapa A': 0, 'Mapa B': 1, 'Mapa C': 2, 'Mapa D': 3 });
  assert.equal(tres.nodos.find((x) => x.titulo === 'Mapa A').grado, 1); // la borrada no cuenta
  // Sin la capa "hechos", desde A no se llega a nada.
  const sinHechos = await n.mapa({ centro: a.id, niveles: 3, capas: ['vinculos', 'proyectos'] });
  assert.deepEqual(sinHechos.nodos.map((x) => x.titulo), ['Mapa A']);
  // El mapa general: sin sueltas por defecto, y con filtro de capas.
  const general = await n.mapa({});
  const titulos = general.nodos.map((x) => x.titulo);
  assert.ok(titulos.includes('Mapa D') && !titulos.includes('Mapa borrada'));
  assert.ok(general.nodos.every((x) => x.grado > 0));
  assert.ok((await n.mapa({ conSueltas: true })).nodos.length > general.nodos.length);
  const soloProyectos = await n.mapa({ capas: 'proyectos', conSueltas: true });
  assert.ok(soloProyectos.nodos.every((x) => x.capa === 'proyectos'));
  assert.ok(soloProyectos.enlaces.every((l) => soloProyectos.nodos.some((x) => x.id === l.desde) && soloProyectos.nodos.some((x) => x.id === l.hacia)));
});
