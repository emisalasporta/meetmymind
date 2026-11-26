// Armado de las páginas de la web: escapado seguro, fechas, texto con
// formato y el marco común a todas las pantallas.

import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { config } from '../config.js';

// --- HTML seguro ------------------------------------------------------------

class Crudo {
  constructor(html) {
    this.html = html;
  }
  toString() {
    return this.html;
  }
}

/** Marca un texto como HTML ya armado (no se vuelve a escapar). */
export const crudo = (html) => new Crudo(String(html ?? ''));

export function escapar(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function volcar(valor) {
  if (valor === null || valor === undefined || valor === false || valor === true) return '';
  if (valor instanceof Crudo) return valor.html;
  if (Array.isArray(valor)) return valor.map(volcar).join('');
  return escapar(valor);
}

/** Plantilla: todo lo que se intercala queda escapado, salvo lo marcado como crudo. */
export function h(partes, ...valores) {
  let salida = partes[0];
  for (let i = 0; i < valores.length; i += 1) {
    salida += volcar(valores[i]) + partes[i + 1];
  }
  return new Crudo(salida);
}

// --- fechas -----------------------------------------------------------------

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "2026-11-20" pasa a "20 nov 2026". */
export function dia(fecha) {
  if (!fecha) return '';
  const [a, m, d] = String(fecha).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return String(fecha);
  return `${d} ${MESES[m - 1]} ${a}`;
}

const formatoMomento = new Intl.DateTimeFormat('es-AR', {
  timeZone: config.zonaHoraria,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Un instante, en la hora de Catamarca: "25 nov 2026, 18:42". */
export function momento(cuando) {
  if (!cuando) return '';
  const partes = Object.fromEntries(formatoMomento.formatToParts(new Date(cuando)).map((p) => [p.type, p.value]));
  return `${partes.day} ${partes.month.replace('.', '')} ${partes.year}, ${partes.hour}:${partes.minute}`;
}

const formatoDiaLocal = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.zonaHoraria,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** El día de hoy en Catamarca, como AAAA-MM-DD. */
export function hoy(cuando = new Date()) {
  return formatoDiaLocal.format(cuando);
}

// --- texto con formato ------------------------------------------------------

const PERMITIDO = {
  allowedTags: [
    'p', 'br', 'strong', 'em', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
    'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    th: ['align'],
    td: ['align'],
    input: ['type', 'checked', 'disabled'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  transformTags: {
    a: (nombre, atributos) => {
      const externo = /^https?:/i.test(atributos.href ?? '');
      return {
        tagName: 'a',
        attribs: externo ? { ...atributos, rel: 'noopener noreferrer', target: '_blank' } : atributos,
      };
    },
    // Los títulos dentro de una nota arrancan un nivel más abajo que los de la página.
    h1: 'h3',
    h2: 'h3',
    h3: 'h4',
  },
};

/** Convierte el texto de una ficha (markdown) en HTML seguro. */
export function formato(texto) {
  if (!texto) return crudo('');
  // [[Nombre]] lleva a buscar esa ficha.
  const conEnlaces = String(texto).replace(/\[\[([^\]\n|]{1,200})(?:\|([^\]\n]{1,200}))?\]\]/g, (_, nombre, rotulo) => {
    const destino = '/buscar?q=' + encodeURIComponent(nombre.trim());
    return `[${(rotulo ?? nombre).trim().replace(/([\[\]])/g, '\\$1')}](${destino})`;
  });
  const html = marked.parse(conEnlaces, { gfm: true, breaks: true, async: false });
  return crudo(sanitizeHtml(html, PERMITIDO));
}

// --- pedazos comunes --------------------------------------------------------

const AVISOS = {
  guardado: 'Cambios guardados.',
  creada: 'Ficha creada.',
  borrada: 'Ficha borrada. Se puede recuperar desde el historial.',
  restaurada: 'Ficha recuperada.',
  archivada: 'Ficha archivada.',
  apunte: 'Apunte agregado.',
  'apunte-borrado': 'Apunte borrado.',
  enlazada: 'Fichas enlazadas.',
  desenlazada: 'Enlace quitado.',
  archivo: 'Archivo subido.',
  'archivo-borrado': 'Archivo borrado.',
  bandeja: 'Guardado en la bandeja.',
  resuelto: 'Elemento de la bandeja cerrado.',
  cortado: 'Acceso cortado.',
  revocada: 'Llave revocada.',
  copia: 'Copia hecha.',
  sesiones: 'Se cerraron todas las sesiones.',
};

export function textoDeAviso(clave) {
  return Object.hasOwn(AVISOS, clave) ? AVISOS[clave] : '';
}

export function plural(n, uno, muchos) {
  return `${n} ${n === 1 ? uno : muchos}`;
}

// Cambia en cada arranque, así el navegador no se queda con estilos viejos
// después de publicar una versión nueva.
const VERSION = Date.now().toString(36);

/**
 * El marco de todas las páginas.
 * `capa` tiñe la página con el color de esa capa.
 */
export function pagina({ titulo, cuerpo, conSesion = true, capa = '', aviso = '', error = '', bandeja = 0, angosta = false, ancha = false, scripts = [] }) {
  const nombre = titulo ? `${titulo} · MeetMyMind` : 'MeetMyMind';
  return h`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${nombre}</title>
<link rel="stylesheet" href="/estatico/estilo.css?v=${VERSION}">
<link rel="icon" href="/estatico/icono.svg" type="image/svg+xml">
<script src="/estatico/app.js?v=${VERSION}" defer></script>
${scripts.map((s) => h`<script src="${s}?v=${VERSION}" defer></script>`)}
</head>
<body data-capa="${capa}">
<a class="saltar" href="#contenido">Ir al contenido</a>
<header class="barra">
  <a class="marca" href="${conSesion ? '/' : '/entrar'}" aria-label="MeetMyMind, inicio"><span>MeetMyMind</span></a>
  ${
    conSesion
      ? h`<nav class="menu" aria-label="Secciones">
    <a href="/bandeja">Bandeja${bandeja ? h` <span class="cuenta">${bandeja}</span>` : ''}</a>
    <a href="/historial">Historial</a>
    <details class="mas">
      <summary>Más</summary>
      <div class="mas-lista">
        <a href="/mapa">Mapa</a>
        <a href="/nueva">Ficha nueva</a>
        <a href="/accesos">Accesos</a>
        <a href="/copias">Copias</a>
        <form method="post" action="/salir"><button type="submit">Salir</button></form>
      </div>
    </details>
  </nav>`
      : ''
  }
</header>
<main id="contenido" class="${angosta ? 'angosta' : ancha ? 'ancha' : ''}">
${aviso ? h`<p class="aviso" role="status">${aviso}</p>` : ''}
${error ? h`<p class="aviso mal" role="alert">${error}</p>` : ''}
${cuerpo}
</main>
</body>
</html>`.toString();
}
