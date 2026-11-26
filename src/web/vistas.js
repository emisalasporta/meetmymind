// Las pantallas de la web. Cada función recibe datos y devuelve HTML.

import { h, crudo, dia, momento, formato, plural, hoy } from './plantilla.js';
import { BASES } from '../nucleo.js';

// --- pedazos chicos ---------------------------------------------------------

function grosor(fichas) {
  if (fichas >= 200) return 5;
  if (fichas >= 50) return 4;
  if (fichas >= 10) return 3;
  if (fichas >= 1) return 2;
  return 1;
}

/** Un extracto sin los signos de formato, para las listas. */
function limpio(texto) {
  return String(texto ?? '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b ?? a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+>]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const mayuscula = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

function renglonFicha(f, capas, { sinCapa = false } = {}) {
  const capa = sinCapa ? null : capas.get(f.capa);
  return h`<li class="renglon" data-capa="${f.capa}">
    <a class="renglon-titulo" href="/ficha/${f.id}">${f.titulo}</a>
    <span class="renglon-meta">${[capa?.nombre, f.tipo, f.fecha ? dia(f.fecha) : ''].filter(Boolean).join(', ')}</span>
    ${f.apunte_coincidente ? h`<span class="renglon-extracto">${f.apunte_coincidente}</span>` : limpio(f.extracto) ? h`<span class="renglon-extracto">${limpio(f.extracto)}</span>` : ''}
  </li>`;
}

export function buscador(valor = '', { enfocar = false } = {}) {
  return h`<form class="buscador" action="/buscar" role="search">
    <label class="oculto" for="q">Buscar</label>
    <input id="q" type="search" name="q" value="${valor}" placeholder="Persona, tema o idea" autocomplete="off" ${enfocar ? crudo('autofocus') : ''}>
    <button type="submit">Buscar</button>
  </form>`;
}

// --- historial --------------------------------------------------------------

const VERBOS = { crear: 'creó', editar: 'cambió', borrar: 'borró', restaurar: 'recuperó' };
const CAMPOS = {
  titulo: 'Título', cuerpo: 'Resumen', datos: 'Datos', alias: 'Alias', fecha: 'Fecha', tipo: 'Tipo',
  capa: 'Capa', estado: 'Estado', texto: 'Texto', base: 'En qué se apoya', vigente: 'Vigente',
  origen: 'Origen', origen_ref: 'Referencia', relacion: 'Relación', nota: 'Nota', nombre: 'Nombre',
  descripcion: 'Descripción', contenido: 'Contenido', reemplazado_por: 'Reemplazado por',
  hecho_id: 'Surge de', revocado: 'Cortado', revocada: 'Revocada', fichas: 'Fichas', resuelto: 'Cerrado',
};
const NO_MOSTRAR = new Set(['id', 'ficha_id', 'desde', 'hacia', 'ruta', 'client_id', 'bytes', 'ancho', 'alto', 'tipo_archivo', 'alcance', 'recurso', 'reemplazado_por', 'hecho_id']);

function valorLegible(campo, valor) {
  if (valor === null || valor === undefined || valor === '') return '(vacío)';
  if (campo === 'base') return BASES[valor] ?? valor;
  if (campo === 'vigente') return valor ? 'sí' : 'no';
  if (campo === 'fecha') return dia(valor);
  if (Array.isArray(valor)) return valor.length ? valor.join(', ') : '(vacío)';
  if (typeof valor === 'object') {
    const pares = Object.entries(valor);
    return pares.length ? pares.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n') : '(vacío)';
  }
  const texto = String(valor);
  return texto.length > 700 ? texto.slice(0, 700) + '…' : texto;
}

function queCambio(e) {
  const sujeto = mayuscula(e.quien);
  const verbo = VERBOS[e.accion] ?? e.accion;
  const ficha = e.ficha_id
    ? h`<a href="/ficha/${e.ficha_id}">${e.ficha_titulo ?? 'una ficha'}</a>`
    : '';
  const otra = e.otra_ficha ? h`<a href="/ficha/${e.otra_ficha}">${e.otra_titulo ?? 'otra ficha'}</a>` : '';
  switch (e.tabla) {
    case 'fichas':
      return h`${sujeto} ${verbo} la ficha ${ficha}`;
    case 'apuntes':
      return h`${sujeto} ${verbo} un apunte de ${ficha}`;
    case 'enlaces':
      return h`${sujeto} ${verbo} el enlace entre ${ficha} y ${otra}`;
    case 'archivos':
      return h`${sujeto} ${verbo} un archivo de ${ficha}`;
    case 'bandeja':
      return h`${sujeto} ${verbo} un elemento de la bandeja`;
    case 'accesos':
      return h`${sujeto} ${verbo} el acceso de una IA`;
    case 'llaves':
      return h`${sujeto} ${verbo} una llave`;
    case 'capas':
      return h`${sujeto} ${verbo} la capa ${e.registro}`;
    default:
      return h`${sujeto} ${verbo} ${e.tabla}`;
  }
}

/** De dos grupos de datos, deja solo los nombres cuyo valor cambió. */
function soloLoDistinto(antes, ahora) {
  const a = antes && typeof antes === 'object' ? antes : {};
  const b = ahora && typeof ahora === 'object' ? ahora : {};
  const distintos = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
  const elegir = (o) => Object.fromEntries(distintos.filter((k) => k in o).map((k) => [k, o[k]]));
  return [elegir(a), elegir(b)];
}

function detalleDeCambio(e) {
  if (e.despues && e.antes) {
    const campos = Object.keys(e.despues).filter((c) => !NO_MOSTRAR.has(c));
    if (!campos.length) return '';
    return h`<dl class="cambio">${campos.map((c) => {
      const [antes, ahora] = c === 'datos' ? soloLoDistinto(e.antes[c], e.despues[c]) : [e.antes[c], e.despues[c]];
      return h`<div>
        <dt>${CAMPOS[c] ?? c}</dt>
        <dd><span class="antes"><span class="rotulo">Antes</span> ${valorLegible(c, antes)}</span>
            <span class="ahora"><span class="rotulo">Ahora</span> ${valorLegible(c, ahora)}</span></dd>
      </div>`;
    })}</dl>`;
  }
  // Al crear o quitar, alcanza con mostrar de qué se trataba. El nombre de
  // una ficha ya está en el renglón de arriba.
  if (e.tabla === 'fichas') return '';
  const fila = e.despues ?? e.antes ?? {};
  const resumen = fila.texto ?? fila.contenido ?? fila.nombre ?? fila.relacion ?? '';
  return resumen ? h`<p class="cambio-resumen">${valorLegible('texto', resumen)}</p>` : '';
}

export function renglonHistorial(e, { detalle = true } = {}) {
  return h`<li class="historia">
    <p class="historia-que">${queCambio(e)}</p>
    <p class="historia-cuando">${momento(e.cuando)}${e.motivo ? h`. Motivo: ${e.motivo}` : ''}</p>
    ${detalle ? detalleDeCambio(e) : ''}
  </li>`;
}

// --- entrar y autorizar -----------------------------------------------------

export function entrar({ volver = '/' }) {
  return h`<section class="puerta">
    <h1>Entrar</h1>
    <form method="post" action="/entrar" class="formulario">
      <input type="hidden" name="volver" value="${volver}">
      <label for="clave">Clave</label>
      <input id="clave" type="password" name="clave" autocomplete="current-password" required autofocus>
      <button class="boton" type="submit">Entrar</button>
    </form>
  </section>`;
}

// Direcciones de retorno de las IA más usadas. Las demás no se bloquean,
// pero la pantalla avisa que no las reconoce.
const RETORNOS_CONOCIDOS = ['claude.ai', 'claude.com', 'chatgpt.com', 'openai.com'];

export function autorizar({ pedido }) {
  const nombre = pedido.datos?.client_name || 'Un programa sin nombre';
  let destino = pedido.params.redirectUri;
  let local = false;
  let conocido = false;
  try {
    const url = new URL(pedido.params.redirectUri);
    destino = url.host;
    local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    conocido =
      url.protocol === 'https:' &&
      RETORNOS_CONOCIDOS.some((d) => url.hostname === d || url.hostname.endsWith('.' + d));
  } catch {
    /* se muestra tal cual */
  }
  return h`<section class="puerta">
    <h1>${nombre} quiere conectarse</h1>
    <p>Si lo autorizás, va a poder leer y escribir todo lo que hay en MeetMyMind, hasta que le cortes el acceso.</p>
    <dl class="datos">
      <div><dt>Programa</dt><dd>${nombre}</dd></div>
      <div><dt>Vuelve a</dt><dd>${destino}</dd></div>
    </dl>
    ${
      local
        ? h`<p class="aviso">Este programa corre en tu propia computadora. Autorizalo solo si lo abriste vos recién.</p>`
        : conocido
          ? h`<p class="ayuda">Autorizá solo si vos empezaste esta conexión hace un momento.</p>`
          : h`<p class="aviso mal">No reconozco la dirección “${destino}”. Autorizá solo si vos empezaste esta conexión hace un momento y sabés de quién es esa dirección.</p>`
    }
    <form method="post" action="/autorizar" class="formulario">
      <input type="hidden" name="pedido" value="${pedido.id}">
      <label for="clave">Tu clave, para confirmar</label>
      <input id="clave" type="password" name="clave" autocomplete="current-password" autofocus>
      <div class="acciones">
        <button class="boton" type="submit" name="decision" value="si">Autorizar</button>
        <button class="boton secundario" type="submit" name="decision" value="no" formnovalidate>No autorizar</button>
      </div>
    </form>
  </section>`;
}

// --- inicio -----------------------------------------------------------------

export function inicio({ panorama, cambios }) {
  return h`
  ${buscador()}
  <ol class="estratos" aria-label="Capas">
    ${panorama.capas.map(
      (c) => h`<li><a class="estrato grosor-${grosor(c.fichas)}" data-capa="${c.clave}" href="/capa/${c.clave}">
        <span class="estrato-nombre">${c.nombre}</span>
        <span class="estrato-cuenta">${plural(c.fichas, 'ficha', 'fichas')}</span>
        <span class="estrato-detalle">${c.descripcion}</span>
      </a></li>`,
    )}
  </ol>
  <p class="ver-mapa"><a href="/mapa">Ver el mapa de conexiones</a></p>
  <section class="bloque">
    <h2>Últimos cambios</h2>
    ${
      cambios.length
        ? h`<ul class="historias">${cambios.map((e) => renglonHistorial(e, { detalle: false }))}</ul>
           <p><a href="/historial">Ver todo el historial</a></p>`
        : h`<p class="vacio">Todavía no hay cambios.</p>`
    }
  </section>`;
}

// --- capa y búsqueda --------------------------------------------------------

export function capa({ capa: c, tipos, fichas, tipo, orden, salto, porPagina, capas }) {
  const base = (extra) => {
    const p = new URLSearchParams();
    const todo = { tipo, orden, ...extra };
    for (const [k, v] of Object.entries(todo)) if (v !== undefined && v !== null && v !== '' && !(k === 'orden' && v === 'recientes') && !(k === 'salto' && !v)) p.set(k, v);
    const q = p.toString();
    return `/capa/${c.clave}${q ? '?' + q : ''}`;
  };
  return h`
  <header class="cabeza-capa" data-capa="${c.clave}">
    <h1>${c.nombre}</h1>
    <p>${c.descripcion}</p>
  </header>
  <div class="herramientas">
    <a class="boton" href="/nueva?capa=${c.clave}">Ficha nueva</a>
    <form class="orden" action="/capa/${c.clave}">
      ${tipo !== undefined ? h`<input type="hidden" name="tipo" value="${tipo}">` : ''}
      <label for="orden">Orden</label>
      <select id="orden" name="orden" data-enviar>
        <option value="recientes" ${orden === 'recientes' ? crudo('selected') : ''}>Lo último que cambió</option>
        <option value="titulo" ${orden === 'titulo' ? crudo('selected') : ''}>Por nombre</option>
        <option value="fecha" ${orden === 'fecha' ? crudo('selected') : ''}>Por fecha del hecho</option>
      </select>
      <noscript><button type="submit">Ordenar</button></noscript>
    </form>
  </div>
  ${
    tipos.length > 1
      ? h`<nav class="tipos" aria-label="Tipos de ficha">
          <a href="${base({ tipo: undefined, salto: 0 })}" ${tipo === undefined ? crudo('aria-current="true"') : ''}>Todo</a>
          ${tipos.map((t) => h`<a href="${base({ tipo: t.tipo, salto: 0 })}" ${tipo === t.tipo ? crudo('aria-current="true"') : ''}>${t.tipo || 'sin tipo'} <span class="cuenta">${t.fichas}</span></a>`)}
        </nav>`
      : ''
  }
  ${
    fichas.length
      ? h`<ul class="renglones">${fichas.map((f) => renglonFicha(f, capas, { sinCapa: true }))}</ul>`
      : h`<p class="vacio">Esta capa todavía no tiene fichas${tipo !== undefined ? ' de este tipo' : ''}.</p>`
  }
  <nav class="paginas">
    ${salto > 0 ? h`<a href="${base({ salto: Math.max(0, salto - porPagina) })}">Anteriores</a>` : ''}
    ${fichas.length === porPagina ? h`<a href="${base({ salto: salto + porPagina })}">Siguientes</a>` : ''}
  </nav>`;
}

export function busqueda({ q, resultados, capas }) {
  return h`
  <h1>Buscar</h1>
  ${buscador(q, { enfocar: !q })}
  ${
    q
      ? resultados.length
        ? h`<p class="cantidad">${plural(resultados.length, 'resultado', 'resultados')}</p>
            <ul class="renglones">${resultados.map((f) => renglonFicha(f, capas))}</ul>`
        : h`<p class="vacio">Nada con “${q}”. Probá con otro nombre o un apodo.</p>
            <p><a class="boton secundario" href="/nueva?titulo=${encodeURIComponent(q)}">Crear la ficha “${q}”</a></p>`
      : ''
  }`;
}

// --- ficha ------------------------------------------------------------------

function pieDeApunte(a) {
  const partes = [BASES[a.base] ?? a.base];
  if (a.origen) partes.push(`por ${a.origen}`);
  return h`${partes.join(', ')}${a.hecho_id ? h`, en <a href="/ficha/${a.hecho_id}">${a.hecho_titulo ?? 'un hecho'}</a>` : ''}${a.origen_ref ? h` <span class="referencia">(${a.origen_ref})</span>` : ''}`;
}

function listaDeApuntes(ficha) {
  if (!ficha.apuntes.length) return h`<p class="vacio">Todavía no hay apuntes.</p>`;
  return h`<ol class="apuntes">${ficha.apuntes.map(
    (a) => h`<li class="apunte ${a.vigente ? '' : 'viejo'}" id="apunte-${a.id}">
      <p class="apunte-fecha">${a.fecha ? dia(a.fecha) : 'Sin fecha'}</p>
      <div class="apunte-cuerpo">
        <p class="apunte-texto">${a.texto}</p>
        <p class="apunte-pie">${pieDeApunte(a)}${a.vigente ? '' : h` <span class="marca-vieja">Ya no vigente</span>`}
          <a class="discreto" href="/apunte/${a.id}/editar">Corregir</a></p>
      </div>
    </li>`,
  )}</ol>`;
}

function opcionesDeBase(actual = 'dicho_por_emiliano') {
  return Object.entries(BASES).map(
    ([clave, nombre]) => h`<option value="${clave}" ${clave === actual ? crudo('selected') : ''}>${nombre}</option>`,
  );
}

function formularioDeApunte(ficha) {
  return h`<details class="agregar">
    <summary>Agregar un apunte</summary>
    <form method="post" action="/ficha/${ficha.id}/apunte" class="formulario">
      <label for="apunte-texto">El dato</label>
      <textarea id="apunte-texto" name="texto" rows="3" required></textarea>
      <div class="par">
        <div><label for="apunte-fecha">De cuándo es</label>
          <input id="apunte-fecha" type="date" name="fecha" value="${hoy()}"></div>
        <div><label for="apunte-base">En qué se apoya</label>
          <select id="apunte-base" name="base">${opcionesDeBase()}</select></div>
      </div>
      <label for="apunte-origen">De dónde salió <span class="opcional">(opcional)</span></label>
      <input id="apunte-origen" type="text" name="origen" placeholder="whatsapp, mail, una charla…">
      ${
        ficha.apuntes.some((a) => a.vigente)
          ? h`<label for="apunte-reemplaza">Reemplaza a <span class="opcional">(opcional)</span></label>
              <select id="apunte-reemplaza" name="reemplaza">
                <option value="">Ninguno: es un dato nuevo</option>
                ${ficha.apuntes.filter((a) => a.vigente).map((a) => h`<option value="${a.id}">${a.texto.slice(0, 70)}</option>`)}
              </select>`
          : ''
      }
      <button class="boton" type="submit">Agregar apunte</button>
    </form>
  </details>`;
}

function listaDeEnlaces(ficha, capas) {
  if (!ficha.enlaces.length) return h`<p class="vacio">Todavía no está enlazada con nada.</p>`;
  const grupos = new Map();
  for (const e of ficha.enlaces) {
    if (!grupos.has(e.capa)) grupos.set(e.capa, []);
    grupos.get(e.capa).push(e);
  }
  const orden = [...grupos.keys()].sort((a, b) => (capas.get(a)?.orden ?? 99) - (capas.get(b)?.orden ?? 99));
  return orden.map(
    (clave) => h`<div class="grupo-enlaces" data-capa="${clave}">
      <h3>${capas.get(clave)?.nombre ?? clave}</h3>
      <ul class="enlaces">${grupos.get(clave).map(
        (e) => h`<li>
          <a href="/ficha/${e.ficha_id}">${e.titulo}</a>
          <span class="renglon-meta">${[e.relacion, e.fecha ? dia(e.fecha) : '', e.nota].filter(Boolean).join(', ')}</span>
          <form method="post" action="/enlace/${e.id}/borrar" data-confirmar="¿Quitar el enlace con ${e.titulo}?">
            <input type="hidden" name="volver" value="${ficha.id}">
            <button class="discreto" type="submit">Quitar</button>
          </form>
        </li>`,
      )}</ul>
    </div>`,
  );
}

function listaDeArchivos(ficha) {
  if (!ficha.archivos.length) return '';
  const imagenes = ficha.archivos.filter((a) => a.tipo.startsWith('image/'));
  const otros = ficha.archivos.filter((a) => !a.tipo.startsWith('image/'));
  return h`
    ${imagenes.length ? h`<ul class="imagenes">${imagenes.map(
      (a) => h`<li>
        <a href="/archivo/${a.id}"><img src="/archivo/${a.id}" alt="${a.descripcion || a.nombre}" loading="lazy" ${a.ancho ? crudo(`width="${a.ancho}" height="${a.alto}"`) : ''}></a>
        <form method="post" action="/archivo/${a.id}/borrar" data-confirmar="¿Borrar esta imagen?"><button class="discreto" type="submit">Borrar</button></form>
      </li>`,
    )}</ul>` : ''}
    ${otros.length ? h`<ul class="enlaces">${otros.map(
      (a) => h`<li>
        <a href="/archivo/${a.id}">${a.nombre}</a>
        <span class="renglon-meta">${a.descripcion}</span>
        <form method="post" action="/archivo/${a.id}/borrar" data-confirmar="¿Borrar ${a.nombre}?"><button class="discreto" type="submit">Borrar</button></form>
      </li>`,
    )}</ul>` : ''}`;
}

export function ficha({ ficha: f, capas }) {
  const capa = capas.get(f.capa);
  const datos = Object.entries(f.datos ?? {});
  return h`<article class="ficha">
    <header class="ficha-cabeza">
      <p class="ficha-capa"><a href="/capa/${f.capa}">${capa?.nombre ?? f.capa}</a>${f.tipo ? `, ${f.tipo}` : ''}</p>
      <h1>${f.titulo}</h1>
      ${f.alias.length ? h`<p class="alias">También: ${f.alias.join(', ')}</p>` : ''}
      ${f.fecha ? h`<p class="ficha-fecha">${dia(f.fecha)}</p>` : ''}
      ${f.origen || f.origen_ref ? h`<p class="ficha-origen">Salió de ${[f.origen, f.origen_ref].filter(Boolean).join(', ')}</p>` : ''}
      <p class="ficha-atajo"><a class="discreto" href="/ficha/${f.id}/editar">Editar</a></p>
    </header>
    ${
      f.estado !== 'activa'
        ? h`<div class="aviso">Esta ficha está ${f.estado}.
            <form method="post" action="/ficha/${f.id}/restaurar"><button class="boton secundario" type="submit">${f.estado === 'borrada' ? 'Recuperarla' : 'Volver a activarla'}</button></form></div>`
        : ''
    }
    ${f.cuerpo.trim() ? h`<div class="texto">${formato(f.cuerpo)}</div>` : ''}
    ${
      datos.length
        ? h`<dl class="datos">${datos.map(([k, v]) => h`<div><dt>${k}</dt><dd>${typeof v === 'string' ? v : JSON.stringify(v)}</dd></div>`)}</dl>`
        : ''
    }

    <section id="apuntes" class="bloque">
      <h2>Apuntes</h2>
      ${listaDeApuntes(f)}
      ${formularioDeApunte(f)}
    </section>

    <section id="enlaces" class="bloque">
      <h2>Enlaces</h2>
      ${f.enlaces.length ? h`<p class="ver-mapa"><a href="/ficha/${f.id}/mapa">Ver en el mapa</a></p>` : ''}
      ${listaDeEnlaces(f, capas)}
      <details class="agregar">
        <summary>Enlazar con otra ficha</summary>
        <form action="/ficha/${f.id}/enlazar" class="formulario">
          <label for="enlazar-q">Buscá la otra ficha</label>
          <input id="enlazar-q" type="search" name="q" required placeholder="Nombre o apodo">
          <button class="boton" type="submit">Buscar</button>
        </form>
      </details>
    </section>

    <section id="archivos" class="bloque">
      <h2>Archivos</h2>
      ${f.archivos.length ? listaDeArchivos(f) : h`<p class="vacio">Sin imágenes ni documentos.</p>`}
      <details class="agregar">
        <summary>Subir una imagen o un documento</summary>
        <form method="post" action="/ficha/${f.id}/archivo" enctype="multipart/form-data" class="formulario">
          <label for="archivo">Archivo</label>
          <input id="archivo" type="file" name="archivo" required>
          <label for="archivo-descripcion">Qué es <span class="opcional">(opcional)</span></label>
          <input id="archivo-descripcion" type="text" name="descripcion">
          <p class="ayuda">Imágenes y documentos de hasta 25 MB. Audios y videos no: de esos se anota el enlace.</p>
          <button class="boton" type="submit">Subir archivo</button>
        </form>
      </details>
    </section>

    <footer class="ficha-pie">
      <p class="ficha-acciones">
        <a class="boton" href="/ficha/${f.id}/editar">Editar ficha</a>
        <a class="boton secundario" href="/ficha/${f.id}/historial">Historial</a>
      </p>
      <p class="ficha-fechas">Creada el ${momento(f.creada)}. Último cambio, ${momento(f.actualizada)}.</p>
      ${
        f.estado === 'activa'
          ? h`<div class="ficha-salidas">
              <form method="post" action="/ficha/${f.id}/archivar"><button class="discreto" type="submit">Archivar</button></form>
              <form method="post" action="/ficha/${f.id}/borrar" data-confirmar="¿Borrar la ficha ${f.titulo}? Se puede recuperar desde el historial."><button class="discreto peligro" type="submit">Borrar</button></form>
            </div>`
          : ''
      }
    </footer>
  </article>`;
}

// --- formularios de ficha ---------------------------------------------------

export function datosComoTexto(datos) {
  return Object.entries(datos ?? {})
    .map(([k, v]) => `${k}: ${typeof v === 'string' && !v.includes('\n') ? v : JSON.stringify(v)}`)
    .join('\n');
}

export function formularioDeFicha({ ficha: f, capas, tipos = [], nueva = false, parecidas = [] }) {
  const accion = nueva ? '/nueva' : `/ficha/${f.id}`;
  return h`
  <h1>${nueva ? 'Ficha nueva' : 'Editar ficha'}</h1>
  ${
    parecidas.length
      ? h`<div class="aviso">
          <p>Ya hay fichas parecidas. Si es una de estas, abrila y agregale un apunte.</p>
          <ul class="renglones">${parecidas.map((p) => renglonFicha(p, capas))}</ul>
        </div>`
      : ''
  }
  <form method="post" action="${accion}" class="formulario">
    <label for="titulo">Nombre</label>
    <input id="titulo" type="text" name="titulo" value="${f.titulo ?? ''}" required ${nueva && !f.titulo ? crudo('autofocus') : ''}>

    <div class="par">
      <div><label for="capa">Capa</label>
        <select id="capa" name="capa">${[...capas.values()].map(
          (c) => h`<option value="${c.clave}" ${c.clave === f.capa ? crudo('selected') : ''}>${c.nombre}</option>`,
        )}</select></div>
      <div><label for="tipo">Tipo</label>
        <input id="tipo" type="text" name="tipo" value="${f.tipo ?? ''}" list="tipos" placeholder="persona, reunión, libro…">
        <datalist id="tipos">${tipos.map((t) => h`<option value="${t}">`)}</datalist></div>
    </div>

    <label for="alias">Otros nombres <span class="opcional">(separados por coma)</span></label>
    <input id="alias" type="text" name="alias" value="${(f.alias ?? []).join(', ')}" placeholder="apodos, siglas, “el tesorero”">

    <label for="fecha">Fecha <span class="opcional">(si es algo que pasó)</span></label>
    <input id="fecha" type="date" name="fecha" value="${f.fecha ?? ''}">

    <label for="cuerpo">Resumen</label>
    <textarea id="cuerpo" name="cuerpo" rows="8">${f.cuerpo ?? ''}</textarea>

    <label for="datos">Datos <span class="opcional">(uno por renglón, como “cargo: tesorero”)</span></label>
    <textarea id="datos" name="datos" rows="4">${datosComoTexto(f.datos)}</textarea>

    <div class="par">
      <div><label for="origen">De dónde salió <span class="opcional">(opcional)</span></label>
        <input id="origen" type="text" name="origen" value="${f.origen ?? ''}"></div>
      <div><label for="origen_ref">Referencia <span class="opcional">(opcional)</span></label>
        <input id="origen_ref" type="text" name="origen_ref" value="${f.origen_ref ?? ''}"></div>
    </div>

    ${
      nueva
        ? parecidas.length
          ? h`<label class="casilla"><input type="checkbox" name="confirmar" value="si"> Es otra distinta: crearla igual</label>`
          : ''
        : h`<label for="motivo">Por qué el cambio <span class="opcional">(opcional, queda en el historial)</span></label>
            <input id="motivo" type="text" name="motivo">`
    }
    <div class="acciones">
      <button class="boton" type="submit">${nueva ? 'Crear ficha' : 'Guardar cambios'}</button>
      <a class="boton secundario" href="${nueva ? '/' : `/ficha/${f.id}`}">Cancelar</a>
    </div>
  </form>`;
}

export function formularioDeApunteExistente({ apunte: a, ficha: f }) {
  return h`
  <h1>Corregir apunte</h1>
  <p class="ficha-capa">De la ficha <a href="/ficha/${f.id}">${f.titulo}</a></p>
  <form method="post" action="/apunte/${a.id}" class="formulario">
    <label for="texto">El dato</label>
    <textarea id="texto" name="texto" rows="4" required>${a.texto}</textarea>
    <div class="par">
      <div><label for="fecha">De cuándo es</label>
        <input id="fecha" type="date" name="fecha" value="${a.fecha ?? ''}"></div>
      <div><label for="base">En qué se apoya</label>
        <select id="base" name="base">${opcionesDeBase(a.base)}</select></div>
    </div>
    <label for="origen">De dónde salió</label>
    <input id="origen" type="text" name="origen" value="${a.origen}">
    <label class="casilla"><input type="checkbox" name="vigente" value="si" ${a.vigente ? crudo('checked') : ''}> Sigue vigente</label>
    <label for="motivo">Por qué el cambio <span class="opcional">(opcional)</span></label>
    <input id="motivo" type="text" name="motivo">
    <div class="acciones">
      <button class="boton" type="submit">Guardar cambios</button>
      <a class="boton secundario" href="/ficha/${f.id}#apuntes">Cancelar</a>
    </div>
  </form>
  <form method="post" action="/apunte/${a.id}/borrar" class="aparte" data-confirmar="¿Borrar este apunte?">
    <button class="discreto peligro" type="submit">Borrar este apunte</button>
  </form>`;
}

export function elegirEnlace({ ficha: f, q, resultados, capas }) {
  return h`
  <h1>Enlazar</h1>
  <p class="ficha-capa">Desde la ficha <a href="/ficha/${f.id}">${f.titulo}</a></p>
  <form action="/ficha/${f.id}/enlazar" class="buscador">
    <label class="oculto" for="q">Buscar la otra ficha</label>
    <input id="q" type="search" name="q" value="${q}" required>
    <button type="submit">Buscar</button>
  </form>
  ${
    resultados.length
      ? h`<form method="post" action="/ficha/${f.id}/enlace" class="formulario">
          <fieldset class="opciones">
            <legend>Con cuál</legend>
            ${resultados.map(
              (r, i) => h`<label class="opcion" data-capa="${r.capa}">
                <input type="radio" name="hacia" value="${r.id}" required ${i === 0 ? crudo('checked') : ''}>
                <span><strong>${r.titulo}</strong>
                <span class="renglon-meta">${[capas.get(r.capa)?.nombre, r.tipo, r.fecha ? dia(r.fecha) : ''].filter(Boolean).join(', ')}</span></span>
              </label>`,
            )}
          </fieldset>
          <label for="relacion">Qué relación tienen <span class="opcional">(opcional)</span></label>
          <input id="relacion" type="text" name="relacion" placeholder="participó, trabaja en, trata de…">
          <button class="boton" type="submit">Enlazar</button>
        </form>`
      : h`<p class="vacio">Nada con “${q}”.</p>
          <p><a class="boton secundario" href="/nueva?titulo=${encodeURIComponent(q)}">Crear la ficha “${q}”</a></p>`
  }`;
}

// --- historial, bandeja, accesos, copias ------------------------------------

export function historial({ entradas, quien, ficha: f, limite }) {
  const ultimo = entradas.at(-1)?.id;
  const base = f ? `/ficha/${f.id}/historial` : '/historial';
  return h`
  <h1>Historial${f ? h` de ${f.titulo}` : ''}</h1>
  ${f ? h`<p><a href="/ficha/${f.id}">Volver a la ficha</a></p>` : h`<nav class="tipos" aria-label="Quién hizo el cambio">
    <a href="/historial" ${!quien ? crudo('aria-current="true"') : ''}>Todo</a>
    <a href="/historial?quien=emiliano" ${quien === 'emiliano' ? crudo('aria-current="true"') : ''}>Emiliano</a>
    <a href="/historial?quien=alex" ${quien === 'alex' ? crudo('aria-current="true"') : ''}>Alex</a>
  </nav>`}
  ${
    entradas.length
      ? h`<ul class="historias">${entradas.map((e) => renglonHistorial(e))}</ul>`
      : h`<p class="vacio">Sin cambios para mostrar.</p>`
  }
  <nav class="paginas">
    ${entradas.length === limite ? h`<a href="${base}?${quien ? `quien=${quien}&` : ''}antes_de=${ultimo}">Más antiguos</a>` : ''}
  </nav>`;
}

export function bandeja({ elementos, estado }) {
  return h`
  <h1>Bandeja de entrada</h1>
  <p class="bajada">Acá cae lo crudo. Alex lo pasa a fichas y lo cierra.</p>
  <details class="agregar">
    <summary>Dejar algo en la bandeja</summary>
    <form method="post" action="/bandeja" class="formulario">
      <label for="contenido">Texto</label>
      <textarea id="contenido" name="contenido" rows="6" required></textarea>
      <div class="par">
        <div><label for="origen">De dónde salió</label><input id="origen" type="text" name="origen"></div>
        <div><label for="fecha">De cuándo es</label><input id="fecha" type="date" name="fecha" value="${hoy()}"></div>
      </div>
      <button class="boton" type="submit">Guardar en la bandeja</button>
    </form>
  </details>
  <nav class="tipos" aria-label="Estado">
    ${[['pendiente', 'Pendiente'], ['archivado', 'Archivado'], ['descartado', 'Descartado']].map(
      ([clave, nombre]) => h`<a href="/bandeja?estado=${clave}" ${estado === clave ? crudo('aria-current="true"') : ''}>${nombre}</a>`,
    )}
  </nav>
  ${
    elementos.length
      ? h`<ul class="renglones">${elementos.map(
          (e) => h`<li class="renglon">
            <a class="renglon-titulo" href="/bandeja/${e.id}">${e.extracto.slice(0, 90)}${e.largo > 90 ? '…' : ''}</a>
            <span class="renglon-meta">${[e.origen, e.fecha ? dia(e.fecha) : '', `recibido el ${momento(e.recibido)}`].filter(Boolean).join(', ')}</span>
          </li>`,
        )}</ul>`
      : h`<p class="vacio">${estado === 'pendiente' ? 'No hay nada pendiente.' : 'Nada por acá.'}</p>`
  }`;
}

export function elementoDeBandeja({ elemento: e, fichas }) {
  return h`
  <h1>De la bandeja</h1>
  <p class="ficha-capa">${[e.origen, e.origen_ref, e.fecha ? dia(e.fecha) : '', `recibido el ${momento(e.recibido)}`].filter(Boolean).join(', ')}</p>
  <pre class="crudo">${e.contenido}</pre>
  ${
    e.estado === 'pendiente'
      ? h`<form method="post" action="/bandeja/${e.id}" class="formulario">
          <label for="nota">Nota <span class="opcional">(qué se hizo con esto, o por qué se descarta)</span></label>
          <input id="nota" type="text" name="nota">
          <div class="acciones">
            <button class="boton" type="submit" name="estado" value="archivado">Marcar como archivado</button>
            <button class="boton secundario" type="submit" name="estado" value="descartado">Descartar</button>
          </div>
        </form>`
      : h`<p class="aviso">${mayuscula(e.estado)} el ${momento(e.resuelto)}${e.nota ? `. ${e.nota}` : ''}</p>
          ${fichas.length ? h`<ul class="enlaces">${fichas.map((f) => h`<li><a href="/ficha/${f.id}">${f.titulo}</a></li>`)}</ul>` : ''}
          <form method="post" action="/bandeja/${e.id}"><button class="discreto" type="submit" name="estado" value="pendiente">Volver a dejarlo pendiente</button></form>`
  }
  <p><a href="/bandeja">Volver a la bandeja</a></p>`;
}

export function accesos({ accesos: lista, llaves, entrada, llaveNueva }) {
  const vivos = lista.filter((a) => !a.revocado);
  const cortados = lista.filter((a) => a.revocado);
  const llavesVivas = llaves.filter((l) => !l.revocada);
  return h`
  <h1>Accesos</h1>
  ${
    llaveNueva
      ? h`<div class="aviso">
          <p><strong>Llave “${llaveNueva.nombre}” creada.</strong> Copiala ahora: no se vuelve a mostrar.</p>
          <pre class="codigo">${llaveNueva.llave}</pre>
        </div>`
      : ''
  }
  <section class="bloque">
    <h2>IA autorizadas</h2>
    ${
      vivos.length
        ? h`<ul class="renglones">${vivos.map(
            (a) => h`<li class="renglon con-accion">
              <span class="renglon-titulo">${a.nombre}</span>
              <span class="renglon-meta">Desde el ${momento(a.creado)}. ${a.ultimo_uso ? `Último uso, ${momento(a.ultimo_uso)}` : 'Todavía no se usó'}.</span>
              <form method="post" action="/accesos/${a.id}/cortar" data-confirmar="¿Cortarle el acceso a ${a.nombre}?"><button class="discreto peligro" type="submit">Cortar acceso</button></form>
            </li>`,
          )}</ul>`
        : h`<p class="vacio">Ninguna IA tiene acceso todavía.</p>`
    }
    <p class="ayuda">Para conectar una IA, se le da esta dirección y ella pide permiso acá:</p>
    <pre class="codigo">${entrada}</pre>
    ${cortados.length ? h`<p class="ayuda">Accesos cortados: ${cortados.map((a) => `${a.nombre} (${momento(a.revocado)})`).join('; ')}.</p>` : ''}
  </section>
  <section class="bloque">
    <h2>Llaves</h2>
    <p class="bajada">Una llave es una contraseña larga para un programa propio, como una automatización.</p>
    ${
      llavesVivas.length
        ? h`<ul class="renglones">${llavesVivas.map(
            (l) => h`<li class="renglon con-accion">
              <span class="renglon-titulo">${l.nombre}</span>
              <span class="renglon-meta">Creada el ${momento(l.creado)}. ${l.ultimo_uso ? `Último uso, ${momento(l.ultimo_uso)}` : 'Todavía no se usó'}.</span>
              <form method="post" action="/llaves/${l.id}/revocar" data-confirmar="¿Revocar la llave ${l.nombre}?"><button class="discreto peligro" type="submit">Revocar</button></form>
            </li>`,
          )}</ul>`
        : ''
    }
    <details class="agregar">
      <summary>Crear una llave</summary>
      <form method="post" action="/llaves" class="formulario">
        <label for="llave-nombre">Para qué es</label>
        <input id="llave-nombre" type="text" name="nombre" required placeholder="lector de Plaud, por ejemplo">
        <button class="boton" type="submit">Crear llave</button>
      </form>
    </details>
  </section>
  <section class="bloque">
    <h2>Sesiones</h2>
    <form method="post" action="/sesiones/cerrar" data-confirmar="¿Cerrar la sesión en todos los dispositivos?">
      <button class="boton secundario" type="submit">Cerrar sesión en todos los dispositivos</button>
    </form>
  </section>`;
}

function tamano(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function copias({ copias: lista, aGuardar }) {
  return h`
  <h1>Copias</h1>
  <p class="bajada">Todos los días se hace una copia sola. Se guardan las últimas ${aGuardar}.</p>
  <div class="acciones">
    <form method="post" action="/copias"><button class="boton" type="submit">Hacer una copia ahora</button></form>
    <a class="boton secundario" href="/exportar?archivos=1">Descargar todo, con archivos</a>
  </div>
  ${
    lista.length
      ? h`<ul class="renglones">${lista.map(
          (c) => h`<li class="renglon">
            <a class="renglon-titulo" href="/copias/${c.nombre}">${c.nombre}</a>
            <span class="renglon-meta">${momento(c.hecha)}, ${tamano(c.bytes)}</span>
          </li>`,
        )}</ul>`
      : h`<p class="vacio">Todavía no hay copias guardadas.</p>`
  }
  <p class="ayuda">Cada copia trae las fichas como archivos de texto y el fichero completo para restaurarlo. No trae las imágenes ni los documentos: para eso está “Descargar todo, con archivos”.</p>`;
}

export function noSePudo({ mensaje, volver }) {
  return h`
  <h1>No se pudo</h1>
  <p>${mensaje}</p>
  <p><a class="boton secundario" href="${volver}">Volver</a></p>`;
}

// --- mapa -------------------------------------------------------------------

/** La pantalla del mapa: filtros arriba, el dibujo y una lista para leerlo. */
export function mapa({ capas, elegidas, ficha: f, niveles, conSueltas }) {
  const datos = new URLSearchParams();
  if (f) datos.set('centro', f.id);
  return h`
  <header class="mapa-cabeza">
    ${f ? h`<p class="ficha-capa" data-capa="${f.capa}"><a href="/ficha/${f.id}">Volver a la ficha</a></p>` : ''}
    <h1>${f ? h`Mapa de ${f.titulo}` : 'Mapa'}</h1>
  </header>
  <form class="mapa-filtros" action="${f ? `/ficha/${f.id}/mapa` : '/mapa'}" data-mapa-filtros>
    <fieldset class="chips">
      <legend class="oculto">Capas que se muestran</legend>
      ${[...capas.values()].map(
        (c) => h`<label class="chip" data-capa="${c.clave}">
          <input type="checkbox" name="capa" value="${c.clave}" ${elegidas.includes(c.clave) ? crudo('checked') : ''}>
          <span>${c.nombre}</span>
        </label>`,
      )}
    </fieldset>
    ${
      f
        ? h`<fieldset class="alcance">
            <legend class="oculto">Hasta dónde llega el mapa</legend>
            ${[[1, 'Lo directo'], [2, 'Dos pasos'], [3, 'Tres pasos']].map(
              ([n, nombre]) => h`<label><input type="radio" name="niveles" value="${n}" ${niveles === n ? crudo('checked') : ''}><span>${nombre}</span></label>`,
            )}
          </fieldset>`
        : h`<label class="casilla"><input type="checkbox" name="sueltas" value="1" ${conSueltas ? crudo('checked') : ''}> Mostrar fichas sin enlaces</label>`
    }
    <noscript><button class="boton secundario" type="submit">Aplicar</button></noscript>
  </form>
  <div class="mapa" data-mapa data-datos="/mapa/datos" data-centro="${f?.id ?? ''}">
    <canvas tabindex="0" role="img" aria-label="${f ? `Mapa de las conexiones de ${f.titulo}` : 'Mapa de las conexiones entre fichas'}. La misma información está en la lista de abajo."></canvas>
    <p class="mapa-estado" role="status">Cargando el mapa…</p>
    <div class="mapa-zoom">
      <button type="button" data-zoom="acercar" aria-label="Acercar">+</button>
      <button type="button" data-zoom="alejar" aria-label="Alejar">−</button>
      <button type="button" data-zoom="encuadrar" aria-label="Ver todo">Ver todo</button>
    </div>
    <div class="mapa-ficha" hidden aria-live="polite">
      <button type="button" class="mapa-cerrar" aria-label="Cerrar">×</button>
      <p class="mapa-ficha-capa"></p>
      <p class="mapa-ficha-titulo"></p>
      <p class="mapa-ficha-meta"></p>
      <p class="mapa-ficha-acciones">
        <a class="boton" data-abrir href="#">Abrir ficha</a>
        <a class="boton secundario" data-centrar href="#">Centrar acá</a>
      </p>
    </div>
    <noscript><p class="mapa-estado">El mapa necesita que el navegador tenga JavaScript activado.</p></noscript>
  </div>
  <p class="ayuda">Tocá un punto para ver qué es. Arrastrá para moverte; pellizcá o usá la rueda para acercar.</p>
  <details class="mapa-lista">
    <summary>Ver como lista</summary>
    <div data-mapa-lista></div>
  </details>`;
}
