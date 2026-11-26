// El núcleo de MeetMyMind: todo lo que se puede hacer con el fichero.
// La web y la entrada para las IA usan estas mismas funciones, así que las
// dos se comportan igual y los criterios se aplican en un solo lugar.

import { consultar, enTransaccion } from './db.js';

/** Error por algo que pidió quien usa el lugar (no una falla del programa). */
export class ErrorDeUso extends Error {
  constructor(mensaje, { codigo = 'pedido_invalido', datos } = {}) {
    super(mensaje);
    this.name = 'ErrorDeUso';
    this.codigo = codigo;
    this.datos = datos;
  }
}

/** En qué se apoya un dato. */
export const BASES = {
  dicho_por_emiliano: 'Lo dijo Emiliano',
  deducido_por_alex: 'Deducción de Alex',
  dicho_por_otro: 'Lo dijo otra persona',
  registro: 'Consta en un registro',
};

export const ESTADOS_FICHA = ['activa', 'archivada', 'borrada'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PARECIDO_MINIMO = 0.55;

const COLUMNAS_FICHA = `f.id, f.capa, f.tipo, f.titulo, f.cuerpo, f.datos, f.alias, f.fecha,
  f.origen, f.origen_ref, f.estado, f.creada, f.actualizada`;

// --- validaciones -----------------------------------------------------------

function pedirId(valor, nombre = 'id') {
  if (typeof valor !== 'string' || !UUID.test(valor)) {
    throw new ErrorDeUso(`El ${nombre} no es válido.`);
  }
  return valor.toLowerCase();
}

function texto(valor, { max = 200000 } = {}) {
  if (valor === undefined || valor === null) return '';
  return String(valor).replace(/\u0000/g, '').slice(0, max);
}

function textoCorto(valor, max = 300) {
  return texto(valor, { max }).replace(/\s+/g, ' ').trim();
}

function fechaONada(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const v = String(valor).trim();
  if (!FECHA.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new ErrorDeUso(`La fecha "${v}" no es válida. Va como AAAA-MM-DD.`);
  }
  // Rechaza fechas imposibles como 2026-02-31.
  if (new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) {
    throw new ErrorDeUso(`La fecha "${v}" no existe.`);
  }
  return v;
}

function listaDeAlias(valor) {
  if (valor === undefined || valor === null) return [];
  const lista = Array.isArray(valor) ? valor : String(valor).split(',');
  const vistos = new Set();
  const salida = [];
  for (const item of lista) {
    const limpio = textoCorto(item, 120);
    const clave = limpio.toLowerCase();
    if (limpio && !vistos.has(clave)) {
      vistos.add(clave);
      salida.push(limpio);
    }
  }
  return salida.slice(0, 40);
}

function objetoDeDatos(valor) {
  if (valor === undefined || valor === null || valor === '') return {};
  if (typeof valor !== 'object' || Array.isArray(valor)) {
    throw new ErrorDeUso('Los datos de la ficha van como pares de nombre y valor.');
  }
  return valor;
}

function baseValida(valor) {
  const base = valor || 'dicho_por_emiliano';
  if (!Object.hasOwn(BASES, base)) {
    throw new ErrorDeUso(
      `La base "${base}" no existe. Las posibles son: ${Object.keys(BASES).join(', ')}.`,
    );
  }
  return base;
}

function limite(valor, porDefecto, maximo) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 1) return porDefecto;
  return Math.min(Math.floor(n), maximo);
}

function escaparLike(valor) {
  return valor.replace(/[\\%_]/g, (c) => '\\' + c);
}

async function pedirCapa(db, clave) {
  const r = await db.query('select clave from capas where clave = $1', [clave]);
  if (!r.rowCount) {
    const todas = (await db.query('select clave from capas order by orden')).rows.map((f) => f.clave);
    throw new ErrorDeUso(`La capa "${clave}" no existe. Las capas son: ${todas.join(', ')}.`);
  }
  return clave;
}

async function pedirFicha(db, id, { conBorradas = false } = {}) {
  pedirId(id, 'identificador de ficha');
  const r = await db.query(`select ${COLUMNAS_FICHA} from fichas f where f.id = $1`, [id]);
  const ficha = r.rows[0];
  if (!ficha || (!conBorradas && ficha.estado === 'borrada')) {
    throw new ErrorDeUso('Esa ficha no existe.', { codigo: 'no_existe' });
  }
  return ficha;
}

// --- capas y panorama -------------------------------------------------------

export async function listarCapas() {
  const r = await consultar(`
    select c.clave, c.nombre, c.descripcion, c.orden,
           count(f.id) filter (where f.estado = 'activa')::int as fichas
      from capas c
      left join fichas f on f.capa = c.clave
     group by c.clave
     order by c.orden, c.nombre`);
  return r.rows;
}

export async function panorama() {
  const [capas, bandeja, cambios, ultima] = await Promise.all([
    listarCapas(),
    consultar("select count(*)::int as n from bandeja where estado = 'pendiente'"),
    consultar("select count(*)::int as n from historial where cuando > now() - interval '7 days'"),
    consultar('select max(cuando) as cuando from historial'),
  ]);
  return {
    capas,
    fichas: capas.reduce((suma, c) => suma + c.fichas, 0),
    bandeja_pendiente: bandeja.rows[0].n,
    cambios_ultimos_7_dias: cambios.rows[0].n,
    ultimo_cambio: ultima.rows[0].cuando,
  };
}

export async function tiposDeCapa(capa) {
  const r = await consultar(
    `select tipo, count(*)::int as fichas from fichas
      where capa = $1 and estado = 'activa' group by tipo order by count(*) desc, tipo`,
    [capa],
  );
  return r.rows;
}

// --- buscar y listar --------------------------------------------------------

export async function buscar({ texto: consulta, capa, tipo, limite: lim, conArchivadas = false } = {}) {
  const q = textoCorto(consulta, 300);
  if (!q) throw new ErrorDeUso('Falta el texto a buscar.');
  const estados = conArchivadas ? ['activa', 'archivada'] : ['activa'];
  const r = await consultar(
    `with q as (
       select mmm_normalizar($1) as n,
              websearch_to_tsquery('spanish', mmm_normalizar($1)) as ts
     ),
     por_ficha as (
       select f.id,
              ts_rank(f.busqueda, q.ts) as r_texto,
              word_similarity(q.n, f.nombres) as r_nombre,
              (f.nombres like '%' || $2 || '%') as contiene
         from fichas f, q
        where f.estado = any($3)
          and ($4::text is null or f.capa = $4)
          and ($5::text is null or mmm_normalizar(f.tipo) = mmm_normalizar($5))
          and (f.busqueda @@ q.ts or f.nombres like '%' || $2 || '%' or q.n <% f.nombres)
     ),
     por_apunte as (
       select a.ficha_id as id,
              max(ts_rank(a.busqueda, q.ts)) as r_apunte,
              (array_agg(a.texto order by ts_rank(a.busqueda, q.ts) desc))[1] as apunte
         from apuntes a, q
        where a.estado = 'activo' and a.busqueda @@ q.ts
        group by a.ficha_id
     ),
     todo as (
       select coalesce(pf.id, pa.id) as id,
              coalesce(pf.contiene, false)::int * 2
                + coalesce(pf.r_nombre, 0) * 1.5
                + coalesce(pf.r_texto, 0)
                + coalesce(pa.r_apunte, 0) * 0.5 as puntaje,
              pa.apunte
         from por_ficha pf
         full join por_apunte pa on pa.id = pf.id
     )
     select f.id, f.capa, f.tipo, f.titulo, f.alias, f.fecha, f.estado, f.actualizada,
            left(f.cuerpo, 240) as extracto, t.apunte as apunte_coincidente,
            round(t.puntaje::numeric, 3)::float as puntaje
       from todo t
       join fichas f on f.id = t.id
      where f.estado = any($3)
        and ($4::text is null or f.capa = $4)
        and ($5::text is null or mmm_normalizar(f.tipo) = mmm_normalizar($5))
      order by t.puntaje desc, f.actualizada desc
      limit $6`,
    [q, escaparLike(normalizar(q)), estados, capa || null, tipo || null, limite(lim, 20, 100)],
  );
  return r.rows;
}

/** Misma normalización que hace el fichero, para armar comparaciones. */
function normalizar(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export async function listarFichas({
  capa,
  tipo,
  estado = 'activa',
  orden = 'recientes',
  limite: lim,
  salto = 0,
} = {}) {
  const ordenes = {
    recientes: 'f.actualizada desc',
    titulo: 'mmm_normalizar(f.titulo) asc',
    fecha: 'f.fecha desc nulls last, f.actualizada desc',
  };
  const r = await consultar(
    `select f.id, f.capa, f.tipo, f.titulo, f.alias, f.fecha, f.estado, f.actualizada,
            left(f.cuerpo, 160) as extracto
       from fichas f
      where f.estado = $1
        and ($2::text is null or f.capa = $2)
        and ($3::text is null or f.tipo = $3)
      order by ${ordenes[orden] || ordenes.recientes}
      limit $4 offset $5`,
    [estado, capa || null, tipo ?? null, limite(lim, 50, 500), Math.max(0, Number(salto) || 0)],
  );
  return r.rows;
}

/**
 * Fichas que podrían ser la misma que se está por crear.
 * Un hecho (una reunión, un mensaje) se repite si viene del mismo origen o si
 * tiene el mismo día y un título parecido: dos reuniones con la misma persona
 * en días distintos son dos hechos. El resto se compara por nombre y alias.
 */
export async function similares(
  { titulo, alias = [], capa, fecha, origen_ref, excluir } = {},
  db = { query: consultar },
) {
  const nombres = [titulo, ...alias].map(normalizar).map((n) => n.trim()).filter(Boolean);
  if (!nombres.length) return [];
  const esHecho = capa === 'hechos';
  const r = await db.query(
    `select f.id, f.capa, f.tipo, f.titulo, f.alias, f.fecha, f.estado,
            (select max(greatest(
                      similarity(mmm_normalizar(f.titulo), n),
                      coalesce((select max(similarity(mmm_normalizar(a), n)) from unnest(f.alias) a), 0)))
               from unnest($1::text[]) n) as parecido,
            ($5 <> '' and f.origen_ref = $5) as mismo_origen
       from fichas f
      where f.estado <> 'borrada'
        and ($2::uuid is null or f.id <> $2)
        and (f.capa = 'hechos') = $3
        and (
          ($5 <> '' and f.origen_ref = $5)
          or (
            ($3 = false or f.fecha is not distinct from $4::date)
            and exists (select 1 from unnest($1::text[]) n where f.nombres % n or n <% f.nombres)
          )
        )
      order by mismo_origen desc, parecido desc
      limit 8`,
    [nombres, excluir || null, esHecho, fecha || null, esHecho ? String(origen_ref || '').trim() : ''],
  );
  return r.rows
    .filter((f) => f.mismo_origen || f.parecido >= PARECIDO_MINIMO)
    .map(({ mismo_origen, ...f }) => ({
      ...f,
      parecido: Math.round(f.parecido * 100) / 100,
      ...(mismo_origen ? { mismo_origen: true } : {}),
    }));
}

// --- leer una ficha ---------------------------------------------------------

export async function leerFicha(id, { conBorradas = false } = {}) {
  const ficha = await pedirFicha({ query: consultar }, id, { conBorradas });
  const [apuntes, enlaces, archivos] = await Promise.all([
    consultar(
      `select a.id, a.texto, a.fecha, a.base, a.origen, a.origen_ref, a.hecho_id,
              h.titulo as hecho_titulo, a.vigente, a.reemplazado_por, a.creado, a.actualizado
         from apuntes a
         left join fichas h on h.id = a.hecho_id
        where a.ficha_id = $1 and a.estado = 'activo'
        order by a.vigente desc, coalesce(a.fecha, a.creado::date) desc, a.creado desc`,
      [id],
    ),
    consultar(
      `select e.id, e.relacion, e.nota, 'sale' as sentido,
              f.id as ficha_id, f.titulo, f.capa, f.tipo, f.fecha
         from enlaces e join fichas f on f.id = e.hacia
        where e.desde = $1 and f.estado <> 'borrada'
       union all
       select e.id, e.relacion, e.nota, 'entra' as sentido,
              f.id as ficha_id, f.titulo, f.capa, f.tipo, f.fecha
         from enlaces e join fichas f on f.id = e.desde
        where e.hacia = $1 and f.estado <> 'borrada'
        order by fecha desc nulls last, titulo`,
      [id],
    ),
    consultar(
      `select id, nombre, tipo, bytes, ancho, alto, descripcion, creado
         from archivos where ficha_id = $1 and estado = 'activo' order by creado`,
      [id],
    ),
  ]);
  return { ...ficha, apuntes: apuntes.rows, enlaces: enlaces.rows, archivos: archivos.rows };
}

// --- escribir fichas --------------------------------------------------------

/**
 * Crea una ficha. Si ya hay una parecida no la crea: devuelve las parecidas
 * para que quien pide decida (usar la que existe, o confirmar que es otra).
 */
export async function crearFicha(contexto, entrada, { confirmar = false } = {}) {
  const titulo = textoCorto(entrada.titulo, 300);
  if (!titulo) throw new ErrorDeUso('La ficha necesita un título.');
  const alias = listaDeAlias(entrada.alias);
  return enTransaccion(contexto, async (db) => {
    const capa = await pedirCapa(db, entrada.capa);
    if (!confirmar) {
      const parecidas = await similares(
        { titulo, alias, capa, fecha: fechaONada(entrada.fecha), origen_ref: entrada.origen_ref },
        db,
      );
      if (parecidas.length) {
        throw new ErrorDeUso(
          'Ya hay fichas parecidas. Usá la que corresponda, o confirmá que esta es otra distinta.',
          { codigo: 'parecidas', datos: { parecidas } },
        );
      }
    }
    const r = await db.query(
      `insert into fichas (capa, tipo, titulo, cuerpo, datos, alias, fecha, origen, origen_ref)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        capa,
        textoCorto(entrada.tipo, 80).toLowerCase(),
        titulo,
        texto(entrada.cuerpo),
        JSON.stringify(objetoDeDatos(entrada.datos)),
        alias,
        fechaONada(entrada.fecha),
        textoCorto(entrada.origen, 120),
        texto(entrada.origen_ref, { max: 2000 }).trim(),
      ],
    );
    const id = r.rows[0].id;
    for (const apunte of entrada.apuntes ?? []) {
      await insertarApunte(db, { ...apunte, ficha_id: id });
    }
    for (const enlace of entrada.enlaces ?? []) {
      await insertarEnlace(db, { desde: id, hacia: enlace.hacia, relacion: enlace.relacion, nota: enlace.nota });
    }
    return pedirFicha(db, id);
  });
}

export async function editarFicha(contexto, id, cambios) {
  return enTransaccion(contexto, async (db) => {
    const actual = await pedirFicha(db, id, { conBorradas: true });
    const partes = [];
    const valores = [];
    const poner = (columna, valor) => {
      valores.push(valor);
      partes.push(`${columna} = $${valores.length}`);
    };

    if (cambios.capa !== undefined) poner('capa', await pedirCapa(db, cambios.capa));
    if (cambios.tipo !== undefined) poner('tipo', textoCorto(cambios.tipo, 80).toLowerCase());
    if (cambios.titulo !== undefined) {
      const titulo = textoCorto(cambios.titulo, 300);
      if (!titulo) throw new ErrorDeUso('El título no puede quedar vacío.');
      poner('titulo', titulo);
    }
    if (cambios.cuerpo !== undefined) poner('cuerpo', texto(cambios.cuerpo));
    if (cambios.fecha !== undefined) poner('fecha', fechaONada(cambios.fecha));
    if (cambios.origen !== undefined) poner('origen', textoCorto(cambios.origen, 120));
    if (cambios.origen_ref !== undefined) poner('origen_ref', texto(cambios.origen_ref, { max: 2000 }).trim());

    if (cambios.alias !== undefined || cambios.alias_agregar !== undefined) {
      const base = cambios.alias !== undefined ? listaDeAlias(cambios.alias) : actual.alias;
      poner('alias', listaDeAlias([...base, ...listaDeAlias(cambios.alias_agregar)]));
    }

    if (cambios.datos !== undefined || cambios.datos_cambios !== undefined) {
      const datos = cambios.datos !== undefined ? objetoDeDatos(cambios.datos) : { ...actual.datos };
      for (const [clave, valor] of Object.entries(objetoDeDatos(cambios.datos_cambios))) {
        if (valor === null) delete datos[clave];
        else datos[clave] = valor;
      }
      poner('datos', JSON.stringify(datos));
    }

    if (cambios.estado !== undefined) {
      if (!ESTADOS_FICHA.includes(cambios.estado)) {
        throw new ErrorDeUso(`El estado "${cambios.estado}" no existe.`);
      }
      poner('estado', cambios.estado);
    }

    if (!partes.length) throw new ErrorDeUso('No se indicó ningún cambio.');
    valores.push(id);
    await db.query(`update fichas set ${partes.join(', ')} where id = $${valores.length}`, valores);
    return pedirFicha(db, id, { conBorradas: true });
  });
}

export function borrarFicha(contexto, id) {
  return editarFicha(contexto, id, { estado: 'borrada' });
}

export function restaurarFicha(contexto, id) {
  return editarFicha(contexto, id, { estado: 'activa' });
}

// --- apuntes ----------------------------------------------------------------

async function insertarApunte(db, entrada) {
  const contenido = texto(entrada.texto, { max: 20000 }).trim();
  if (!contenido) throw new ErrorDeUso('El apunte necesita texto.');
  const fichaId = pedirId(entrada.ficha_id, 'identificador de ficha');
  let hechoId = null;
  if (entrada.hecho_id) {
    const hecho = await pedirFicha(db, entrada.hecho_id);
    hechoId = hecho.id;
  }
  const r = await db.query(
    `insert into apuntes (ficha_id, texto, fecha, base, origen, origen_ref, hecho_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      fichaId,
      contenido,
      fechaONada(entrada.fecha),
      baseValida(entrada.base),
      textoCorto(entrada.origen, 120),
      texto(entrada.origen_ref, { max: 2000 }).trim(),
      hechoId,
    ],
  );
  const id = r.rows[0].id;
  if (entrada.reemplaza) {
    const viejo = pedirId(entrada.reemplaza, 'identificador del apunte reemplazado');
    const hecho = await db.query(
      `update apuntes set vigente = false, reemplazado_por = $1
        where id = $2 and ficha_id = $3 and estado = 'activo' returning id`,
      [id, viejo, fichaId],
    );
    if (!hecho.rowCount) {
      throw new ErrorDeUso('El apunte a reemplazar no existe en esa ficha.', { codigo: 'no_existe' });
    }
  }
  return id;
}

async function leerApunte(db, id) {
  const r = await db.query(
    `select id, ficha_id, texto, fecha, base, origen, origen_ref, hecho_id, vigente,
            reemplazado_por, estado, creado, actualizado
       from apuntes where id = $1`,
    [pedirId(id, 'identificador de apunte')],
  );
  if (!r.rowCount) throw new ErrorDeUso('Ese apunte no existe.', { codigo: 'no_existe' });
  return r.rows[0];
}

/**
 * Agrega un dato a una ficha. Con `reemplaza` (el id de un apunte anterior),
 * el anterior no se borra: queda fechado y marcado como ya no vigente.
 */
export async function agregarApunte(contexto, entrada) {
  return enTransaccion(contexto, async (db) => {
    await pedirFicha(db, entrada.ficha_id);
    const id = await insertarApunte(db, entrada);
    return leerApunte(db, id);
  });
}

export async function editarApunte(contexto, id, cambios) {
  return enTransaccion(contexto, async (db) => {
    const actual = await leerApunte(db, id);
    if (actual.estado === 'borrado' && cambios.estado !== 'activo') {
      throw new ErrorDeUso('Ese apunte está borrado.', { codigo: 'no_existe' });
    }
    const partes = [];
    const valores = [];
    const poner = (columna, valor) => {
      valores.push(valor);
      partes.push(`${columna} = $${valores.length}`);
    };
    if (cambios.texto !== undefined) {
      const contenido = texto(cambios.texto, { max: 20000 }).trim();
      if (!contenido) throw new ErrorDeUso('El apunte no puede quedar vacío.');
      poner('texto', contenido);
    }
    if (cambios.fecha !== undefined) poner('fecha', fechaONada(cambios.fecha));
    if (cambios.base !== undefined) poner('base', baseValida(cambios.base));
    if (cambios.origen !== undefined) poner('origen', textoCorto(cambios.origen, 120));
    if (cambios.origen_ref !== undefined) poner('origen_ref', texto(cambios.origen_ref, { max: 2000 }).trim());
    if (cambios.vigente !== undefined) poner('vigente', Boolean(cambios.vigente));
    if (cambios.estado !== undefined) {
      if (!['activo', 'borrado'].includes(cambios.estado)) throw new ErrorDeUso('Estado de apunte inválido.');
      poner('estado', cambios.estado);
    }
    if (!partes.length) throw new ErrorDeUso('No se indicó ningún cambio.');
    valores.push(actual.id);
    await db.query(`update apuntes set ${partes.join(', ')} where id = $${valores.length}`, valores);
    return leerApunte(db, actual.id);
  });
}

export function borrarApunte(contexto, id) {
  return editarApunte(contexto, id, { estado: 'borrado' });
}

// --- enlaces ----------------------------------------------------------------

async function insertarEnlace(db, { desde, hacia, relacion, nota }) {
  const a = (await pedirFicha(db, desde)).id;
  const b = (await pedirFicha(db, hacia)).id;
  if (a === b) throw new ErrorDeUso('Una ficha no se enlaza consigo misma.');
  const rel = textoCorto(relacion, 120).toLowerCase();
  // Si ya están enlazadas en el otro sentido con la misma relación, no se duplica.
  const inverso = await db.query(
    'select id from enlaces where desde = $1 and hacia = $2 and relacion = $3',
    [b, a, rel],
  );
  if (inverso.rowCount) {
    if (nota !== undefined) {
      await db.query('update enlaces set nota = $1 where id = $2', [texto(nota, { max: 2000 }).trim(), inverso.rows[0].id]);
    }
    return inverso.rows[0].id;
  }
  const r = await db.query(
    `insert into enlaces (desde, hacia, relacion, nota) values ($1, $2, $3, $4)
     on conflict (desde, hacia, relacion) do update set nota = excluded.nota
     returning id`,
    [a, b, rel, texto(nota, { max: 2000 }).trim()],
  );
  return r.rows[0].id;
}

export async function enlazar(contexto, entrada) {
  return enTransaccion(contexto, async (db) => {
    const id = await insertarEnlace(db, entrada);
    const r = await db.query(
      `select e.id, e.desde, d.titulo as desde_titulo, e.hacia, h.titulo as hacia_titulo,
              e.relacion, e.nota
         from enlaces e join fichas d on d.id = e.desde join fichas h on h.id = e.hacia
        where e.id = $1`,
      [id],
    );
    return r.rows[0];
  });
}

export async function desenlazar(contexto, id) {
  return enTransaccion(contexto, async (db) => {
    const r = await db.query('delete from enlaces where id = $1 returning id', [
      pedirId(id, 'identificador de enlace'),
    ]);
    if (!r.rowCount) throw new ErrorDeUso('Ese enlace no existe.', { codigo: 'no_existe' });
    return { id: r.rows[0].id, borrado: true };
  });
}

// --- bandeja de entrada -----------------------------------------------------

export async function bandejaAgregar(contexto, entrada) {
  const contenido = texto(entrada.contenido, { max: 500000 }).trim();
  if (!contenido) throw new ErrorDeUso('Falta el contenido.');
  return enTransaccion(contexto, async (db) => {
    const r = await db.query(
      `insert into bandeja (origen, origen_ref, fecha, contenido, datos)
       values ($1, $2, $3, $4, $5)
       returning id, recibido, origen, origen_ref, fecha, estado`,
      [
        textoCorto(entrada.origen, 120),
        texto(entrada.origen_ref, { max: 2000 }).trim(),
        fechaONada(entrada.fecha),
        contenido,
        JSON.stringify(objetoDeDatos(entrada.datos)),
      ],
    );
    return r.rows[0];
  });
}

export async function bandejaListar({ estado = 'pendiente', limite: lim, salto = 0 } = {}) {
  const r = await consultar(
    `select id, recibido, origen, origen_ref, fecha, estado, resuelto, nota, fichas,
            left(contenido, 400) as extracto, length(contenido) as largo
       from bandeja
      where ($1::text is null or estado = $1)
      order by recibido desc
      limit $2 offset $3`,
    [estado === 'todo' ? null : estado, limite(lim, 30, 200), Math.max(0, Number(salto) || 0)],
  );
  return r.rows;
}

export async function bandejaLeer(id) {
  const r = await consultar(
    `select id, recibido, origen, origen_ref, fecha, contenido, datos, estado, resuelto, nota, fichas
       from bandeja where id = $1`,
    [pedirId(id, 'identificador de la bandeja')],
  );
  if (!r.rowCount) throw new ErrorDeUso('Ese elemento de la bandeja no existe.', { codigo: 'no_existe' });
  return r.rows[0];
}

export async function bandejaResolver(contexto, id, { estado, nota = '', fichas = [] }) {
  if (!['archivado', 'descartado', 'pendiente'].includes(estado)) {
    throw new ErrorDeUso('El estado va como archivado, descartado o pendiente.');
  }
  const ids = [...new Set((fichas ?? []).map((f) => pedirId(f, 'identificador de ficha')))];
  return enTransaccion(contexto, async (db) => {
    for (const ficha of ids) await pedirFicha(db, ficha);
    const r = await db.query(
      `update bandeja
          set estado = $2, nota = $3, fichas = $4,
              resuelto = case when $2 = 'pendiente' then null else now() end
        where id = $1
        returning id, estado, resuelto, nota, fichas`,
      [pedirId(id, 'identificador de la bandeja'), estado, texto(nota, { max: 4000 }).trim(), ids],
    );
    if (!r.rowCount) throw new ErrorDeUso('Ese elemento de la bandeja no existe.', { codigo: 'no_existe' });
    return r.rows[0];
  });
}

// --- historial --------------------------------------------------------------

export async function historial({ ficha_id, quien, tabla, desde, antes_de, limite: lim } = {}) {
  const r = await consultar(
    `select h.id, h.cuando, h.quien, h.accion, h.tabla, h.registro, h.ficha_id, h.otra_ficha,
            f.titulo as ficha_titulo, o.titulo as otra_titulo, h.antes, h.despues, h.motivo
       from historial h
       left join fichas f on f.id = h.ficha_id
       left join fichas o on o.id = h.otra_ficha
      where ($1::uuid is null or h.ficha_id = $1 or h.otra_ficha = $1)
        and ($2::text is null or h.quien ilike $2 || '%')
        and ($3::text is null or h.tabla = $3)
        and ($4::timestamptz is null or h.cuando >= $4)
        and ($5::bigint is null or h.id < $5)
      order by h.id desc
      limit $6`,
    [
      ficha_id ? pedirId(ficha_id, 'identificador de ficha') : null,
      quien ? escaparLike(String(quien)) : null,
      tabla || null,
      desde || null,
      antes_de || null,
      limite(lim, 50, 500),
    ],
  );
  return r.rows;
}

// --- mapa -------------------------------------------------------------------

export const MAXIMO_MAPA_GENERAL = 1500;
export const MAXIMO_MAPA_FICHA = 400;

/**
 * Los puntos y las líneas para dibujar el mapa de conexiones.
 * Con `centro`: esa ficha y lo que tiene alrededor, hasta `niveles` pasos.
 * Sin `centro`: todas las fichas activas de las capas elegidas.
 * Las capas que no se eligen no se muestran ni se atraviesan.
 */
export async function mapa({ centro, niveles = 2, capas, conSueltas = false } = {}) {
  const todas = (await listarCapas()).map((c) => c.clave);
  const pedidas = Array.isArray(capas) ? capas : capas ? String(capas).split(',') : [];
  const elegidas = pedidas.length ? todas.filter((c) => pedidas.includes(c)) : todas;

  let ids;
  let nivelDe = new Map();
  let recortado = false;
  let central = null;

  if (centro) {
    central = await pedirFicha({ query: consultar }, centro, { conBorradas: true });
    const tope = Math.min(Math.max(Math.floor(Number(niveles)) || 2, 1), 3);
    nivelDe = new Map([[central.id, 0]]);
    let borde = [central.id];
    for (let nivel = 1; nivel <= tope && borde.length && !recortado; nivel += 1) {
      const r = await consultar(
        `select case when e.desde = any($1) then e.hacia else e.desde end as otra
           from enlaces e
           join fichas o on o.id = case when e.desde = any($1) then e.hacia else e.desde end
          where (e.desde = any($1) or e.hacia = any($1))
            and o.estado = 'activa' and o.capa = any($2)
          order by o.actualizada desc`,
        [borde, elegidas],
      );
      const nuevos = [];
      for (const { otra } of r.rows) {
        if (nivelDe.has(otra)) continue;
        if (nivelDe.size >= MAXIMO_MAPA_FICHA) {
          recortado = true;
          break;
        }
        nivelDe.set(otra, nivel);
        nuevos.push(otra);
      }
      borde = nuevos;
    }
    ids = [...nivelDe.keys()];
  } else {
    const r = await consultar(
      `select f.id from fichas f
        where f.estado = 'activa' and f.capa = any($1)
          and ($2 or exists (
            select 1 from enlaces e join fichas o on o.id = case when e.desde = f.id then e.hacia else e.desde end
             where (e.desde = f.id or e.hacia = f.id) and o.estado = 'activa' and o.capa = any($1)))
        order by (select count(*) from enlaces e where e.desde = f.id or e.hacia = f.id) desc, f.actualizada desc
        limit $3`,
      [elegidas, Boolean(conSueltas), MAXIMO_MAPA_GENERAL + 1],
    );
    recortado = r.rowCount > MAXIMO_MAPA_GENERAL;
    ids = r.rows.slice(0, MAXIMO_MAPA_GENERAL).map((f) => f.id);
  }

  const [nodos, lineas] = await Promise.all([
    consultar(
      `select f.id, f.capa, f.tipo, f.titulo, f.fecha, f.estado,
              (select count(*)::int from enlaces e join fichas o on o.id = case when e.desde = f.id then e.hacia else e.desde end
                where (e.desde = f.id or e.hacia = f.id) and o.estado = 'activa') as grado
         from fichas f where f.id = any($1)`,
      [ids],
    ),
    consultar(
      `select id, desde, hacia, relacion from enlaces where desde = any($1) and hacia = any($1)`,
      [ids],
    ),
  ]);

  return {
    centro: central?.id ?? null,
    capas: elegidas,
    recortado,
    maximo: centro ? MAXIMO_MAPA_FICHA : MAXIMO_MAPA_GENERAL,
    nodos: nodos.rows.map((n) => ({ ...n, nivel: nivelDe.get(n.id) ?? null })),
    enlaces: lineas.rows,
  };
}
