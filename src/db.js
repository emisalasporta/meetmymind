// Conexión con el fichero (PostgreSQL) y aplicación de las migraciones.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

// Las fechas sin hora se manejan como texto "AAAA-MM-DD": así un día no se
// corre por la zona horaria.
pg.types.setTypeParser(1082, (v) => v);
// Los contadores (bigint) como número común.
pg.types.setTypeParser(20, (v) => Number(v));

const aqui = path.dirname(fileURLToPath(import.meta.url));

let pool;

export function conexion() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.baseDeDatos, max: 10 });
    pool.on('error', (e) => console.error('Error en la conexión con el fichero:', e.message));
  }
  return pool;
}

export async function cerrar() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function consultar(texto, valores) {
  return conexion().query(texto, valores);
}

/**
 * Ejecuta varias operaciones como una sola: o se hacen todas o ninguna.
 * `quien` y `motivo` quedan anotados en el historial de cada cambio.
 */
export async function enTransaccion({ quien = 'sistema', motivo = '' } = {}, tarea) {
  const cliente = await conexion().connect();
  try {
    await cliente.query('begin');
    await cliente.query(
      "select set_config('mmm.quien', $1, true), set_config('mmm.motivo', $2, true)",
      [String(quien).slice(0, 200), String(motivo ?? '').slice(0, 2000)],
    );
    const resultado = await tarea(cliente);
    await cliente.query('commit');
    return resultado;
  } catch (error) {
    await cliente.query('rollback').catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

/** Aplica, en orden, las migraciones que todavía no se aplicaron. */
export async function migrar() {
  const cliente = await conexion().connect();
  try {
    // Un solo proceso migra a la vez.
    await cliente.query('select pg_advisory_lock(727272)');
    await cliente.query(`
      create table if not exists migraciones (
        nombre   text primary key,
        aplicada timestamptz not null default now()
      )`);
    const hechas = new Set(
      (await cliente.query('select nombre from migraciones')).rows.map((f) => f.nombre),
    );
    const dir = path.join(aqui, 'migraciones');
    const archivos = (await fs.readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
    const aplicadas = [];
    for (const nombre of archivos) {
      if (hechas.has(nombre)) continue;
      const sql = await fs.readFile(path.join(dir, nombre), 'utf8');
      await cliente.query('begin');
      try {
        await cliente.query(sql);
        await cliente.query('insert into migraciones (nombre) values ($1)', [nombre]);
        await cliente.query('commit');
        aplicadas.push(nombre);
      } catch (error) {
        await cliente.query('rollback');
        throw new Error(`No se pudo aplicar ${nombre}: ${error.message}`);
      }
    }
    return aplicadas;
  } finally {
    await cliente.query('select pg_advisory_unlock(727272)').catch(() => {});
    cliente.release();
  }
}
