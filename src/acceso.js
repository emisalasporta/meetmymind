// Quién puede entrar a MeetMyMind y cómo.
//
// - Emiliano entra a la web con su clave.
// - Una IA entra por la entrada /mcp después de que Emiliano la autoriza con
//   esa misma clave (el estándar se llama OAuth). Cada IA autorizada queda
//   como un "acceso" que se puede cortar desde la web.
// - Un programa propio entra con una "llave": una contraseña larga creada
//   desde la web.
//
// Nunca se guarda una contraseña ni un pase tal cual: solo su huella.

import crypto from 'node:crypto';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from './config.js';
import { consultar, enTransaccion } from './db.js';

const MINUTO = 60 * 1000;
const DIA = 24 * 60 * MINUTO;

const DURACION_SESION = 30 * DIA;
const DURACION_PEDIDO = 10 * MINUTO;
const DURACION_CODIGO = 5 * MINUTO;
const DURACION_PASE = 60 * MINUTO;
const DURACION_RENOVACION = 90 * DIA;
// Si la misma renovación llega dos veces en este lapso se toma como un
// reintento por falla de red y no como un robo.
const GRACIA_RENOVACION = 2 * MINUTO;

const INTENTOS_POR_IP = 8;
const INTENTOS_TOTALES = 40;
const VENTANA_INTENTOS = 15 * MINUTO;

export const PREFIJO_LLAVE = 'mmm_llave_';

const huella = (valor) => crypto.createHash('sha256').update(String(valor)).digest('hex');
const alAzar = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const en = (ms) => new Date(Date.now() + ms);

// --- la clave ---------------------------------------------------------------

export function claveCorrecta(intento) {
  const a = crypto.createHash('sha256').update(String(intento ?? '')).digest();
  const b = crypto.createHash('sha256').update(config.clave).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function puedeIntentar(ip) {
  const r = await consultar(
    `select count(*) filter (where ip = $1)::int as de_esta_ip, count(*)::int as total
       from intentos where not bien and cuando > $2`,
    [ip, new Date(Date.now() - VENTANA_INTENTOS)],
  );
  return r.rows[0].de_esta_ip < INTENTOS_POR_IP && r.rows[0].total < INTENTOS_TOTALES;
}

export async function anotarIntento(ip, bien) {
  await consultar('insert into intentos (ip, bien) values ($1, $2)', [ip, bien]);
}

/**
 * Revisa una clave respetando el freno de intentos.
 * Devuelve 'bien', 'mal' o 'frenado'.
 */
export async function revisarClave(ip, intento) {
  if (!(await puedeIntentar(ip))) return 'frenado';
  const bien = claveCorrecta(intento);
  await anotarIntento(ip, bien);
  return bien ? 'bien' : 'mal';
}

// --- sesiones de la web -----------------------------------------------------

export async function abrirSesion() {
  const pase = alAzar();
  await consultar('insert into sesiones (id_hash, vence) values ($1, $2)', [
    huella(pase),
    en(DURACION_SESION),
  ]);
  return { pase, duracion: DURACION_SESION };
}

export async function sesionValida(pase) {
  if (!pase) return false;
  // Cada uso corre el vencimiento: la sesión dura mientras se la use.
  const r = await consultar(
    `update sesiones set ultimo_uso = now(), vence = $2
      where id_hash = $1 and vence > now() returning id_hash`,
    [huella(pase), en(DURACION_SESION)],
  );
  return r.rowCount === 1;
}

export async function cerrarSesion(pase) {
  if (pase) await consultar('delete from sesiones where id_hash = $1', [huella(pase)]);
}

export async function cerrarTodasLasSesiones() {
  await consultar('delete from sesiones');
}

// --- llaves para programas propios ------------------------------------------

export async function crearLlave(nombre) {
  const limpio = String(nombre ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!limpio) throw new Error('La llave necesita un nombre.');
  const llave = PREFIJO_LLAVE + alAzar();
  const r = await enTransaccion({ quien: 'emiliano', motivo: 'Llave nueva' }, (db) =>
    db.query('insert into llaves (nombre, token_hash) values ($1, $2) returning id, nombre, creado', [
      limpio,
      huella(llave),
    ]),
  );
  // La llave se muestra una sola vez: después solo queda su huella.
  return { ...r.rows[0], llave };
}

export async function listarLlaves() {
  const r = await consultar(
    'select id, nombre, creado, ultimo_uso, revocada from llaves order by revocada nulls first, creado desc',
  );
  return r.rows;
}

export async function revocarLlave(id) {
  await enTransaccion({ quien: 'emiliano', motivo: 'Llave revocada' }, (db) =>
    db.query('update llaves set revocada = now() where id = $1 and revocada is null', [id]),
  );
}

// --- accesos de las IA ------------------------------------------------------

export async function listarAccesos() {
  const r = await consultar(
    `select a.id, a.nombre, a.creado, a.ultimo_uso, a.revocado,
            c.datos ->> 'client_name' as programa
       from accesos a join oauth_clientes c on c.client_id = a.client_id
      order by a.revocado nulls first, a.creado desc`,
  );
  return r.rows;
}

export async function revocarAcceso(id, { quien = 'emiliano', motivo = 'Acceso cortado' } = {}) {
  await enTransaccion({ quien, motivo }, async (db) => {
    await db.query('update accesos set revocado = now() where id = $1 and revocado is null', [id]);
    await db.query('delete from oauth_tokens where acceso_id = $1', [id]);
    await db.query('delete from oauth_codigos where acceso_id = $1', [id]);
  });
}

export async function leerPedido(id) {
  if (!id) return null;
  const r = await consultar(
    `select s.id, s.params, s.vence, c.client_id, c.datos
       from oauth_solicitudes s join oauth_clientes c on c.client_id = s.client_id
      where s.id = $1 and s.vence > now()`,
    [String(id)],
  );
  return r.rows[0] ?? null;
}

function nombreDelPrograma(datos, redirectUri) {
  const nombre = String(datos?.client_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (nombre) return nombre;
  try {
    return new URL(redirectUri).hostname;
  } catch {
    return 'programa sin nombre';
  }
}

/**
 * Emiliano respondió a un pedido de conexión. Devuelve la dirección a la que
 * hay que mandar el navegador para que la IA se entere de la respuesta.
 */
export async function responderPedido(id, autoriza) {
  const pedido = await leerPedido(id);
  if (!pedido) return null;
  const { params } = pedido;
  const destino = new URL(params.redirectUri);
  if (params.state) destino.searchParams.set('state', params.state);

  if (!autoriza) {
    await consultar('delete from oauth_solicitudes where id = $1', [pedido.id]);
    destino.searchParams.set('error', 'access_denied');
    destino.searchParams.set('error_description', 'Emiliano no autorizó la conexión.');
    return destino.href;
  }

  const codigo = alAzar();
  const nombre = nombreDelPrograma(pedido.datos, params.redirectUri);
  await enTransaccion({ quien: 'emiliano', motivo: `Autorizó a ${nombre}` }, async (db) => {
    const acceso = await db.query(
      `insert into accesos (client_id, nombre, alcance, recurso) values ($1, $2, $3, $4) returning id`,
      [pedido.client_id, nombre, params.scopes ?? [], params.resource ?? ''],
    );
    await db.query(
      `insert into oauth_codigos (codigo_hash, acceso_id, client_id, redirect_uri, code_challenge, vence)
       values ($1, $2, $3, $4, $5, $6)`,
      [huella(codigo), acceso.rows[0].id, pedido.client_id, params.redirectUri, params.codeChallenge, en(DURACION_CODIGO)],
    );
    await db.query('delete from oauth_solicitudes where id = $1', [pedido.id]);
  });
  destino.searchParams.set('code', codigo);
  return destino.href;
}

async function emitirPases(db, accesoId, alcance) {
  const pase = alAzar();
  const renovacion = alAzar();
  await db.query(
    `insert into oauth_tokens (token_hash, acceso_id, tipo, vence)
     values ($1, $2, 'acceso', $3), ($4, $2, 'refresco', $5)`,
    [huella(pase), accesoId, en(DURACION_PASE), huella(renovacion), en(DURACION_RENOVACION)],
  );
  return {
    access_token: pase,
    token_type: 'Bearer',
    expires_in: Math.floor(DURACION_PASE / 1000),
    refresh_token: renovacion,
    ...(alcance?.length ? { scope: alcance.join(' ') } : {}),
  };
}

/**
 * La parte de MeetMyMind que cumple el estándar de autorización que usan las
 * IA para conectarse. La librería de MCP se ocupa del protocolo; esta clase
 * decide y guarda.
 */
export class Portero {
  get clientsStore() {
    return {
      getClient: async (clientId) => {
        const r = await consultar('select datos from oauth_clientes where client_id = $1', [clientId]);
        return r.rows[0]?.datos;
      },
      registerClient: async (cliente) => {
        await consultar('insert into oauth_clientes (client_id, datos) values ($1, $2)', [
          cliente.client_id,
          JSON.stringify(cliente),
        ]);
        return cliente;
      },
    };
  }

  // Una IA pide conectarse: se guarda el pedido y se manda a Emiliano a la
  // pantalla donde decide.
  async authorize(cliente, params, res) {
    const id = alAzar(24);
    await consultar('insert into oauth_solicitudes (id, client_id, params, vence) values ($1, $2, $3, $4)', [
      id,
      cliente.client_id,
      JSON.stringify({
        state: params.state,
        scopes: params.scopes ?? [],
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        resource: params.resource?.href,
      }),
      en(DURACION_PEDIDO),
    ]);
    res.redirect(302, '/autorizar?pedido=' + encodeURIComponent(id));
  }

  async challengeForAuthorizationCode(cliente, codigo) {
    // Un código ya usado también pasa por acá: el canje de más abajo es el
    // que detecta la repetición y corta el acceso.
    const r = await consultar(
      'select code_challenge from oauth_codigos where codigo_hash = $1 and client_id = $2',
      [huella(codigo), cliente.client_id],
    );
    if (!r.rowCount) throw new InvalidGrantError('El código no es válido o ya venció.');
    return r.rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(cliente, codigo, _verificador, redirectUri) {
    return enTransaccion({ quien: 'sistema', motivo: 'Conexión de una IA' }, async (db) => {
      const r = await db.query(
        `select k.acceso_id, k.redirect_uri, k.usado, k.vence, a.alcance, a.revocado
           from oauth_codigos k join accesos a on a.id = k.acceso_id
          where k.codigo_hash = $1 and k.client_id = $2
          for update of k`,
        [huella(codigo), cliente.client_id],
      );
      const fila = r.rows[0];
      if (!fila || fila.revocado) throw new InvalidGrantError('El código no es válido.');
      if (fila.usado) {
        // Un código usado dos veces es señal de que alguien lo copió.
        await db.query('update accesos set revocado = now() where id = $1 and revocado is null', [fila.acceso_id]);
        await db.query('delete from oauth_tokens where acceso_id = $1', [fila.acceso_id]);
        return { robo: true };
      }
      if (fila.vence < new Date()) throw new InvalidGrantError('El código ya venció.');
      if (redirectUri && redirectUri !== fila.redirect_uri) {
        throw new InvalidGrantError('La dirección de retorno no coincide.');
      }
      await db.query('update oauth_codigos set usado = now() where codigo_hash = $1', [huella(codigo)]);
      return emitirPases(db, fila.acceso_id, fila.alcance);
    }).then((resultado) => {
      if (resultado.robo) throw new InvalidGrantError('El código ya fue usado.');
      return resultado;
    });
  }

  async exchangeRefreshToken(cliente, renovacion) {
    return enTransaccion({ quien: 'sistema', motivo: 'Renovación del pase de una IA' }, async (db) => {
      const r = await db.query(
        `select t.acceso_id, t.usado, t.vence, a.alcance, a.revocado, a.client_id
           from oauth_tokens t join accesos a on a.id = t.acceso_id
          where t.token_hash = $1 and t.tipo = 'refresco'
          for update of t`,
        [huella(renovacion)],
      );
      const fila = r.rows[0];
      if (!fila || fila.client_id !== cliente.client_id || fila.revocado || fila.vence < new Date()) {
        throw new InvalidGrantError('La renovación no es válida.');
      }
      if (fila.usado && Date.now() - fila.usado.getTime() > GRACIA_RENOVACION) {
        // Una renovación vieja que reaparece es señal de robo: se corta el acceso.
        await db.query('update accesos set revocado = now() where id = $1 and revocado is null', [fila.acceso_id]);
        await db.query('delete from oauth_tokens where acceso_id = $1', [fila.acceso_id]);
        return { robo: true };
      }
      await db.query('update oauth_tokens set usado = coalesce(usado, now()) where token_hash = $1', [
        huella(renovacion),
      ]);
      return emitirPases(db, fila.acceso_id, fila.alcance);
    }).then((resultado) => {
      if (resultado.robo) throw new InvalidGrantError('La renovación ya había sido usada.');
      return resultado;
    });
  }

  // Revisa el pase que trae cada pedido a la entrada.
  async verifyAccessToken(pase) {
    if (pase.startsWith(PREFIJO_LLAVE)) {
      const r = await consultar(
        `update llaves set ultimo_uso = now()
          where token_hash = $1 and revocada is null returning id, nombre`,
        [huella(pase)],
      );
      if (!r.rowCount) throw new InvalidTokenError('La llave no es válida.');
      return {
        token: pase,
        clientId: 'llave:' + r.rows[0].id,
        scopes: ['mente'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { quien: `alex (${r.rows[0].nombre})` },
      };
    }
    const r = await consultar(
      `select t.vence, a.id as acceso_id, a.nombre, a.client_id, a.alcance, a.recurso
         from oauth_tokens t join accesos a on a.id = t.acceso_id
        where t.token_hash = $1 and t.tipo = 'acceso' and t.vence > now() and a.revocado is null`,
      [huella(pase)],
    );
    const fila = r.rows[0];
    if (!fila) throw new InvalidTokenError('El pase no es válido o ya venció.');
    // Anotar el último uso, como mucho una vez por minuto.
    consultar(
      `update accesos set ultimo_uso = now()
        where id = $1 and (ultimo_uso is null or ultimo_uso < now() - interval '1 minute')`,
      [fila.acceso_id],
    ).catch(() => {});
    return {
      token: pase,
      clientId: fila.client_id,
      scopes: fila.alcance,
      expiresAt: Math.floor(fila.vence.getTime() / 1000),
      ...(fila.recurso ? { resource: new URL(fila.recurso) } : {}),
      extra: { quien: `alex (${fila.nombre})`, acceso: fila.acceso_id },
    };
  }

  // La IA avisa que ya no va a usar un pase.
  async revokeToken(cliente, pedido) {
    const r = await consultar(
      `select t.tipo, t.acceso_id from oauth_tokens t join accesos a on a.id = t.acceso_id
        where t.token_hash = $1 and a.client_id = $2`,
      [huella(pedido.token), cliente.client_id],
    );
    const fila = r.rows[0];
    if (!fila) return;
    if (fila.tipo === 'refresco') {
      await revocarAcceso(fila.acceso_id, { quien: 'sistema', motivo: 'La IA se desconectó' });
    } else {
      await consultar('delete from oauth_tokens where token_hash = $1', [huella(pedido.token)]);
    }
  }
}

// --- limpieza ---------------------------------------------------------------

/** Borra lo vencido. No toca nada que siga sirviendo. */
export async function limpiarVencidos() {
  await consultar('delete from sesiones where vence < now()');
  await consultar('delete from oauth_solicitudes where vence < now()');
  await consultar("delete from oauth_codigos where vence < now() - interval '1 day'");
  await consultar("delete from oauth_tokens where vence < now() - interval '1 day'");
  await consultar("delete from intentos where cuando < now() - interval '30 days'");
  // Programas que pidieron conectarse y nunca fueron autorizados.
  await consultar(
    `delete from oauth_clientes c
      where c.creado < now() - interval '2 days'
        and not exists (select 1 from accesos a where a.client_id = c.client_id)`,
  );
}
