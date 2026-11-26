// Carga inicial: las seis capas y el Manual de Alex.
// Se ejecuta en cada arranque, pero solo escribe lo que falta: nunca pisa
// algo que Emiliano o Alex hayan cambiado después.

import { enTransaccion } from './db.js';

export const CAPAS = [
  {
    clave: 'hechos',
    nombre: 'Lo que pasó',
    descripcion: 'Reuniones, mensajes, mails y audios, cada uno con su fecha y su origen.',
  },
  {
    clave: 'vinculos',
    nombre: 'Vínculos',
    descripcion: 'Una ficha por persona, lugar o institución, armada interacción por interacción.',
  },
  {
    clave: 'proyectos',
    nombre: 'Proyectos y temas',
    descripcion: 'En qué anda Emiliano: estado, decisiones tomadas y pendientes.',
  },
  {
    clave: 'gustos',
    nombre: 'Gustos',
    descripcion: 'Lo que lee, escucha y mira, y lo que le gusta hacer.',
  },
  {
    clave: 'identidad',
    nombre: 'Quién es',
    descripcion: 'Valores, ideas, forma de pensar y forma de expresarse.',
  },
  {
    clave: 'manual',
    nombre: 'Manual de Alex',
    descripcion: 'Cómo trabajar con Emiliano y qué ya está decidido, para no volver a preguntar.',
  },
];

const GUIA = `MeetMyMind es el lugar donde vive lo que hace falta para entender a Emiliano y ocuparse de su día a día. Alex es la IA que Emiliano elija como asistente: hoy puede ser una y mañana otra. Este manual es lo primero que lee cualquier Alex.

## Cómo está armado

- **Capas.** Las grandes divisiones: lo que pasó, vínculos, proyectos y temas, gustos, quién es, y este manual.
- **Fichas.** Cada cosa que existe tiene una sola ficha: una persona, una reunión, un proyecto, un libro, un valor.
- **Apuntes.** Los datos sueltos de una ficha. Cada apunte dice de cuándo es, de dónde salió y en qué se apoya.
- **Enlaces.** Conectan dos fichas y dicen cuál es la relación.
- **Bandeja.** Donde cae lo crudo antes de archivarse.
- **Historial.** Guarda cada cambio: quién, cuándo, qué decía antes y qué dice ahora.

## Cómo se trabaja

1. Antes de crear una ficha, buscar si ya existe. Si existe, se le agrega un apunte.
2. Lo que pasó (una reunión, un mensaje, un mail) va como ficha en la capa "Lo que pasó", con su fecha, enlazada a las personas y a los proyectos que toca.
3. Lo que se aprende de alguien o de algo va como apunte en su ficha, señalando el hecho del que surge.
4. Cuando un dato cambia, el apunte nuevo reemplaza al anterior. El anterior no se borra: queda fechado como ya no vigente.
5. El cuerpo de la ficha es el resumen de hoy; los apuntes son la evidencia.
6. Ante una decisión dudosa, dejar anotado el porqué en el motivo del cambio.

## Qué entra y qué no

Entran texto, tablas, imágenes y documentos. Los archivos de audio y de video no: de ellos queda el resumen o el enlace, y de dónde vinieron.

## Cómo se cuida

Se entra con clave. Hay una copia automática diaria y una exportación a archivos de texto que abre cualquier programa.`;

const MANUAL = [
  { tipo: 'guía', titulo: 'Cómo funciona MeetMyMind', cuerpo: GUIA },
  {
    tipo: 'criterio',
    titulo: 'Los criterios son pocos y no se apilan',
    cuerpo:
      'Los criterios no son una lista de sí o no. Ante la duda, Alex decide con el contexto y deja anotado por qué.\n\nViven en un solo lugar, este manual. Uno nuevo reemplaza al viejo, o se revisa que no choque con los demás.',
  },
  {
    tipo: 'criterio',
    titulo: 'Se anota lo bueno y lo malo, lo lindo y lo feo',
    cuerpo: 'Sin suavizar. El lugar sirve si refleja lo que es, no una versión prolija.',
  },
  {
    tipo: 'criterio',
    titulo: 'Entra lo que ayuda a entender a Emiliano o a ocuparse de algo',
    cuerpo:
      'Un detalle trivial entra si muestra cómo piensa o cómo es. Lo que no ayuda a ninguna de las dos cosas queda afuera.',
  },
  {
    tipo: 'criterio',
    titulo: 'Cada dato lleva de dónde salió y cuándo',
    cuerpo:
      'Y se distingue lo que Emiliano dijo de lo que Alex dedujo, de lo que dijo otra persona y de lo que consta en un registro.',
  },
  {
    tipo: 'criterio',
    titulo: 'Hay una sola ficha por persona, proyecto o tema',
    cuerpo: 'Lo crudo cae en la bandeja de entrada. Alex lo archiva en su capa y lo enlaza.',
  },
  {
    tipo: 'criterio',
    titulo: 'Emiliano cambia lo que quiera sin avisar',
    cuerpo:
      'Todo cambio, suyo o de Alex, queda en el historial: quién, cuándo, qué decía antes y qué dice ahora. Alex mira el historial para enterarse de lo que Emiliano cambió.',
  },
  {
    tipo: 'criterio',
    titulo: 'Lo que decía antes no se pisa',
    cuerpo:
      'Emiliano cambia con el tiempo. Un dato viejo queda fechado y, si dos se contradicen, vale el más reciente.\n\nCada tanto Alex repasa duplicados, contradicciones y fichas viejas, y le muestra a Emiliano lo que encontró.',
  },
];

export async function sembrar() {
  return enTransaccion({ quien: 'sistema', motivo: 'Carga inicial' }, async (db) => {
    let capasNuevas = 0;
    for (const [i, capa] of CAPAS.entries()) {
      const r = await db.query(
        `insert into capas (clave, nombre, descripcion, orden) values ($1, $2, $3, $4)
         on conflict (clave) do nothing`,
        [capa.clave, capa.nombre, capa.descripcion, (i + 1) * 10],
      );
      capasNuevas += r.rowCount;
    }
    // El manual se carga una sola vez: si ya tuvo alguna ficha, no se toca.
    const hay = await db.query("select 1 from fichas where capa = 'manual' limit 1");
    let manualNuevo = 0;
    if (!hay.rowCount) {
      for (const [i, ficha] of MANUAL.entries()) {
        await db.query(
          `insert into fichas (capa, tipo, titulo, cuerpo, datos, origen)
           values ('manual', $1, $2, $3, $4, 'plano de MeetMyMind')`,
          [ficha.tipo, ficha.titulo, ficha.cuerpo, JSON.stringify({ orden: i + 1 })],
        );
        manualNuevo += 1;
      }
    }
    return { capasNuevas, manualNuevo };
  });
}
