// Restaura una copia de MeetMyMind en un fichero recién creado.
//
//   node scripts/restaurar.js /ruta/a/meetmymind-AAAA-MM-DD.zip
//
// Necesita las mismas variables que el programa (DATABASE_URL y DIR_DATOS).
// Solo funciona sobre un fichero sin fichas propias: nunca pisa uno en uso.

import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { config } from '../src/config.js';
import { migrar, cerrar } from '../src/db.js';
import { sembrar } from '../src/semilla.js';
import { restaurar, TABLAS } from '../src/exportar.js';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Falta la copia a restaurar: node scripts/restaurar.js copia.zip');
  process.exit(1);
}
if (!config.baseDeDatos) {
  console.error('Falta DATABASE_URL (la dirección del fichero).');
  process.exit(1);
}

try {
  const zip = unzipSync(new Uint8Array(await fs.readFile(archivo)));
  const tablas = {};
  for (const tabla of TABLAS) {
    const entrada = zip[`datos/${tabla}.json`];
    if (!entrada) throw new Error(`A la copia le falta datos/${tabla}.json`);
    tablas[tabla] = JSON.parse(strFromU8(entrada));
  }
  await migrar();
  await sembrar();
  const resultado = await restaurar(tablas);

  let archivos = 0;
  const raiz = path.resolve(config.dirDatos, 'archivos');
  for (const [nombre, contenido] of Object.entries(zip)) {
    if (!nombre.startsWith('archivos/') || nombre.endsWith('/')) continue;
    const destino = path.resolve(raiz, nombre.slice('archivos/'.length));
    if (!destino.startsWith(raiz + path.sep)) continue;
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, contenido);
    archivos += 1;
  }

  console.log('Restaurado:', resultado.restaurado);
  console.log(
    archivos
      ? `Archivos repuestos: ${archivos}.`
      : 'La copia no traía imágenes ni documentos (se hacen aparte, con "Descargar todo, con archivos").',
  );
} catch (error) {
  console.error('No se pudo restaurar:', error.message);
  process.exitCode = 1;
} finally {
  await cerrar();
}
