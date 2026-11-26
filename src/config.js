// Configuración. Todo lo que cambia entre la prueba y el servidor entra por
// variables de entorno; nada secreto vive en el código.

import path from 'node:path';

function leer(nombre, porDefecto) {
  const valor = process.env[nombre];
  return valor === undefined || valor === '' ? porDefecto : valor;
}

const urlPublica = new URL(leer('URL_PUBLICA', 'http://localhost:3000'));
// Sin barra final ni ruta: es la dirección base del lugar.
urlPublica.pathname = '/';
urlPublica.search = '';
urlPublica.hash = '';

export const config = {
  puerto: Number(leer('PUERTO', leer('PORT', '3000'))),
  baseDeDatos: leer('DATABASE_URL', ''),
  clave: leer('CLAVE', ''),
  urlPublica,
  dirDatos: path.resolve(leer('DIR_DATOS', './data')),
  zonaHoraria: leer('ZONA_HORARIA', 'America/Argentina/Catamarca'),
  // Cuántas copias diarias se conservan en el servidor.
  copiasAGuardar: Number(leer('COPIAS_A_GUARDAR', '14')),
  // Hora local a la que se hace la copia diaria.
  horaDeCopia: Number(leer('HORA_DE_COPIA', '4')),
  // Cuántos intermediarios hay delante (Cloudflare y el del servidor = 2).
  intermediarios: Number(leer('INTERMEDIARIOS', '1')),
  enPrueba: leer('NODE_ENV', '') === 'test',
};

export const esHttps = urlPublica.protocol === 'https:';
export const urlEntrada = new URL('/mcp', urlPublica);

export function revisarConfig() {
  const faltan = [];
  if (!config.baseDeDatos) faltan.push('DATABASE_URL (la dirección del fichero)');
  if (!config.clave) faltan.push('CLAVE (la clave de entrada)');
  if (faltan.length) {
    throw new Error('Falta configurar: ' + faltan.join('; '));
  }
  if (config.clave.length < 12) {
    throw new Error('La CLAVE tiene que tener 12 caracteres o más.');
  }
}
