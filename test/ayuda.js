// Ayuda para las pruebas: deja el fichero de prueba vacío y recién armado.
import { consultar, migrar, cerrar } from '../src/db.js';
import { sembrar } from '../src/semilla.js';

export async function prepararBase() {
  await consultar('drop schema public cascade');
  await consultar('create schema public');
  await migrar();
  await sembrar();
}

export { cerrar };
export const EMI = { quien: 'emiliano' };
export const ALEX = { quien: 'alex (prueba)', motivo: 'prueba' };
