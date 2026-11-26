// Copias y exportación.
//
// Una copia es un archivo .zip con dos cosas adentro:
//   - fichas/…  cada ficha como un archivo de texto que abre cualquier programa
//   - datos/…   todo el fichero en formato JSON, que sirve para restaurarlo
//
// No incluye claves ni accesos: después de restaurar, las IA se vuelven a
// autorizar.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { config } from './config.js';
import { conexion, consultar } from './db.js';
import { BASES } from './nucleo.js';
import { rutaEnDisco } from './archivos.js';
import { hoy } from './web/plantilla.js';

// Tablas que entran en la copia, en el orden en que hay que restaurarlas.
export const TABLAS = ['capas', 'fichas', 'apuntes', 'enlaces', 'archivos', 'bandeja', 'historial'];

const COLUMNAS_FUERA = ['busqueda', 'nombres'];

const LEEME = `MeetMyMind · copia

Esta carpeta es una copia completa de MeetMyMind.

fichas/    Una carpeta por capa y un archivo de texto (.md) por ficha, con su
           resumen, sus datos, sus apuntes y sus enlaces. Se leen con
           cualquier editor de texto.
datos/     El fichero completo, una tabla por archivo (.json). Es lo que se
           usa para restaurar MeetMyMind en un servidor nuevo.
archivos/  Las imágenes y los documentos (solo si la copia se pidió "con
           archivos").

La copia no trae claves ni accesos de las IA.
`;

function slug(texto) {
  return (
    String(texto)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'ficha'
  );
}

function yaml(valor) {
  return JSON.stringify(String(valor ?? ''));
}

/** Una ficha como texto, para leerla sin MeetMyMind. */
function fichaComoTexto(ficha, apuntes, enlaces, archivos) {
  const l = ['---'];
  l.push(`id: ${ficha.id}`, `titulo: ${yaml(ficha.titulo)}`, `capa: ${ficha.capa}`);
  if (ficha.tipo) l.push(`tipo: ${yaml(ficha.tipo)}`);
  if (ficha.alias.length) l.push(`alias: [${ficha.alias.map(yaml).join(', ')}]`);
  if (ficha.fecha) l.push(`fecha: ${ficha.fecha}`);
  if (ficha.origen) l.push(`origen: ${yaml(ficha.origen)}`);
  if (ficha.origen_ref) l.push(`referencia: ${yaml(ficha.origen_ref)}`);
  l.push(`estado: ${ficha.estado}`, `creada: ${ficha.creada}`, `actualizada: ${ficha.actualizada}`);
  l.push('---', '', `# ${ficha.titulo}`, '');
  if (ficha.cuerpo.trim()) l.push(ficha.cuerpo.trim(), '');
  const datos = Object.entries(ficha.datos ?? {});
  if (datos.length) {
    l.push('## Datos', '');
    for (const [k, v] of datos) l.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    l.push('');
  }
  if (apuntes.length) {
    l.push('## Apuntes', '');
    for (const a of apuntes) {
      const pie = [a.fecha, BASES[a.base], a.origen, a.origen_ref, a.vigente ? '' : 'ya no vigente']
        .filter(Boolean)
        .join('; ');
      l.push(`- ${a.texto.replace(/\n/g, '\n  ')}${pie ? `\n  (${pie})` : ''}`);
    }
    l.push('');
  }
  if (enlaces.length) {
    l.push('## Enlaces', '');
    for (const e of enlaces) {
      l.push(`- ${e.relacion ? e.relacion + ': ' : ''}[[${e.titulo}]]${e.nota ? ` (${e.nota})` : ''}`);
    }
    l.push('');
  }
  if (archivos.length) {
    l.push('## Archivos', '');
    for (const a of archivos) l.push(`- ${a.nombre}${a.descripcion ? `: ${a.descripcion}` : ''} (archivos/${a.ruta})`);
    l.push('');
  }
  return l.join('\n');
}

function agrupar(filas, clave) {
  const mapa = new Map();
  for (const fila of filas) {
    const k = fila[clave];
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(fila);
  }
  return mapa;
}

/**
 * Escribe una copia completa en `salida` (cualquier destino de escritura).
 * Con `conArchivos`, suma las imágenes y los documentos.
 */
export async function escribirCopia(salida, { conArchivos = false } = {}) {
  // Todo se lee en una sola foto del fichero, para que la copia sea coherente.
  const cliente = await conexion().connect();
  const tablas = {};
  try {
    await cliente.query('begin transaction isolation level repeatable read read only');
    for (const tabla of TABLAS) {
      const orden = tabla === 'capas' ? 'orden, clave' : tabla === 'historial' ? 'id' : '1';
      // La base arma cada fila como JSON: así las fechas salen con toda su
      // precisión y la copia se restaura idéntica.
      const filas = await cliente.query(
        `select to_jsonb(t) - $1::text[] as fila from ${tabla} t order by ${orden}`,
        [COLUMNAS_FUERA],
      );
      tablas[tabla] = filas.rows.map((f) => f.fila);
    }
    await cliente.query('commit');
  } catch (error) {
    await cliente.query('rollback').catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }

  const terminado = new Promise((resolver, rechazar) => {
    salida.on('finish', resolver);
    salida.on('error', rechazar);
  });
  const zip = new Zip((error, pedazo, final) => {
    if (error) {
      salida.destroy(error);
      return;
    }
    salida.write(Buffer.from(pedazo));
    if (final) salida.end();
  });
  const agregarTexto = (nombre, contenido) => {
    const entrada = new ZipDeflate(nombre, { level: 6 });
    zip.add(entrada);
    entrada.push(Buffer.from(contenido, 'utf8'), true);
  };

  agregarTexto('LEEME.txt', LEEME);
  agregarTexto(
    'datos/copia.json',
    JSON.stringify(
      { programa: 'MeetMyMind', formato: 1, hecha: new Date().toISOString(), con_archivos: conArchivos, tablas: TABLAS },
      null,
      1,
    ),
  );
  for (const tabla of TABLAS) {
    agregarTexto(`datos/${tabla}.json`, JSON.stringify(tablas[tabla], null, 1));
  }

  const titulos = new Map(tablas.fichas.map((f) => [f.id, f.titulo]));
  const apuntesDe = agrupar(tablas.apuntes.filter((a) => a.estado === 'activo'), 'ficha_id');
  const archivosDe = agrupar(tablas.archivos.filter((a) => a.estado === 'activo'), 'ficha_id');
  const enlacesDe = new Map();
  for (const e of tablas.enlaces) {
    for (const [propia, otra] of [[e.desde, e.hacia], [e.hacia, e.desde]]) {
      if (!enlacesDe.has(propia)) enlacesDe.set(propia, []);
      enlacesDe.get(propia).push({ relacion: e.relacion, nota: e.nota, titulo: titulos.get(otra) ?? otra });
    }
  }
  for (const ficha of tablas.fichas) {
    if (ficha.estado === 'borrada') continue;
    agregarTexto(
      `fichas/${ficha.capa}/${slug(ficha.titulo)}--${ficha.id.slice(0, 8)}.md`,
      fichaComoTexto(ficha, apuntesDe.get(ficha.id) ?? [], enlacesDe.get(ficha.id) ?? [], archivosDe.get(ficha.id) ?? []),
    );
  }

  if (conArchivos) {
    for (const archivo of tablas.archivos) {
      let contenido;
      try {
        contenido = await fsp.readFile(rutaEnDisco(archivo.ruta));
      } catch {
        continue; // Un archivo que falta en el disco no frena la copia.
      }
      const entrada = new ZipPassThrough('archivos/' + archivo.ruta.split(path.sep).join('/'));
      zip.add(entrada);
      entrada.push(contenido, true);
    }
  }
  zip.end();
  await terminado;
  return { fichas: tablas.fichas.length, apuntes: tablas.apuntes.length };
}

// --- copias diarias ---------------------------------------------------------

const dirCopias = () => path.join(config.dirDatos, 'copias');
const NOMBRE_COPIA = /^meetmymind-(\d{4}-\d{2}-\d{2})(?:-\d{4})?\.zip$/;

export async function listarCopias() {
  let nombres = [];
  try {
    nombres = await fsp.readdir(dirCopias());
  } catch {
    return [];
  }
  const copias = [];
  for (const nombre of nombres) {
    if (!NOMBRE_COPIA.test(nombre)) continue;
    const info = await fsp.stat(path.join(dirCopias(), nombre));
    copias.push({ nombre, bytes: info.size, hecha: info.mtime });
  }
  return copias.sort((a, b) => b.hecha - a.hecha);
}

export function rutaDeCopia(nombre) {
  if (!NOMBRE_COPIA.test(nombre)) return null;
  return path.join(dirCopias(), nombre);
}

/** Hace una copia en la carpeta de copias y borra las más viejas. */
export async function hacerCopia({ manual = false } = {}) {
  await fsp.mkdir(dirCopias(), { recursive: true });
  const ahora = new Date();
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.zonaHoraria,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(ahora)
    .replace(':', '');
  const nombre = manual ? `meetmymind-${hoy(ahora)}-${hora}.zip` : `meetmymind-${hoy(ahora)}.zip`;
  const destino = path.join(dirCopias(), nombre);
  const temporal = destino + '.parcial';
  try {
    await escribirCopia(fs.createWriteStream(temporal));
    await fsp.rename(temporal, destino);
  } catch (error) {
    await fsp.rm(temporal, { force: true });
    throw error;
  }
  const copias = await listarCopias();
  for (const vieja of copias.slice(Math.max(config.copiasAGuardar, 1))) {
    await fsp.rm(path.join(dirCopias(), vieja.nombre), { force: true });
  }
  return nombre;
}

/** Hace la copia del día si todavía no está hecha y ya pasó la hora. */
export async function copiaDelDiaSiFalta() {
  const ahora = new Date();
  const horaLocal = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: config.zonaHoraria, hour: '2-digit', hourCycle: 'h23' }).format(ahora),
  );
  if (horaLocal < config.horaDeCopia) return null;
  const nombre = `meetmymind-${hoy(ahora)}.zip`;
  try {
    await fsp.access(path.join(dirCopias(), nombre));
    return null;
  } catch {
    return hacerCopia();
  }
}

/**
 * Restaura una copia sobre un fichero recién creado y vacío.
 * `tablas` es el contenido de datos/*.json ya leído: { capas: [...], fichas: [...], ... }.
 */
export async function restaurar(tablas) {
  const cliente = await conexion().connect();
  try {
    await cliente.query('begin');
    const hay = await cliente.query('select (select count(*) from fichas)::int as fichas, (select count(*) from historial)::int as historial');
    const { rows } = await cliente.query("select count(*)::int as n from fichas where capa <> 'manual'");
    if (rows[0].n > 0) {
      throw new Error('El fichero de destino ya tiene fichas. La restauración es solo sobre uno vacío.');
    }
    // Se apagan los disparadores que anotan cambios: lo que entra es la copia
    // tal cual, con su propio historial. Los que arman los campos de búsqueda
    // quedan encendidos.
    const apagar = [
      ...TABLAS.filter((t) => t !== 'historial').map((t) => [t, `${t}_historial`]),
      ['apuntes', 'apuntes_tocar'],
      ['archivos', 'archivos_tocar'],
      ['enlaces', 'enlaces_tocar'],
    ];
    for (const [tabla, disparador] of apagar) {
      await cliente.query(`alter table ${tabla} disable trigger ${disparador}`);
    }
    await cliente.query('truncate historial restart identity');
    await cliente.query('truncate capas, fichas, apuntes, enlaces, archivos, bandeja cascade');
    const cuenta = {};
    for (const tabla of TABLAS) {
      const filas = tablas[tabla] ?? [];
      cuenta[tabla] = filas.length;
      if (!filas.length) continue;
      const tipos = await cliente.query(
        `select column_name, data_type from information_schema.columns
          where table_schema = current_schema() and table_name = $1`,
        [tabla],
      );
      const tipoDe = new Map(tipos.rows.map((t) => [t.column_name, t.data_type]));
      // Los apuntes que reemplazan a otros se cargan en dos pasos.
      const despues = [];
      for (const fila of filas) {
        const columnas = Object.keys(fila).filter((c) => tipoDe.has(c));
        const valores = columnas.map((c) => {
          if (tabla === 'apuntes' && c === 'reemplazado_por' && fila[c]) {
            despues.push([fila.id, fila[c]]);
            return null;
          }
          return ['jsonb', 'json'].includes(tipoDe.get(c)) && fila[c] !== null ? JSON.stringify(fila[c]) : fila[c];
        });
        const extra = tabla === 'historial' ? ' overriding system value' : '';
        await cliente.query(
          `insert into ${tabla} (${columnas.join(', ')})${extra} values (${columnas.map((_, i) => '$' + (i + 1)).join(', ')})`,
          valores,
        );
      }
      if (despues.length) {
        // Sin el disparador que corre la fecha de "actualizado".
        await cliente.query('alter table apuntes disable trigger apuntes_preparar');
        for (const [id, reemplazo] of despues) {
          await cliente.query('update apuntes set reemplazado_por = $2 where id = $1', [id, reemplazo]);
        }
        await cliente.query('alter table apuntes enable trigger apuntes_preparar');
      }
    }
    await cliente.query(
      "select setval(pg_get_serial_sequence('historial', 'id'), greatest((select coalesce(max(id), 0) from historial), 1))",
    );
    for (const [tabla, disparador] of apagar) {
      await cliente.query(`alter table ${tabla} enable trigger ${disparador}`);
    }
    await cliente.query('commit');
    return { antes: hay.rows[0], restaurado: cuenta };
  } catch (error) {
    await cliente.query('rollback').catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}
