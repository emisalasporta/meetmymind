// La entrada para las IA: las herramientas con las que Alex lee y escribe
// en MeetMyMind. Usa el estándar MCP, así que sirve para cualquier IA que
// lo hable.

import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as nucleo from './nucleo.js';
import { ErrorDeUso, BASES } from './nucleo.js';
import { guardarArchivo } from './archivos.js';

const INSTRUCCIONES = `MeetMyMind es el lugar donde vive lo que hace falta para entender a Emiliano y ocuparse de su día a día. Vos sos Alex, su asistente.

Antes de cualquier otra cosa, llamá a leer_manual: ahí están los criterios de trabajo y cómo está armado el lugar. Antes de crear una ficha, buscá si ya existe. Cada dato que anotes lleva de dónde salió, de cuándo es y en qué se apoya.`;

const id = (que) => z.string().describe(`Identificador de ${que} (el campo "id" que devuelven las otras herramientas).`);
const fecha = (que) => z.string().describe(`${que}, como AAAA-MM-DD.`);
const motivo = z
  .string()
  .optional()
  .describe('Por qué se hace el cambio. Queda en el historial. Usalo siempre que la decisión no sea obvia.');
const base = z
  .enum(Object.keys(BASES))
  .describe(
    'En qué se apoya el dato: dicho_por_emiliano (Emiliano lo dijo), deducido_por_alex (lo concluiste vos), dicho_por_otro (lo dijo otra persona), registro (consta en un mail, una grabación, un mensaje o un documento).',
  );
const origen = z
  .string()
  .optional()
  .describe('De dónde salió: whatsapp, mail, plaud, trello, conversación con Alex, etc.');
const origenRef = z
  .string()
  .optional()
  .describe('Referencia para volver a la fuente: un enlace, el asunto de un mail, el nombre de una grabación.');

const apunteNuevo = z.object({
  texto: z.string().describe('El dato, en una o dos oraciones.'),
  fecha: fecha('De cuándo es el dato').optional(),
  base,
  origen,
  origen_ref: origenRef,
  hecho_id: id('la ficha de "Lo que pasó" de la que surge el dato').optional(),
});

const enlaceNuevo = z.object({
  hacia: id('la ficha con la que se enlaza'),
  relacion: z.string().optional().describe('Qué relación hay: participó, pareja de, trata de, pertenece a…'),
  nota: z.string().optional(),
});

function respuesta(valor) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor, null, 1);
  return { content: [{ type: 'text', text: texto }] };
}

function falla(error) {
  if (error instanceof ErrorDeUso) {
    const cuerpo = { error: error.message, ...(error.datos ?? {}) };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(cuerpo, null, 1) }] };
  }
  console.error('Falla en una herramienta de la entrada:', error);
  return {
    isError: true,
    content: [{ type: 'text', text: 'Falló MeetMyMind por un problema propio. No se guardó nada de este pedido.' }],
  };
}

async function textoDelManual() {
  const [panorama, fichas] = await Promise.all([
    nucleo.panorama(),
    nucleo.listarFichas({ capa: 'manual', orden: 'titulo', limite: 200 }),
  ]);
  const completas = await Promise.all(fichas.map((f) => nucleo.leerFicha(f.id)));
  completas.sort(
    (a, b) => (Number(a.datos?.orden) || 999) - (Number(b.datos?.orden) || 999) || a.titulo.localeCompare(b.titulo),
  );
  const partes = ['# Manual de Alex', ''];
  for (const f of completas) {
    partes.push(`## ${f.titulo}`, `(${f.tipo || 'ficha'} · id ${f.id})`, '', f.cuerpo.trim(), '');
    for (const a of f.apuntes.filter((x) => x.vigente)) {
      partes.push(`- ${a.texto}${a.fecha ? ` (${a.fecha})` : ''}`);
    }
    if (f.apuntes.length) partes.push('');
  }
  partes.push('# Estado del lugar', '');
  for (const c of panorama.capas) {
    partes.push(`- **${c.nombre}** (capa "${c.clave}"): ${c.fichas} fichas. ${c.descripcion}`);
  }
  partes.push(
    '',
    `Bandeja de entrada: ${panorama.bandeja_pendiente} pendientes.`,
    `Cambios en los últimos 7 días: ${panorama.cambios_ultimos_7_dias}.`,
  );
  return partes.join('\n');
}

/**
 * Arma el servidor con sus herramientas para un pedido.
 * `quien` es el nombre con el que los cambios quedan en el historial.
 */
export function crearEntrada({ quien }) {
  const servidor = new McpServer(
    { name: 'meetmymind', title: 'MeetMyMind', version: '0.1.0' },
    { instructions: INSTRUCCIONES },
  );
  const como = (m) => ({ quien, motivo: m ?? '' });

  const herramienta = (nombre, definicion, accion) =>
    servidor.registerTool(nombre, definicion, async (args) => {
      try {
        return respuesta(await accion(args ?? {}));
      } catch (error) {
        return falla(error);
      }
    });

  const lectura = { readOnlyHint: true, openWorldHint: false };
  const escritura = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  // --- leer -----------------------------------------------------------------

  herramienta(
    'leer_manual',
    {
      title: 'Leer el Manual de Alex',
      description:
        'Devuelve el Manual de Alex completo (cómo funciona MeetMyMind y los criterios de trabajo) y el estado del lugar: capas, cantidad de fichas y pendientes. Llamala al empezar cada conversación, antes de cualquier otra herramienta.',
      inputSchema: {},
      annotations: lectura,
    },
    () => textoDelManual(),
  );

  herramienta(
    'buscar',
    {
      title: 'Buscar fichas',
      description:
        'Busca fichas por nombre, alias o contenido (incluye el texto de los apuntes). Tolera acentos y errores de tipeo. Usala antes de crear una ficha y cada vez que necesites contexto sobre una persona, un proyecto o un tema.',
      inputSchema: {
        texto: z.string().describe('Qué buscar: un nombre, un apodo, un tema o unas palabras.'),
        capa: z.string().optional().describe('Limita a una capa: hechos, vinculos, proyectos, gustos, identidad, manual.'),
        tipo: z.string().optional().describe('Limita a un tipo de ficha: persona, reunión, libro…'),
        limite: z.number().int().min(1).max(100).optional(),
        con_archivadas: z.boolean().optional().describe('Incluye las fichas archivadas.'),
      },
      annotations: lectura,
    },
    (a) => nucleo.buscar({ texto: a.texto, capa: a.capa, tipo: a.tipo, limite: a.limite, conArchivadas: a.con_archivadas }),
  );

  herramienta(
    'listar_fichas',
    {
      title: 'Listar fichas de una capa',
      description:
        'Lista fichas sin buscar por texto: las de una capa o de un tipo, ordenadas por las más recientes, por título o por fecha del hecho. Sirve para recorrer una capa o ver lo último que se tocó.',
      inputSchema: {
        capa: z.string().optional(),
        tipo: z.string().optional(),
        orden: z.enum(['recientes', 'titulo', 'fecha']).optional(),
        estado: z.enum(['activa', 'archivada', 'borrada']).optional(),
        limite: z.number().int().min(1).max(200).optional(),
        salto: z.number().int().min(0).optional().describe('Cuántas saltear, para seguir una lista larga.'),
      },
      annotations: lectura,
    },
    (a) => nucleo.listarFichas(a),
  );

  herramienta(
    'leer_ficha',
    {
      title: 'Leer una ficha completa',
      description:
        'Devuelve una ficha con todo: cuerpo, datos, apuntes (con su fecha, origen y base), enlaces a otras fichas en los dos sentidos y archivos. Los apuntes con "vigente": false son datos viejos que otro más nuevo reemplazó.',
      inputSchema: { id: id('la ficha') },
      annotations: lectura,
    },
    (a) => nucleo.leerFicha(a.id),
  );

  herramienta(
    'ver_historial',
    {
      title: 'Ver el historial de cambios',
      description:
        'Muestra los cambios hechos en MeetMyMind: quién, cuándo, qué decía antes y qué dice ahora. Con quien: "emiliano" ves lo que Emiliano cambió por su cuenta; revisalo al empezar para no pisarle un cambio.',
      inputSchema: {
        ficha_id: id('la ficha').optional(),
        quien: z.string().optional().describe('Filtra por quién hizo el cambio: emiliano, alex, sistema.'),
        desde: z.string().optional().describe('Solo cambios desde este momento (fecha u hora en formato ISO).'),
        limite: z.number().int().min(1).max(200).optional(),
        antes_de: z.number().int().optional().describe('Para seguir hacia atrás: el número del último cambio ya visto.'),
      },
      annotations: lectura,
    },
    (a) => nucleo.historial(a),
  );

  // --- escribir fichas ------------------------------------------------------

  herramienta(
    'crear_ficha',
    {
      title: 'Crear una ficha',
      description:
        'Crea una ficha nueva. Si ya existe una parecida no la crea y devuelve las parecidas: usá la que corresponda (agregale un apunte) o repetí el pedido con confirmar_que_es_nueva. Para algo que pasó (reunión, mensaje, mail) usá la capa "hechos" con su fecha y enlazala a las personas y proyectos que toca. Podés crear la ficha con sus apuntes y enlaces en un solo pedido.',
      inputSchema: {
        capa: z.string().describe('hechos, vinculos, proyectos, gustos, identidad o manual.'),
        titulo: z.string().describe('Nombre de la ficha. Para una persona, nombre y apellido.'),
        tipo: z.string().optional().describe('Qué clase de cosa es: persona, lugar, institución, reunión, mensaje, mail, proyecto, tema, libro, canción, valor, idea, criterio…'),
        cuerpo: z.string().optional().describe('El resumen de hoy, en texto (admite markdown). Corto: la evidencia va en los apuntes.'),
        datos: z.record(z.string(), z.any()).optional().describe('Campos sueltos, como pares nombre y valor: cargo, cumpleaños, teléfono, estado…'),
        alias: z.array(z.string()).optional().describe('Otros nombres con los que Emiliano se refiere a esto: apodos, siglas, descripciones ("el tesorero").'),
        fecha: fecha('Para la capa "hechos": el día en que pasó').optional(),
        origen,
        origen_ref: origenRef,
        apuntes: z.array(apunteNuevo).optional().describe('Datos iniciales de la ficha.'),
        enlaces: z.array(enlaceNuevo).optional().describe('Fichas con las que se conecta.'),
        confirmar_que_es_nueva: z.boolean().optional().describe('Ponelo en true solo después de revisar las parecidas y confirmar que esta es otra cosa.'),
        motivo,
      },
      annotations: escritura,
    },
    (a) => nucleo.crearFicha(como(a.motivo), a, { confirmar: a.confirmar_que_es_nueva === true }),
  );

  herramienta(
    'editar_ficha',
    {
      title: 'Editar una ficha',
      description:
        'Cambia campos de una ficha. Solo se tocan los campos que mandes. Para sumar un dato nuevo sobre la persona o el tema, no edites el cuerpo: usá agregar_apunte. Con estado "archivada" la ficha sale de las búsquedas comunes sin borrarse.',
      inputSchema: {
        id: id('la ficha'),
        titulo: z.string().optional(),
        tipo: z.string().optional(),
        capa: z.string().optional(),
        cuerpo: z.string().optional().describe('Reemplaza el resumen completo.'),
        datos_cambios: z.record(z.string(), z.any()).optional().describe('Campos a agregar o cambiar. Un campo con valor null se quita.'),
        alias_agregar: z.array(z.string()).optional(),
        alias: z.array(z.string()).optional().describe('Reemplaza la lista completa de alias.'),
        fecha: z.string().nullable().optional().describe('AAAA-MM-DD, o null para quitarla.'),
        origen,
        origen_ref: origenRef,
        estado: z.enum(['activa', 'archivada']).optional(),
        motivo,
      },
      annotations: escritura,
    },
    ({ id: fichaId, motivo: m, ...cambios }) => nucleo.editarFicha(como(m), fichaId, cambios),
  );

  herramienta(
    'agregar_apunte',
    {
      title: 'Agregar un dato a una ficha',
      description:
        'Anota un dato en una ficha, con su fecha, su origen y en qué se apoya. Es la forma normal de sumar lo que se aprende sobre una persona, un proyecto o un tema. Si el dato corrige o actualiza uno anterior, pasá el id del anterior en "reemplaza": el viejo no se borra, queda fechado como ya no vigente.',
      inputSchema: {
        ficha_id: id('la ficha'),
        ...apunteNuevo.shape,
        reemplaza: id('el apunte anterior que este dato deja sin vigencia').optional(),
        motivo,
      },
      annotations: escritura,
    },
    (a) => nucleo.agregarApunte(como(a.motivo), a),
  );

  herramienta(
    'editar_apunte',
    {
      title: 'Corregir un apunte',
      description:
        'Corrige un apunte que quedó mal escrito o mal fechado. Si lo que cambió es la realidad (el dato era cierto y dejó de serlo), no edites: usá agregar_apunte con "reemplaza".',
      inputSchema: {
        id: id('el apunte'),
        texto: z.string().optional(),
        fecha: z.string().nullable().optional(),
        base: base.optional(),
        origen,
        origen_ref: origenRef,
        vigente: z.boolean().optional(),
        motivo,
      },
      annotations: escritura,
    },
    ({ id: apunteId, motivo: m, ...cambios }) => nucleo.editarApunte(como(m), apunteId, cambios),
  );

  herramienta(
    'enlazar',
    {
      title: 'Enlazar dos fichas',
      description:
        'Conecta dos fichas y nombra la relación. El enlace se ve desde las dos. Ejemplos: una reunión con quienes participaron (participó), una persona con su institución (trabaja en), un hecho con el proyecto que trata (trata de).',
      inputSchema: {
        desde: id('una ficha'),
        hacia: id('la otra ficha'),
        relacion: z.string().optional(),
        nota: z.string().optional(),
        motivo,
      },
      annotations: escritura,
    },
    (a) => nucleo.enlazar(como(a.motivo), a),
  );

  herramienta(
    'desenlazar',
    {
      title: 'Quitar un enlace',
      description: 'Quita un enlace entre dos fichas. Las fichas no cambian. Queda en el historial.',
      inputSchema: { enlace_id: id('el enlace (aparece en leer_ficha)'), motivo },
      annotations: { ...escritura, destructiveHint: true },
    },
    (a) => nucleo.desenlazar(como(a.motivo), a.enlace_id),
  );

  herramienta(
    'borrar',
    {
      title: 'Borrar una ficha o un apunte',
      description:
        'Saca de circulación una ficha o un apunte. No se destruye: queda en el historial y se puede recuperar con "restaurar". Decí siempre el motivo. Si el dato solo quedó viejo, no lo borres: reemplazalo con agregar_apunte.',
      inputSchema: {
        ficha_id: id('la ficha a borrar').optional(),
        apunte_id: id('el apunte a borrar').optional(),
        motivo: z.string().describe('Por qué se borra.'),
      },
      annotations: { ...escritura, destructiveHint: true },
    },
    (a) => {
      if (Boolean(a.ficha_id) === Boolean(a.apunte_id)) {
        throw new ErrorDeUso('Indicá una sola cosa a borrar: ficha_id o apunte_id.');
      }
      return a.ficha_id
        ? nucleo.borrarFicha(como(a.motivo), a.ficha_id)
        : nucleo.borrarApunte(como(a.motivo), a.apunte_id);
    },
  );

  herramienta(
    'restaurar',
    {
      title: 'Recuperar algo borrado',
      description: 'Vuelve a poner en circulación una ficha o un apunte borrados.',
      inputSchema: {
        ficha_id: id('la ficha a recuperar').optional(),
        apunte_id: id('el apunte a recuperar').optional(),
        motivo,
      },
      annotations: escritura,
    },
    (a) => {
      if (Boolean(a.ficha_id) === Boolean(a.apunte_id)) {
        throw new ErrorDeUso('Indicá una sola cosa a recuperar: ficha_id o apunte_id.');
      }
      return a.ficha_id
        ? nucleo.restaurarFicha(como(a.motivo), a.ficha_id)
        : nucleo.editarApunte(como(a.motivo), a.apunte_id, { estado: 'activo' });
    },
  );

  // --- bandeja de entrada ---------------------------------------------------

  herramienta(
    'bandeja_agregar',
    {
      title: 'Dejar algo en la bandeja de entrada',
      description:
        'Deja material crudo (la transcripción de un audio, un mail, una conversación) para archivarlo después. Usala cuando no hay tiempo o contexto para archivar bien en el momento. No reemplaza a archivar: lo que queda acá todavía no forma parte de las fichas.',
      inputSchema: {
        contenido: z.string().describe('El texto crudo, completo.'),
        origen,
        origen_ref: origenRef,
        fecha: fecha('De cuándo es el material').optional(),
        datos: z.record(z.string(), z.any()).optional(),
        motivo,
      },
      annotations: escritura,
    },
    (a) => nucleo.bandejaAgregar(como(a.motivo), a),
  );

  herramienta(
    'bandeja_ver',
    {
      title: 'Ver la bandeja de entrada',
      description:
        'Sin id: lista lo que hay en la bandeja (por defecto, lo pendiente) con un extracto. Con id: devuelve ese elemento completo para archivarlo.',
      inputSchema: {
        id: id('un elemento de la bandeja').optional(),
        estado: z.enum(['pendiente', 'archivado', 'descartado', 'todo']).optional(),
        limite: z.number().int().min(1).max(200).optional(),
        salto: z.number().int().min(0).optional(),
      },
      annotations: lectura,
    },
    (a) => (a.id ? nucleo.bandejaLeer(a.id) : nucleo.bandejaListar(a)),
  );

  herramienta(
    'bandeja_resolver',
    {
      title: 'Cerrar un elemento de la bandeja',
      description:
        'Marca un elemento de la bandeja como archivado (ya pasó a fichas y apuntes; indicá cuáles) o descartado (no aportaba; decí por qué en la nota).',
      inputSchema: {
        id: id('el elemento de la bandeja'),
        estado: z.enum(['archivado', 'descartado', 'pendiente']),
        nota: z.string().optional().describe('Qué se hizo con el material, o por qué se descartó.'),
        fichas: z.array(z.string()).optional().describe('Identificadores de las fichas donde quedó archivado.'),
        motivo,
      },
      annotations: escritura,
    },
    ({ id: itemId, motivo: m, ...resto }) => nucleo.bandejaResolver(como(m), itemId, resto),
  );

  // --- archivos -------------------------------------------------------------

  herramienta(
    'adjuntar_archivo',
    {
      title: 'Adjuntar una imagen o un documento',
      description:
        'Guarda una imagen o un documento en una ficha. Las imágenes se achican al entrar. No acepta audio ni video: de esos se guarda el resumen o el enlace, no el archivo. El contenido va en base64 y no puede pasar los 8 MB.',
      inputSchema: {
        ficha_id: id('la ficha'),
        nombre: z.string().describe('Nombre del archivo con su extensión, por ejemplo "captura.png".'),
        contenido_base64: z.string().describe('El archivo, codificado en base64.'),
        descripcion: z.string().optional().describe('Qué es o qué muestra.'),
        motivo,
      },
      annotations: escritura,
    },
    (a) =>
      guardarArchivo(como(a.motivo), {
        ficha_id: a.ficha_id,
        nombre: a.nombre,
        contenido: Buffer.from(a.contenido_base64, 'base64'),
        descripcion: a.descripcion,
      }),
  );

  return servidor;
}
