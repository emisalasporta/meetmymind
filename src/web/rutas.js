// Las direcciones de la web: qué pantalla se muestra y qué hace cada botón.

import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import { config, esHttps, urlEntrada } from '../config.js';
import * as nucleo from '../nucleo.js';
import { ErrorDeUso } from '../nucleo.js';
import * as acceso from '../acceso.js';
import { guardarArchivo, leerArchivo, borrarArchivo, rutaEnDisco, TAMANO_MAXIMO } from '../archivos.js';
import { escribirCopia, hacerCopia, listarCopias, rutaDeCopia } from '../exportar.js';
import { consultar } from '../db.js';
import { pagina, textoDeAviso, hoy } from './plantilla.js';
import * as vistas from './vistas.js';

const GALLETA = esHttps ? '__Host-mmm_sesion' : 'mmm_sesion';
const POR_PAGINA = 50;
const HISTORIAL_POR_PAGINA = 40;

const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAMANO_MAXIMO, files: 1 } });

function leerGalleta(req, nombre) {
  for (const parte of String(req.headers.cookie ?? '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return '';
}

function ponerGalleta(res, valor, duracionMs) {
  const partes = [`${GALLETA}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (esHttps) partes.push('Secure');
  partes.push(`Max-Age=${Math.floor(duracionMs / 1000)}`);
  res.setHeader('Set-Cookie', partes.join('; '));
}

/** Solo se vuelve a direcciones propias: nunca a otro sitio. */
function destinoSeguro(valor) {
  const v = String(valor ?? '');
  return v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/';
}

/** La página desde la que vino el pedido, si es de esta web. */
function paginaAnterior(req) {
  try {
    const anterior = new URL(req.get('referer'));
    return anterior.origin === config.urlPublica.origin ? destinoSeguro(anterior.pathname + anterior.search) : '/';
  } catch {
    return '/';
  }
}

function parsearDatos(texto) {
  const datos = {};
  for (const renglon of String(texto ?? '').split('\n')) {
    const i = renglon.indexOf(':');
    if (i < 1) continue;
    const clave = renglon.slice(0, i).trim();
    const crudo = renglon.slice(i + 1).trim();
    if (!clave) continue;
    let valor = crudo;
    if (/^(-?\d+(\.\d+)?|true|false|null|[[{"].*)$/s.test(crudo) && !/^0\d/.test(crudo)) {
      try {
        valor = JSON.parse(crudo);
      } catch {
        valor = crudo;
      }
    }
    if (valor !== null) datos[clave] = valor;
  }
  return datos;
}

const emi = (motivo = '') => ({ quien: 'emiliano', motivo: String(motivo ?? '').trim() });

async function mapaDeCapas() {
  return new Map((await nucleo.listarCapas()).map((c) => [c.clave, c]));
}

export function rutasWeb() {
  const r = express.Router();
  const formulario = express.urlencoded({ extended: false, limit: '2mb' });

  // Envoltorio: los errores de uso se muestran como pantalla, no como falla.
  const pantalla = (accion) => async (req, res, next) => {
    try {
      await accion(req, res);
    } catch (error) {
      if (error instanceof ErrorDeUso) {
        const estado = error.codigo === 'no_existe' ? 404 : 400;
        res.status(estado).send(
          pagina({
            titulo: 'No se pudo',
            cuerpo: vistas.noSePudo({ mensaje: error.message, volver: paginaAnterior(req) }),
            bandeja: res.locals.bandeja,
            angosta: true,
          }),
        );
      } else {
        next(error);
      }
    }
  };

  const mostrar = (res, opciones) =>
    res.send(pagina({ bandeja: res.locals.bandeja, aviso: res.locals.aviso, ...opciones }));

  // --- puertas que no piden sesión ------------------------------------------

  r.get('/salud', async (req, res) => {
    try {
      await consultar('select 1');
      res.json({ bien: true });
    } catch {
      res.status(503).json({ bien: false });
    }
  });

  r.get('/entrar', async (req, res) => {
    if (await acceso.sesionValida(leerGalleta(req, GALLETA))) return res.redirect(303, '/');
    res.send(pagina({ titulo: 'Entrar', conSesion: false, angosta: true, cuerpo: vistas.entrar({ volver: destinoSeguro(req.query.volver) }) }));
  });

  r.post('/entrar', formulario, async (req, res) => {
    const volver = destinoSeguro(req.body.volver);
    const resultado = await acceso.revisarClave(req.ip, req.body.clave);
    if (resultado !== 'bien') {
      const error =
        resultado === 'frenado'
          ? 'Demasiados intentos. Esperá 15 minutos y probá de nuevo.'
          : 'Esa no es la clave.';
      return res
        .status(resultado === 'frenado' ? 429 : 401)
        .send(pagina({ titulo: 'Entrar', conSesion: false, angosta: true, error, cuerpo: vistas.entrar({ volver }) }));
    }
    const { pase, duracion } = await acceso.abrirSesion();
    ponerGalleta(res, pase, duracion);
    res.redirect(303, volver);
  });

  // Una IA pidió conectarse: Emiliano decide con su clave.
  r.get('/autorizar', async (req, res) => {
    const pedido = await acceso.leerPedido(req.query.pedido);
    if (!pedido) {
      return res.status(400).send(
        pagina({ titulo: 'Pedido vencido', conSesion: false, angosta: true, cuerpo: vistas.noSePudo({ mensaje: 'Ese pedido de conexión ya venció. Volvé a la IA y empezá la conexión de nuevo.', volver: '/' }) }),
      );
    }
    res.send(pagina({ titulo: 'Autorizar', conSesion: false, angosta: true, cuerpo: vistas.autorizar({ pedido }) }));
  });

  r.post('/autorizar', formulario, async (req, res) => {
    const pedido = await acceso.leerPedido(req.body.pedido);
    if (!pedido) {
      return res.status(400).send(
        pagina({ titulo: 'Pedido vencido', conSesion: false, angosta: true, cuerpo: vistas.noSePudo({ mensaje: 'Ese pedido de conexión ya venció. Volvé a la IA y empezá la conexión de nuevo.', volver: '/' }) }),
      );
    }
    if (req.body.decision !== 'si') {
      return res.redirect(303, await acceso.responderPedido(pedido.id, false));
    }
    const resultado = await acceso.revisarClave(req.ip, req.body.clave);
    if (resultado !== 'bien') {
      const error =
        resultado === 'frenado'
          ? 'Demasiados intentos. Esperá 15 minutos y probá de nuevo.'
          : 'Esa no es la clave.';
      return res
        .status(resultado === 'frenado' ? 429 : 401)
        .send(pagina({ titulo: 'Autorizar', conSesion: false, angosta: true, error, cuerpo: vistas.autorizar({ pedido }) }));
    }
    res.redirect(303, await acceso.responderPedido(pedido.id, true));
  });

  // --- de acá para abajo, todo pide sesión ----------------------------------

  r.use(async (req, res, next) => {
    try {
      if (!(await acceso.sesionValida(leerGalleta(req, GALLETA)))) {
        if (req.method === 'GET' && req.path !== '/mapa/datos') {
          return res.redirect(303, '/entrar?volver=' + encodeURIComponent(req.originalUrl));
        }
        return res.status(401).send('Hay que entrar de nuevo.');
      }
      // Un formulario solo vale si sale de esta misma web.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origen = req.get('origin');
        if (origen && origen !== config.urlPublica.origin) {
          return res.status(403).send('Pedido rechazado: vino de otro sitio.');
        }
      }
      const p = await consultar("select count(*)::int as n from bandeja where estado = 'pendiente'");
      res.locals.bandeja = p.rows[0].n;
      res.locals.aviso = textoDeAviso(String(req.query.aviso ?? ''));
      next();
    } catch (error) {
      next(error);
    }
  });

  r.post('/salir', async (req, res) => {
    await acceso.cerrarSesion(leerGalleta(req, GALLETA));
    ponerGalleta(res, '', 0);
    res.redirect(303, '/entrar');
  });

  r.get('/', pantalla(async (req, res) => {
    const [panorama, cambios] = await Promise.all([nucleo.panorama(), nucleo.historial({ limite: 8 })]);
    mostrar(res, { titulo: '', cuerpo: vistas.inicio({ panorama, cambios }) });
  }));

  r.get('/buscar', pantalla(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const [resultados, capas] = await Promise.all([q ? nucleo.buscar({ texto: q, limite: 50, conArchivadas: true }) : [], mapaDeCapas()]);
    mostrar(res, { titulo: q ? `Buscar “${q}”` : 'Buscar', cuerpo: vistas.busqueda({ q, resultados, capas }) });
  }));

  r.get('/capa/:clave', pantalla(async (req, res) => {
    const capas = await mapaDeCapas();
    const capa = capas.get(req.params.clave);
    if (!capa) throw new ErrorDeUso('Esa capa no existe.', { codigo: 'no_existe' });
    const tipo = req.query.tipo === undefined ? undefined : String(req.query.tipo);
    const orden = ['recientes', 'titulo', 'fecha'].includes(req.query.orden) ? req.query.orden : capa.clave === 'hechos' ? 'fecha' : 'recientes';
    const salto = Math.max(0, Number(req.query.salto) || 0);
    const [tipos, fichas] = await Promise.all([
      nucleo.tiposDeCapa(capa.clave),
      nucleo.listarFichas({ capa: capa.clave, tipo, orden, limite: POR_PAGINA, salto }),
    ]);
    mostrar(res, { titulo: capa.nombre, capa: capa.clave, cuerpo: vistas.capa({ capa, tipos, fichas, tipo, orden, salto, porPagina: POR_PAGINA, capas }) });
  }));

  // --- fichas ---------------------------------------------------------------

  async function tiposConocidos() {
    const t = await consultar("select distinct tipo from fichas where tipo <> '' and estado <> 'borrada' order by tipo limit 200");
    return t.rows.map((f) => f.tipo);
  }

  r.get('/nueva', pantalla(async (req, res) => {
    const capas = await mapaDeCapas();
    const ficha = {
      capa: capas.has(req.query.capa) ? req.query.capa : 'vinculos',
      titulo: String(req.query.titulo ?? ''),
      alias: [],
      datos: {},
      fecha: req.query.capa === 'hechos' ? hoy() : '',
    };
    mostrar(res, { titulo: 'Ficha nueva', angosta: true, cuerpo: vistas.formularioDeFicha({ ficha, capas, tipos: await tiposConocidos(), nueva: true }) });
  }));

  const camposDeFicha = (b) => ({
    capa: b.capa,
    tipo: b.tipo,
    titulo: b.titulo,
    cuerpo: String(b.cuerpo ?? '').replace(/\r\n/g, '\n'),
    datos: parsearDatos(String(b.datos ?? '').replace(/\r\n/g, '\n')),
    alias: String(b.alias ?? '').split(',').map((a) => a.trim()).filter(Boolean),
    fecha: b.fecha || null,
    origen: b.origen,
    origen_ref: b.origen_ref,
  });

  r.post('/nueva', formulario, pantalla(async (req, res) => {
    const campos = camposDeFicha(req.body);
    try {
      const ficha = await nucleo.crearFicha(emi(), campos, { confirmar: req.body.confirmar === 'si' });
      res.redirect(303, `/ficha/${ficha.id}?aviso=creada`);
    } catch (error) {
      if (!(error instanceof ErrorDeUso)) throw error;
      const capas = await mapaDeCapas();
      res.status(error.codigo === 'parecidas' ? 409 : 400).send(
        pagina({
          titulo: 'Ficha nueva',
          angosta: true,
          bandeja: res.locals.bandeja,
          error: error.codigo === 'parecidas' ? '' : error.message,
          cuerpo: vistas.formularioDeFicha({ ficha: campos, capas, tipos: await tiposConocidos(), nueva: true, parecidas: error.datos?.parecidas ?? [] }),
        }),
      );
    }
  }));

  r.get('/ficha/:id', pantalla(async (req, res) => {
    const [ficha, capas] = await Promise.all([nucleo.leerFicha(req.params.id, { conBorradas: true }), mapaDeCapas()]);
    mostrar(res, { titulo: ficha.titulo, capa: ficha.capa, cuerpo: vistas.ficha({ ficha, capas }) });
  }));

  r.get('/ficha/:id/editar', pantalla(async (req, res) => {
    const [ficha, capas] = await Promise.all([nucleo.leerFicha(req.params.id, { conBorradas: true }), mapaDeCapas()]);
    mostrar(res, { titulo: `Editar ${ficha.titulo}`, capa: ficha.capa, angosta: true, cuerpo: vistas.formularioDeFicha({ ficha, capas, tipos: await tiposConocidos() }) });
  }));

  r.post('/ficha/:id', formulario, pantalla(async (req, res) => {
    await nucleo.editarFicha(emi(req.body.motivo), req.params.id, camposDeFicha(req.body));
    res.redirect(303, `/ficha/${req.params.id}?aviso=guardado`);
  }));

  r.post('/ficha/:id/borrar', formulario, pantalla(async (req, res) => {
    const ficha = await nucleo.borrarFicha(emi(), req.params.id);
    res.redirect(303, `/capa/${ficha.capa}?aviso=borrada`);
  }));

  r.post('/ficha/:id/restaurar', formulario, pantalla(async (req, res) => {
    await nucleo.restaurarFicha(emi(), req.params.id);
    res.redirect(303, `/ficha/${req.params.id}?aviso=restaurada`);
  }));

  r.post('/ficha/:id/archivar', formulario, pantalla(async (req, res) => {
    await nucleo.editarFicha(emi(), req.params.id, { estado: 'archivada' });
    res.redirect(303, `/ficha/${req.params.id}?aviso=archivada`);
  }));

  r.get('/ficha/:id/historial', pantalla(async (req, res) => {
    const ficha = await nucleo.leerFicha(req.params.id, { conBorradas: true });
    const entradas = await nucleo.historial({ ficha_id: ficha.id, limite: HISTORIAL_POR_PAGINA, antes_de: Number(req.query.antes_de) || undefined });
    mostrar(res, { titulo: `Historial de ${ficha.titulo}`, capa: ficha.capa, cuerpo: vistas.historial({ entradas, ficha, limite: HISTORIAL_POR_PAGINA }) });
  }));

  // --- apuntes --------------------------------------------------------------

  r.post('/ficha/:id/apunte', formulario, pantalla(async (req, res) => {
    await nucleo.agregarApunte(emi(), {
      ficha_id: req.params.id,
      texto: String(req.body.texto ?? '').replace(/\r\n/g, '\n'),
      fecha: req.body.fecha || null,
      base: req.body.base,
      origen: req.body.origen,
      reemplaza: req.body.reemplaza || undefined,
    });
    res.redirect(303, `/ficha/${req.params.id}?aviso=apunte#apuntes`);
  }));

  async function apunteConFicha(id) {
    const a = await consultar(
      `select a.id, a.ficha_id, a.texto, a.fecha, a.base, a.origen, a.vigente, f.titulo, f.capa
         from apuntes a join fichas f on f.id = a.ficha_id
        where a.id = $1 and a.estado = 'activo'`,
      [id],
    ).catch(() => ({ rows: [] }));
    if (!a.rows[0]) throw new ErrorDeUso('Ese apunte no existe.', { codigo: 'no_existe' });
    return a.rows[0];
  }

  r.get('/apunte/:id/editar', pantalla(async (req, res) => {
    const a = await apunteConFicha(req.params.id);
    mostrar(res, { titulo: 'Corregir apunte', capa: a.capa, angosta: true, cuerpo: vistas.formularioDeApunteExistente({ apunte: a, ficha: { id: a.ficha_id, titulo: a.titulo } }) });
  }));

  r.post('/apunte/:id', formulario, pantalla(async (req, res) => {
    const a = await nucleo.editarApunte(emi(req.body.motivo), req.params.id, {
      texto: String(req.body.texto ?? '').replace(/\r\n/g, '\n'),
      fecha: req.body.fecha || null,
      base: req.body.base,
      origen: req.body.origen,
      vigente: req.body.vigente === 'si',
    });
    res.redirect(303, `/ficha/${a.ficha_id}?aviso=guardado#apuntes`);
  }));

  r.post('/apunte/:id/borrar', formulario, pantalla(async (req, res) => {
    const a = await nucleo.borrarApunte(emi(), req.params.id);
    res.redirect(303, `/ficha/${a.ficha_id}?aviso=apunte-borrado#apuntes`);
  }));

  // --- enlaces --------------------------------------------------------------

  r.get('/ficha/:id/enlazar', pantalla(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const [ficha, capas] = await Promise.all([nucleo.leerFicha(req.params.id), mapaDeCapas()]);
    const resultados = q ? (await nucleo.buscar({ texto: q, limite: 20 })).filter((f) => f.id !== ficha.id) : [];
    mostrar(res, { titulo: `Enlazar ${ficha.titulo}`, capa: ficha.capa, angosta: true, cuerpo: vistas.elegirEnlace({ ficha, q, resultados, capas }) });
  }));

  r.post('/ficha/:id/enlace', formulario, pantalla(async (req, res) => {
    await nucleo.enlazar(emi(), { desde: req.params.id, hacia: req.body.hacia, relacion: req.body.relacion });
    res.redirect(303, `/ficha/${req.params.id}?aviso=enlazada#enlaces`);
  }));

  r.post('/enlace/:id/borrar', formulario, pantalla(async (req, res) => {
    await nucleo.desenlazar(emi(), req.params.id);
    const volver = /^[0-9a-f-]{36}$/i.test(req.body.volver ?? '') ? `/ficha/${req.body.volver}?aviso=desenlazada#enlaces` : '/';
    res.redirect(303, volver);
  }));

  // --- archivos -------------------------------------------------------------

  r.post('/ficha/:id/archivo', (req, res, next) => {
    subir.single('archivo')(req, res, (error) => {
      if (error) {
        const mensaje = error.code === 'LIMIT_FILE_SIZE' ? `El archivo pasa el máximo de ${TAMANO_MAXIMO / 1024 / 1024} MB.` : 'No se pudo recibir el archivo.';
        return res.status(400).send(pagina({ titulo: 'No se pudo', angosta: true, bandeja: res.locals.bandeja, cuerpo: vistas.noSePudo({ mensaje, volver: `/ficha/${req.params.id}` }) }));
      }
      next();
    });
  }, pantalla(async (req, res) => {
    if (!req.file) throw new ErrorDeUso('No llegó ningún archivo.');
    await guardarArchivo(emi(), {
      ficha_id: req.params.id,
      // Los navegadores mandan el nombre en un formato viejo: se pasa a UTF-8.
      nombre: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      contenido: req.file.buffer,
      descripcion: req.body.descripcion,
    });
    res.redirect(303, `/ficha/${req.params.id}?aviso=archivo#archivos`);
  }));

  r.get('/archivo/:id', pantalla(async (req, res) => {
    const archivo = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await leerArchivo(req.params.id) : null;
    if (!archivo) throw new ErrorDeUso('Ese archivo no existe.', { codigo: 'no_existe' });
    const enLinea = archivo.tipo.startsWith('image/') || archivo.tipo === 'application/pdf';
    res.setHeader('Content-Type', archivo.tipo);
    res.setHeader('Content-Length', archivo.bytes);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader(
      'Content-Disposition',
      `${enLinea ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(archivo.nombre)}`,
    );
    fs.createReadStream(rutaEnDisco(archivo.ruta))
      .on('error', () => {
        if (!res.headersSent) res.status(404);
        res.end();
      })
      .pipe(res);
  }));

  r.post('/archivo/:id/borrar', formulario, pantalla(async (req, res) => {
    const archivo = await borrarArchivo(emi(), req.params.id);
    res.redirect(303, `/ficha/${archivo.ficha_id}?aviso=archivo-borrado#archivos`);
  }));

  // --- mapa -----------------------------------------------------------------

  const SCRIPTS_MAPA = ['/estatico/mapa-motor.js', '/estatico/mapa.js'];

  function capasPedidas(req, capas) {
    const pedidas = [].concat(req.query.capa ?? []).map(String).filter((c) => capas.has(c));
    return pedidas.length ? pedidas : [...capas.keys()];
  }

  r.get('/mapa', pantalla(async (req, res) => {
    const capas = await mapaDeCapas();
    mostrar(res, {
      titulo: 'Mapa', ancha: true, scripts: SCRIPTS_MAPA,
      cuerpo: vistas.mapa({ capas, elegidas: capasPedidas(req, capas), conSueltas: req.query.sueltas === '1' }),
    });
  }));

  r.get('/ficha/:id/mapa', pantalla(async (req, res) => {
    const [ficha, capas] = await Promise.all([nucleo.leerFicha(req.params.id, { conBorradas: true }), mapaDeCapas()]);
    const niveles = [1, 2, 3].includes(Number(req.query.niveles)) ? Number(req.query.niveles) : 2;
    mostrar(res, {
      titulo: `Mapa de ${ficha.titulo}`, capa: ficha.capa, ancha: true, scripts: SCRIPTS_MAPA,
      cuerpo: vistas.mapa({ capas, elegidas: capasPedidas(req, capas), ficha, niveles }),
    });
  }));

  r.get('/mapa/datos', async (req, res, next) => {
    try {
      const capas = await mapaDeCapas();
      const datos = await nucleo.mapa({
        centro: req.query.centro || undefined,
        niveles: req.query.niveles,
        capas: capasPedidas(req, capas),
        conSueltas: req.query.sueltas === '1',
      });
      res.json({
        ...datos,
        capas: Object.fromEntries([...capas.values()].map((c) => [c.clave, c.nombre])),
      });
    } catch (error) {
      if (error instanceof ErrorDeUso) {
        return res.status(error.codigo === 'no_existe' ? 404 : 400).json({ error: error.message });
      }
      next(error);
    }
  });

  // --- historial ------------------------------------------------------------

  r.get('/historial', pantalla(async (req, res) => {
    const quien = ['emiliano', 'alex'].includes(req.query.quien) ? req.query.quien : '';
    const entradas = await nucleo.historial({ quien: quien || undefined, limite: HISTORIAL_POR_PAGINA, antes_de: Number(req.query.antes_de) || undefined });
    mostrar(res, { titulo: 'Historial', cuerpo: vistas.historial({ entradas, quien, limite: HISTORIAL_POR_PAGINA }) });
  }));

  // --- bandeja --------------------------------------------------------------

  r.get('/bandeja', pantalla(async (req, res) => {
    const estado = ['pendiente', 'archivado', 'descartado'].includes(req.query.estado) ? req.query.estado : 'pendiente';
    const elementos = await nucleo.bandejaListar({ estado, limite: 100 });
    mostrar(res, { titulo: 'Bandeja', cuerpo: vistas.bandeja({ elementos, estado }) });
  }));

  r.post('/bandeja', formulario, pantalla(async (req, res) => {
    await nucleo.bandejaAgregar(emi(), {
      contenido: String(req.body.contenido ?? '').replace(/\r\n/g, '\n'),
      origen: req.body.origen,
      fecha: req.body.fecha || null,
    });
    res.redirect(303, '/bandeja?aviso=bandeja');
  }));

  r.get('/bandeja/:id', pantalla(async (req, res) => {
    const elemento = await nucleo.bandejaLeer(req.params.id);
    const fichas = elemento.fichas.length
      ? (await consultar('select id, titulo from fichas where id = any($1)', [elemento.fichas])).rows
      : [];
    mostrar(res, { titulo: 'De la bandeja', angosta: true, cuerpo: vistas.elementoDeBandeja({ elemento, fichas }) });
  }));

  r.post('/bandeja/:id', formulario, pantalla(async (req, res) => {
    const actual = await nucleo.bandejaLeer(req.params.id);
    await nucleo.bandejaResolver(emi(), req.params.id, {
      estado: req.body.estado,
      nota: req.body.nota ?? actual.nota,
      fichas: actual.fichas,
    });
    res.redirect(303, '/bandeja?aviso=resuelto');
  }));

  // --- accesos --------------------------------------------------------------

  async function pantallaDeAccesos(res, extra = {}) {
    const [accesos, llaves] = await Promise.all([acceso.listarAccesos(), acceso.listarLlaves()]);
    mostrar(res, { titulo: 'Accesos', cuerpo: vistas.accesos({ accesos, llaves, entrada: urlEntrada.href, ...extra }) });
  }

  r.get('/accesos', pantalla(async (req, res) => pantallaDeAccesos(res)));

  r.post('/accesos/:id/cortar', formulario, pantalla(async (req, res) => {
    if (/^[0-9a-f-]{36}$/i.test(req.params.id)) await acceso.revocarAcceso(req.params.id);
    res.redirect(303, '/accesos?aviso=cortado');
  }));

  r.post('/llaves', formulario, pantalla(async (req, res) => {
    if (!String(req.body.nombre ?? '').trim()) throw new ErrorDeUso('La llave necesita un nombre.');
    const llaveNueva = await acceso.crearLlave(req.body.nombre);
    res.setHeader('Cache-Control', 'no-store');
    await pantallaDeAccesos(res, { llaveNueva });
  }));

  r.post('/llaves/:id/revocar', formulario, pantalla(async (req, res) => {
    if (/^[0-9a-f-]{36}$/i.test(req.params.id)) await acceso.revocarLlave(req.params.id);
    res.redirect(303, '/accesos?aviso=revocada');
  }));

  r.post('/sesiones/cerrar', formulario, pantalla(async (req, res) => {
    await acceso.cerrarTodasLasSesiones();
    ponerGalleta(res, '', 0);
    res.redirect(303, '/entrar');
  }));

  // --- copias ---------------------------------------------------------------

  r.get('/copias', pantalla(async (req, res) => {
    mostrar(res, { titulo: 'Copias', cuerpo: vistas.copias({ copias: await listarCopias(), aGuardar: config.copiasAGuardar }) });
  }));

  r.post('/copias', formulario, pantalla(async (req, res) => {
    await hacerCopia({ manual: true });
    res.redirect(303, '/copias?aviso=copia');
  }));

  r.get('/copias/:nombre', pantalla(async (req, res) => {
    const ruta = rutaDeCopia(req.params.nombre);
    if (!ruta || !fs.existsSync(ruta)) throw new ErrorDeUso('Esa copia no existe.', { codigo: 'no_existe' });
    res.download(ruta, req.params.nombre);
  }));

  r.get('/exportar', pantalla(async (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="meetmymind-${hoy()}-completo.zip"`);
    await escribirCopia(res, { conArchivos: req.query.archivos === '1' });
  }));

  r.use((req, res) => {
    res.status(404).send(
      pagina({ titulo: 'No existe', angosta: true, bandeja: res.locals.bandeja, cuerpo: vistas.noSePudo({ mensaje: 'Esa página no existe.', volver: '/' }) }),
    );
  });

  return r;
}
