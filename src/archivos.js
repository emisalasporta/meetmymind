// La carpeta de archivos: imágenes y documentos que acompañan a una ficha.
// El archivo se guarda en el disco; en el fichero queda la referencia.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { consultar, enTransaccion } from './db.js';
import { ErrorDeUso } from './nucleo.js';

export const TAMANO_MAXIMO = 25 * 1024 * 1024;
const LADO_MAXIMO = 2000;

const IMAGENES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.heic', '.heif']);
const DOCUMENTOS = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.gif': 'image/gif',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.gpx': 'application/gpx+xml',
  '.zip': 'application/zip',
};
const AUDIO_Y_VIDEO = new Set([
  '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.aac', '.flac', '.wma', '.amr', '.aiff',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.3gp', '.mpg', '.mpeg', '.mts',
]);

const NO_AUDIO_NI_VIDEO =
  'Los archivos de audio y de video no se guardan en MeetMyMind. De ellos queda el resumen o el enlace, y de dónde vinieron.';

/** Reconoce audio y video por el contenido, aunque el nombre diga otra cosa. */
function pareceAudioOVideo(b) {
  if (b.length < 12) return false;
  const ascii = (desde, hasta) => b.toString('latin1', desde, hasta);
  if (ascii(4, 8) === 'ftyp') {
    // Familia MP4: video y audio, pero también fotos HEIC y AVIF.
    return !/^(heic|heix|hevc|mif1|msf1|avif|avis)/.test(ascii(8, 12));
  }
  if (ascii(0, 3) === 'ID3' || ascii(0, 4) === 'OggS' || ascii(0, 4) === 'fLaC') return true;
  if (ascii(0, 4) === 'RIFF' && ['WAVE', 'AVI '].includes(ascii(8, 12))) return true;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // MKV, WebM
  return false;
}

function nombreLimpio(nombre) {
  const base = path.basename(String(nombre ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return (base || 'archivo').slice(0, 200);
}

export function rutaEnDisco(rutaRelativa) {
  const completa = path.resolve(config.dirDatos, 'archivos', rutaRelativa);
  const raiz = path.resolve(config.dirDatos, 'archivos');
  if (!completa.startsWith(raiz + path.sep)) throw new Error('Ruta de archivo inválida');
  return completa;
}

/** Guarda un archivo en una ficha. Las imágenes se achican y pasan a WebP. */
export async function guardarArchivo(contexto, { ficha_id, nombre, contenido, descripcion = '' }) {
  if (!Buffer.isBuffer(contenido) || contenido.length === 0) {
    throw new ErrorDeUso('El archivo llegó vacío.');
  }
  if (contenido.length > TAMANO_MAXIMO) {
    throw new ErrorDeUso(`El archivo pasa el máximo de ${TAMANO_MAXIMO / 1024 / 1024} MB.`);
  }
  const original = nombreLimpio(nombre);
  let extension = path.extname(original).toLowerCase();
  if (AUDIO_Y_VIDEO.has(extension) || pareceAudioOVideo(contenido)) {
    throw new ErrorDeUso(NO_AUDIO_NI_VIDEO, { codigo: 'audio_o_video' });
  }

  let datos = contenido;
  let tipo;
  let ancho = null;
  let alto = null;
  let nombreFinal = original;

  if (IMAGENES.has(extension)) {
    try {
      const { data, info } = await sharp(contenido, { failOn: 'none' })
        .rotate()
        .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      datos = data;
      ancho = info.width;
      alto = info.height;
      tipo = 'image/webp';
      extension = '.webp';
      nombreFinal = original.replace(/\.[^.]+$/, '') + '.webp';
    } catch {
      throw new ErrorDeUso('No se pudo leer esa imagen. Probá guardarla como JPG o PNG y subirla de nuevo.');
    }
  } else if (Object.hasOwn(DOCUMENTOS, extension)) {
    tipo = DOCUMENTOS[extension];
  } else {
    throw new ErrorDeUso(
      `No se guardan archivos "${extension || 'sin extensión'}". Se aceptan imágenes y documentos (PDF, texto, Word, Excel, PowerPoint).`,
    );
  }

  const id = crypto.randomUUID();
  const rutaRelativa = path.join(id.slice(0, 2), id + extension);
  const destino = rutaEnDisco(rutaRelativa);
  await fs.mkdir(path.dirname(destino), { recursive: true });
  await fs.writeFile(destino, datos);

  try {
    return await enTransaccion(contexto, async (db) => {
      const ficha = await db.query("select id from fichas where id = $1 and estado <> 'borrada'", [ficha_id]);
      if (!ficha.rowCount) throw new ErrorDeUso('Esa ficha no existe.', { codigo: 'no_existe' });
      const r = await db.query(
        `insert into archivos (id, ficha_id, nombre, tipo, bytes, ruta, ancho, alto, descripcion)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, ficha_id, nombre, tipo, bytes, ancho, alto, descripcion, creado`,
        [id, ficha_id, nombreFinal, tipo, datos.length, rutaRelativa, ancho, alto, String(descripcion ?? '').slice(0, 2000)],
      );
      return r.rows[0];
    });
  } catch (error) {
    await fs.rm(destino, { force: true });
    if (error?.code === '22P02') throw new ErrorDeUso('El identificador de ficha no es válido.');
    throw error;
  }
}

export async function leerArchivo(id) {
  const r = await consultar(
    `select id, ficha_id, nombre, tipo, bytes, ruta, ancho, alto, descripcion
       from archivos where id = $1 and estado = 'activo'`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function borrarArchivo(contexto, id) {
  return enTransaccion(contexto, async (db) => {
    const r = await db.query(
      "update archivos set estado = 'borrado' where id = $1 and estado = 'activo' returning id, ficha_id",
      [id],
    );
    if (!r.rowCount) throw new ErrorDeUso('Ese archivo no existe.', { codigo: 'no_existe' });
    return r.rows[0];
  });
}
