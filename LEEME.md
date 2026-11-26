# MeetMyMind

El lugar donde vive lo que hace falta para entender a Emiliano y ocuparse de su día a día. Lo escribe y lo lee Alex (la IA que Emiliano elija como asistente); Emiliano lo navega y lo corrige.

Este archivo está escrito para quien tenga que encenderlo, mantenerlo o continuarlo: una persona o una IA.

## Qué hay adentro

| Pieza | Qué hace | Dónde está |
| --- | --- | --- |
| Fichero | Guarda capas, fichas, apuntes, enlaces, bandeja e historial. Es una base de datos PostgreSQL. | `src/migraciones/`, `src/nucleo.js` |
| Carpeta de archivos | Imágenes (achicadas al entrar) y documentos. Audio y video no se guardan. | `src/archivos.js` |
| Entrada para las IA | Las herramientas con las que Alex lee y escribe. Habla el estándar MCP en la dirección `/mcp`. | `src/entrada.js` |
| Web con clave | Para que Emiliano navegue, corrija y controle los accesos, pensada para el celular. Incluye el mapa de conexiones (general y de cada ficha). | `src/web/`, `public/` |
| Copias | Una copia diaria automática y la exportación completa a archivos de texto. | `src/exportar.js` |
| Accesos | La clave de Emiliano, las IA autorizadas y las llaves para programas propios. | `src/acceso.js` |

Las reglas de trabajo no viven en el código: viven adentro del lugar, en la capa **Manual de Alex**. La primera vez que enciende se cargan las seis capas y el manual inicial (`src/semilla.js`); después, el manual se edita desde la web o desde la entrada y el código no lo vuelve a tocar.

## Cómo está pensado

- **Una ficha por cosa.** Una persona, una reunión, un proyecto, un libro, un valor. Antes de crear una, el fichero busca si ya hay una parecida.
- **Los datos van como apuntes.** Cada apunte dice de cuándo es, de dónde salió y en qué se apoya: lo dijo Emiliano, lo dedujo Alex, lo dijo otra persona o consta en un registro.
- **Lo viejo no se pisa.** Un apunte nuevo reemplaza al anterior, que queda fechado como ya no vigente.
- **Todo cambio queda en el historial.** Lo anota la propia base de datos (disparadores), así que no hay forma de saltearlo, y no se puede editar ni borrar.
- **Borrar no destruye.** Las fichas y los apuntes borrados salen de circulación y se pueden recuperar.

## Qué necesita para encender

Variables de entorno:

| Variable | Para qué | Ejemplo |
| --- | --- | --- |
| `DATABASE_URL` | Dirección del fichero PostgreSQL (versión 14 o más nueva) | `postgres://usuario:clave@servidor:5432/meetmymind` |
| `CLAVE` | La clave de entrada de Emiliano. 12 caracteres o más. | (no se escribe en ningún archivo) |
| `URL_PUBLICA` | La dirección con la que se entra desde afuera, con https | `https://mente.ejemplo.com` |
| `DIR_DATOS` | Carpeta para archivos y copias. Tiene que ser un volumen que sobreviva a las actualizaciones. | `/app/data` |
| `PUERTO` | Puerto interno. Por defecto, 3000. | `3000` |
| `ZONA_HORARIA` | Para mostrar las horas. Por defecto, `America/Argentina/Catamarca`. | |
| `COPIAS_A_GUARDAR` | Cuántas copias diarias se conservan. Por defecto, 14. | |

El usuario de la base de datos tiene que poder crear las extensiones `unaccent` y `pg_trgm` (vienen con PostgreSQL).

Al encender, el programa arma o actualiza solo la estructura del fichero. No hay ningún paso manual.

### En el servidor (Dokploy)

El archivo `docker-compose.yml` levanta el programa y su fichero juntos. El fichero no tiene puerto abierto ni salida a internet: vive en una red interna que solo comparte con el programa.

1. Crear un servicio de tipo **Compose** apuntando a este repositorio, rama `main`, archivo `docker-compose.yml`.
2. En **Environment**, cargar `URL_PUBLICA` y `CLAVE`.
3. En **Domains**, agregar el dominio para el servicio `app`, puerto 3000, con HTTPS.
4. Desplegar. Al entrar a la dirección, la clave lleva al inicio con las seis capas.

Los datos viven en dos volúmenes (`fichero` y `datos`) que sobreviven a cada actualización.

### Conectar una IA

En la web, **Más → Accesos** muestra la dirección de la entrada (termina en `/mcp`). Esa dirección se le da a la IA como conector propio. La IA abre una pantalla de MeetMyMind donde Emiliano confirma con su clave. Desde esa misma pantalla de Accesos se le corta el acceso cuando haga falta.

Para un programa propio (una automatización) se crea una **llave** en Accesos y el programa la manda en cada pedido como `Authorization: Bearer <llave>`.

## Copias y restauración

- Todos los días, después de las 4 de la mañana, se guarda una copia en `DIR_DATOS/copias/`. Trae las fichas como archivos de texto y el fichero completo en JSON. No trae claves ni accesos.
- Desde **Más → Copias** se baja cualquier copia, se hace una en el momento o se descarga todo con imágenes y documentos.
- **Pendiente:** llevar la copia diaria fuera del servidor. Hasta que eso esté, la copia y el original viven en la misma máquina.

Para restaurar una copia en un fichero nuevo y vacío:

```
node scripts/restaurar.js /ruta/a/la/copia.zip
```

## Probarlo

Las pruebas cubren el fichero, la entrada para las IA (con todo el circuito de autorización) y la web. Necesitan una base de datos de prueba vacía, que **se borra entera** en cada corrida:

```
DATABASE_URL=postgres://…/mmm_test CLAVE=una-clave-de-prueba \
URL_PUBLICA=http://localhost:3111 PUERTO=3111 DIR_DATOS=/tmp/mmm-test npm test
```

## Lo que todavía no hace

- No lee solo WhatsApp, mail, Plaud ni Trello. Esas fuentes se suman después, de a una.
- La copia fuera del servidor está pendiente (ver arriba).
