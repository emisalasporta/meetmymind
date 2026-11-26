// El mapa de conexiones: cada ficha es un punto con el color de su capa y
// cada enlace, una línea. Lo acomoda el motor de fuerzas (d3-force): las
// fichas enlazadas se atraen y las demás se separan.
(() => {
  const caja = document.querySelector('[data-mapa]');
  if (!caja || !window.d3) return;

  const lienzo = caja.querySelector('canvas');
  const pincel = lienzo.getContext('2d');
  const estado = caja.querySelector('.mapa-estado');
  const panel = caja.querySelector('.mapa-ficha');
  const formulario = document.querySelector('[data-mapa-filtros]');
  const lista = document.querySelector('[data-mapa-lista]');
  const centroId = caja.dataset.centro || null;
  const movimientoReducido = window.matchMedia('(prefers-reduced-motion: reduce)');
  const temaOscuro = window.matchMedia('(prefers-color-scheme: dark)');

  const nota = document.createElement('p');
  nota.className = 'mapa-nota';
  nota.hidden = true;
  caja.append(nota);

  // --- colores, leídos de la hoja de estilo para que coincidan con la web ---

  const VARIABLE_DE_CAPA = {
    hechos: '--c-hechos', vinculos: '--c-vinculos', proyectos: '--c-proyectos',
    gustos: '--c-gustos', identidad: '--c-identidad', manual: '--c-manual',
  };
  let colores = { capas: {} };
  function leerColores() {
    const estilo = getComputedStyle(document.documentElement);
    const valor = (nombre) => estilo.getPropertyValue(nombre).trim();
    colores = {
      tinta: valor('--tinta'), suave: valor('--tinta-suave'), regla: valor('--linea-fuerte'), papel: valor('--superficie'),
      capas: Object.fromEntries(Object.entries(VARIABLE_DE_CAPA).map(([capa, nombre]) => [capa, valor(nombre)])),
    };
  }
  const colorDe = (capa) => colores.capas[capa] || colores.capas.manual;

  // --- estado -------------------------------------------------------------

  let nodos = [];
  let enlaces = [];
  let vecinos = new Map();
  let nombresDeCapa = {};
  let simulacion = null;
  let vista = { x: 0, y: 0, k: 1 };
  let ancho = 0;
  let alto = 0;
  let densidad = 1;
  let elegido = null;
  let encima = null;
  let tocado = false; // la persona movió la vista: no se re-encuadra solo
  let pedido = 0;
  const posiciones = new Map();

  const radio = (n) => (n.id === centroId ? 11 : Math.min(4.5 + 2.2 * Math.sqrt(n.grado || 0), 18));
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const dia = (f) => {
    const [a, m, d] = String(f).slice(0, 10).split('-').map(Number);
    return a && m && d ? `${d} ${MESES[m - 1]} ${a}` : '';
  };
  const recortar = (t, max = 30) => (t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t);
  const limitar = (v, min, max) => Math.min(max, Math.max(min, v));

  // --- dibujo -------------------------------------------------------------

  let dibujoPendiente = false;
  function pedirDibujo() {
    if (dibujoPendiente) return;
    dibujoPendiente = true;
    requestAnimationFrame(dibujar);
  }

  const aPantalla = (n) => [n.x * vista.k + vista.x, n.y * vista.k + vista.y];

  function dibujar() {
    dibujoPendiente = false;
    pincel.setTransform(densidad, 0, 0, densidad, 0, 0);
    pincel.clearRect(0, 0, ancho, alto);
    if (!nodos.length) return;

    const foco = elegido || encima;
    const cerca = foco ? vecinos.get(foco.id) : null;
    const tocaFoco = (l) => foco && (l.source === foco || l.target === foco);

    pincel.save();
    pincel.translate(vista.x, vista.y);
    pincel.scale(vista.k, vista.k);

    // Líneas comunes, todas juntas; después las del punto elegido, encima.
    pincel.globalAlpha = foco ? 0.22 : 0.75;
    pincel.strokeStyle = colores.regla;
    pincel.lineWidth = 1 / vista.k;
    pincel.beginPath();
    for (const l of enlaces) {
      if (tocaFoco(l)) continue;
      pincel.moveTo(l.source.x, l.source.y);
      pincel.lineTo(l.target.x, l.target.y);
    }
    pincel.stroke();
    if (foco) {
      pincel.globalAlpha = 1;
      pincel.strokeStyle = colores.tinta;
      pincel.lineWidth = 1.75 / vista.k;
      pincel.beginPath();
      for (const l of enlaces) {
        if (!tocaFoco(l)) continue;
        pincel.moveTo(l.source.x, l.source.y);
        pincel.lineTo(l.target.x, l.target.y);
      }
      pincel.stroke();
    }

    for (const n of nodos) {
      const apagado = foco && n !== foco && !cerca.has(n.id);
      pincel.globalAlpha = apagado ? 0.25 : 1;
      pincel.beginPath();
      pincel.arc(n.x, n.y, radio(n), 0, 2 * Math.PI);
      pincel.fillStyle = colorDe(n.capa);
      pincel.fill();
      pincel.lineWidth = 1.5 / vista.k;
      pincel.strokeStyle = colores.papel;
      pincel.stroke();
      if (n.id === centroId || n === elegido) {
        pincel.beginPath();
        pincel.arc(n.x, n.y, radio(n) + 3.5 / vista.k, 0, 2 * Math.PI);
        pincel.lineWidth = 2 / vista.k;
        pincel.strokeStyle = colores.tinta;
        pincel.stroke();
      }
    }
    pincel.restore();
    pincel.globalAlpha = 1;

    // Nombres, en tamaño fijo de pantalla. Primero los más importantes; uno
    // que se pisaría con otro ya escrito no se escribe.
    const ocupado = [];
    const libre = (r) => !ocupado.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    const escribir = (texto, x, y, { tam = 12, peso = 600, color = colores.tinta, forzar = false } = {}) => {
      pincel.font = `${peso} ${tam}px Inter, system-ui, sans-serif`;
      const w = pincel.measureText(texto).width;
      const r = { x: x - w / 2 - 2, y: y - tam, w: w + 4, h: tam + 4 };
      if (!forzar && !libre(r)) return;
      if (r.x + r.w < 0 || r.x > ancho || r.y + r.h < 0 || r.y > alto) return;
      ocupado.push(r);
      pincel.textAlign = 'center';
      pincel.lineJoin = 'round';
      pincel.lineWidth = 3.5;
      pincel.strokeStyle = colores.papel;
      pincel.strokeText(texto, x, y);
      pincel.fillStyle = color;
      pincel.fillText(texto, x, y);
    };

    // Qué relación une al punto elegido con cada vecino.
    if (foco) {
      for (const l of enlaces) {
        if (!tocaFoco(l) || !l.relacion) continue;
        const [x1, y1] = aPantalla(l.source);
        const [x2, y2] = aPantalla(l.target);
        if (Math.hypot(x2 - x1, y2 - y1) < 90) continue;
        escribir(recortar(l.relacion, 22), (x1 + x2) / 2, (y1 + y2) / 2 + 4, { tam: 11, peso: 500, color: colores.suave });
      }
    }

    const todos = nodos.length <= 30 || vista.k >= 1.6;
    const orden = [...nodos].sort((a, b) => {
      const p = (n) => (n === foco ? 3 : n.id === centroId ? 2 : cerca?.has(n.id) ? 1 : 0);
      return p(b) - p(a) || (b.grado || 0) - (a.grado || 0);
    });
    for (const n of orden) {
      const importante = n === foco || n.id === centroId || cerca?.has(n.id);
      if (!importante && !todos && radio(n) * vista.k < 7) continue;
      if (foco && !importante && !todos) continue;
      const [x, y] = aPantalla(n);
      escribir(recortar(n.titulo, n === foco ? 40 : 30), x, y + radio(n) * vista.k + 14, {
        tam: n === foco ? 13 : 12,
        peso: n === foco || n.id === centroId ? 700 : 600,
        color: foco && !importante ? colores.suave : colores.tinta,
        forzar: n === foco,
      });
    }
  }

  // --- encuadre y zoom ----------------------------------------------------

  function encuadrar() {
    if (!nodos.length || !ancho) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodos) {
      const r = radio(n);
      x0 = Math.min(x0, n.x - r); y0 = Math.min(y0, n.y - r);
      x1 = Math.max(x1, n.x + r); y1 = Math.max(y1, n.y + r);
    }
    // Margen generoso: arriba está el aviso, a la derecha los botones y
    // debajo de cada punto, su nombre.
    const izq = 40, der = 72, arriba = 52, abajo = 44;
    const k = limitar(Math.min((ancho - izq - der) / (x1 - x0 || 1), (alto - arriba - abajo) / (y1 - y0 || 1)), 0.08, 2.2);
    vista = {
      k,
      x: izq + (ancho - izq - der) / 2 - k * (x0 + x1) / 2,
      y: arriba + (alto - arriba - abajo) / 2 - k * (y0 + y1) / 2,
    };
    pedirDibujo();
  }

  function zoomEn(px, py, factor) {
    const k = limitar(vista.k * factor, 0.05, 6);
    const wx = (px - vista.x) / vista.k;
    const wy = (py - vista.y) / vista.k;
    vista = { k, x: px - wx * k, y: py - wy * k };
    tocado = true;
    pedirDibujo();
  }

  function ajustarTamano() {
    const caja2 = lienzo.getBoundingClientRect();
    const antes = { ancho, alto };
    ancho = caja2.width;
    alto = caja2.height;
    densidad = window.devicePixelRatio || 1;
    lienzo.width = Math.round(ancho * densidad);
    lienzo.height = Math.round(alto * densidad);
    if (!tocado) encuadrar();
    else if (antes.ancho) {
      vista.x += (ancho - antes.ancho) / 2;
      vista.y += (alto - antes.alto) / 2;
    }
    pedirDibujo();
  }
  new ResizeObserver(ajustarTamano).observe(lienzo);

  // En el celular, el mapa ocupa justo lo que queda de pantalla debajo de
  // los filtros, para que se vea entero sin correr la página.
  function alturaEnCelular() {
    if (window.innerWidth >= 736) {
      caja.style.height = '';
      return;
    }
    const arriba = caja.getBoundingClientRect().top + window.scrollY;
    caja.style.height = Math.max(352, Math.round(window.innerHeight - arriba - 12)) + 'px';
  }
  alturaEnCelular();
  let anchoAnterior = window.innerWidth;
  window.addEventListener('resize', () => {
    // En el celular la barra del navegador cambia el alto al hacer scroll:
    // solo se recalcula si cambió el ancho (al girar la pantalla).
    if (window.innerWidth !== anchoAnterior) {
      anchoAnterior = window.innerWidth;
      alturaEnCelular();
    }
  });

  // --- elegir un punto ----------------------------------------------------

  function consulta() {
    const p = new URLSearchParams(formulario ? new FormData(formulario) : undefined);
    return p;
  }

  function seleccionar(n) {
    elegido = n;
    if (!n) {
      panel.hidden = true;
      pedirDibujo();
      return;
    }
    panel.dataset.capa = n.capa;
    panel.querySelector('.mapa-ficha-capa').textContent = [nombresDeCapa[n.capa] || n.capa, n.tipo].filter(Boolean).join(', ');
    panel.querySelector('.mapa-ficha-titulo').textContent = n.titulo;
    const g = n.grado || 0;
    panel.querySelector('.mapa-ficha-meta').textContent = [n.fecha ? dia(n.fecha) : '', `${g} ${g === 1 ? 'conexión' : 'conexiones'}`]
      .filter(Boolean).join('. ');
    panel.querySelector('[data-abrir]').href = `/ficha/${n.id}`;
    const centrar = panel.querySelector('[data-centrar]');
    const p = consulta();
    p.delete('sueltas');
    if (!p.has('niveles')) p.set('niveles', '2');
    centrar.href = `/ficha/${n.id}/mapa?${p}`;
    centrar.hidden = n.id === centroId;
    panel.hidden = false;
    pedirDibujo();
  }
  panel.querySelector('.mapa-cerrar').addEventListener('click', () => {
    seleccionar(null);
    lienzo.focus();
  });

  function puntoEn(px, py) {
    const wx = (px - vista.x) / vista.k;
    const wy = (py - vista.y) / vista.k;
    let mejor = null;
    let distancia = Infinity;
    for (const n of nodos) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < radio(n) + 10 / vista.k && d < distancia) {
        mejor = n;
        distancia = d;
      }
    }
    return mejor;
  }

  // --- dedo, mouse y teclado ----------------------------------------------

  const punteros = new Map();
  let arrastre = null;
  let pellizco = null;
  const posicion = (e) => {
    const r = lienzo.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function soltarPunto() {
    if (arrastre?.nodo && arrastre.movido && arrastre.nodo.id !== centroId) {
      arrastre.nodo.fx = null;
      arrastre.nodo.fy = null;
    }
    simulacion?.alphaTarget(0);
    lienzo.classList.remove('agarrando');
  }

  lienzo.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    lienzo.setPointerCapture(e.pointerId);
    const p = posicion(e);
    punteros.set(e.pointerId, p);
    if (punteros.size === 2) {
      soltarPunto();
      arrastre = null;
      const [a, b] = [...punteros.values()];
      pellizco = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, medio: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, vista: { ...vista } };
    } else if (punteros.size === 1) {
      arrastre = { nodo: puntoEn(p.x, p.y), x0: p.x, y0: p.y, vista: { ...vista }, movido: false };
    }
  });

  lienzo.addEventListener('pointermove', (e) => {
    const p = posicion(e);
    if (punteros.has(e.pointerId)) punteros.set(e.pointerId, p);
    if (pellizco && punteros.size === 2) {
      const [a, b] = [...punteros.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const medio = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = limitar(pellizco.vista.k * (d / pellizco.d), 0.05, 6);
      const wx = (pellizco.medio.x - pellizco.vista.x) / pellizco.vista.k;
      const wy = (pellizco.medio.y - pellizco.vista.y) / pellizco.vista.k;
      vista = { k, x: medio.x - wx * k, y: medio.y - wy * k };
      tocado = true;
      pedirDibujo();
      return;
    }
    if (arrastre) {
      const dx = p.x - arrastre.x0;
      const dy = p.y - arrastre.y0;
      if (!arrastre.movido && Math.hypot(dx, dy) > 5) {
        arrastre.movido = true;
        tocado = true;
        lienzo.classList.add('agarrando');
        if (arrastre.nodo) simulacion?.alphaTarget(0.25).restart();
      }
      if (!arrastre.movido) return;
      if (arrastre.nodo) {
        arrastre.nodo.fx = (p.x - vista.x) / vista.k;
        arrastre.nodo.fy = (p.y - vista.y) / vista.k;
      } else {
        vista = { ...arrastre.vista, x: arrastre.vista.x + dx, y: arrastre.vista.y + dy };
      }
      pedirDibujo();
      return;
    }
    if (e.pointerType === 'mouse') {
      const n = puntoEn(p.x, p.y);
      if (n !== encima) {
        encima = n;
        lienzo.classList.toggle('sobre-punto', Boolean(n));
        pedirDibujo();
      }
    }
  });

  function terminar(e, cancelado) {
    punteros.delete(e.pointerId);
    if (pellizco) {
      if (punteros.size < 2) pellizco = null;
      arrastre = null;
      return;
    }
    if (!arrastre) return;
    if (!arrastre.movido && !cancelado) seleccionar(arrastre.nodo);
    soltarPunto();
    arrastre = null;
  }
  lienzo.addEventListener('pointerup', (e) => terminar(e, false));
  lienzo.addEventListener('pointercancel', (e) => terminar(e, true));
  lienzo.addEventListener('pointerleave', () => {
    if (encima && !arrastre) {
      encima = null;
      pedirDibujo();
    }
  });

  lienzo.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = posicion(e);
    zoomEn(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  }, { passive: false });

  lienzo.addEventListener('keydown', (e) => {
    const paso = 60;
    const acciones = {
      ArrowLeft: () => { vista.x += paso; },
      ArrowRight: () => { vista.x -= paso; },
      ArrowUp: () => { vista.y += paso; },
      ArrowDown: () => { vista.y -= paso; },
      '+': () => zoomEn(ancho / 2, alto / 2, 1.3),
      '=': () => zoomEn(ancho / 2, alto / 2, 1.3),
      '-': () => zoomEn(ancho / 2, alto / 2, 1 / 1.3),
      0: () => { tocado = false; encuadrar(); },
      Escape: () => seleccionar(null),
    };
    const accion = acciones[e.key];
    if (!accion) return;
    e.preventDefault();
    tocado = true;
    accion();
    pedirDibujo();
  });

  for (const boton of caja.querySelectorAll('[data-zoom]')) {
    boton.addEventListener('click', () => {
      const tipo = boton.dataset.zoom;
      if (tipo === 'encuadrar') {
        tocado = false;
        encuadrar();
      } else {
        zoomEn(ancho / 2, alto / 2, tipo === 'acercar' ? 1.4 : 1 / 1.4);
      }
    });
  }

  // --- armar el mapa con los datos ----------------------------------------

  function armar(datos) {
    simulacion?.stop();
    for (const n of nodos) posiciones.set(n.id, { x: n.x, y: n.y });
    nombresDeCapa = datos.capas || {};
    const porId = new Map(datos.nodos.map((n) => [n.id, n]));
    nodos = datos.nodos;
    enlaces = datos.enlaces
      .filter((l) => porId.has(l.desde) && porId.has(l.hacia))
      .map((l) => ({ ...l, source: l.desde, target: l.hacia }));
    vecinos = new Map(nodos.map((n) => [n.id, new Set()]));
    for (const l of enlaces) {
      vecinos.get(l.desde).add(l.hacia);
      vecinos.get(l.hacia).add(l.desde);
    }

    const local = Boolean(centroId);
    nodos.forEach((n, i) => {
      const antes = posiciones.get(n.id);
      if (antes) {
        n.x = antes.x;
        n.y = antes.y;
      } else if (local) {
        const angulo = i * 2.39996;
        const r = (n.nivel || 0) * 100 + 10;
        n.x = Math.cos(angulo) * r;
        n.y = Math.sin(angulo) * r;
      }
      if (n.id === centroId) {
        n.fx = 0;
        n.fy = 0;
      }
    });
    if (elegido) elegido = porId.get(elegido.id) || null;
    if (!elegido) panel.hidden = true;

    simulacion = window.d3
      .forceSimulation(nodos)
      .force('enlace', window.d3.forceLink(enlaces).id((n) => n.id).distance(local ? 75 : 45))
      .force('carga', window.d3.forceManyBody().strength(local ? -260 : -70).distanceMax(local ? 700 : 360))
      .force('choque', window.d3.forceCollide((n) => radio(n) + 3))
      .force('x', window.d3.forceX(0).strength(local ? 0.02 : 0.07))
      .force('y', window.d3.forceY(0).strength(local ? 0.02 : 0.07));
    if (local) {
      simulacion.force('anillos', window.d3.forceRadial((n) => (n.nivel || 0) * 115, 0, 0).strength(0.12));
    }
    simulacion.on('tick', () => {
      if (!tocado) encuadrar();
      pedirDibujo();
    });

    simulacion.stop();
    if (movimientoReducido.matches) {
      simulacion.tick(Math.ceil(Math.log(simulacion.alphaMin()) / Math.log(1 - simulacion.alphaDecay())));
    } else {
      simulacion.tick(nodos.length > 600 ? 25 : 80);
      simulacion.restart();
    }
    encuadrar();
    pedirDibujo();

    // Avisos sobre lo que se está viendo.
    const partes = [];
    if (datos.recortado) {
      partes.push(local ? `Se muestran las primeras ${datos.maximo} fichas.` : `Se muestran las ${datos.maximo.toLocaleString('es-AR')} fichas con más conexiones.`);
    } else if (local && nodos.length === 1) {
      partes.push('Esta ficha todavía no está enlazada con nada en estas capas.');
    } else {
      partes.push(`${nodos.length} ${nodos.length === 1 ? 'ficha' : 'fichas'}, ${enlaces.length} ${enlaces.length === 1 ? 'enlace' : 'enlaces'}`);
    }
    nota.textContent = partes.join(' ');
    nota.hidden = !nodos.length;
    estado.textContent = nodos.length ? '' : 'No hay fichas para mostrar con estas capas.';
    caja.dataset.listo = String(nodos.length);
    armarLista();
  }

  function armarLista() {
    if (!lista) return;
    lista.replaceChildren();
    const grupos = new Map();
    for (const n of nodos) {
      if (!grupos.has(n.capa)) grupos.set(n.capa, []);
      grupos.get(n.capa).push(n);
    }
    const ordenCapas = Object.keys(nombresDeCapa);
    for (const capa of [...grupos.keys()].sort((a, b) => ordenCapas.indexOf(a) - ordenCapas.indexOf(b))) {
      const titulo = document.createElement('h3');
      titulo.dataset.capa = capa;
      titulo.textContent = nombresDeCapa[capa] || capa;
      const ul = document.createElement('ul');
      ul.className = 'enlaces';
      for (const n of grupos.get(capa).sort((a, b) => (b.grado || 0) - (a.grado || 0) || a.titulo.localeCompare(b.titulo, 'es'))) {
        const li = document.createElement('li');
        li.dataset.capa = capa;
        const a = document.createElement('a');
        a.href = `/ficha/${n.id}`;
        a.textContent = n.titulo;
        const meta = document.createElement('span');
        meta.className = 'renglon-meta';
        const g = n.grado || 0;
        meta.textContent = [
          n.tipo, n.fecha ? dia(n.fecha) : '', `${g} ${g === 1 ? 'conexión' : 'conexiones'}`,
          centroId && n.nivel ? `a ${n.nivel} ${n.nivel === 1 ? 'paso' : 'pasos'}` : '',
        ].filter(Boolean).join(', ');
        li.append(a, meta);
        ul.append(li);
      }
      lista.append(titulo, ul);
    }
  }

  async function cargar() {
    const numero = ++pedido;
    const p = consulta();
    if (centroId) p.set('centro', centroId);
    if (!nodos.length) estado.textContent = 'Cargando el mapa…';
    try {
      const r = await fetch(`${caja.dataset.datos}?${p}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (r.status === 401) {
        window.location.href = '/entrar?volver=' + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      if (!r.ok) throw new Error(String(r.status));
      const datos = await r.json();
      if (numero !== pedido) return;
      armar(datos);
    } catch {
      if (numero === pedido) estado.textContent = 'No se pudo cargar el mapa. Recargá la página.';
    }
  }

  if (formulario) {
    formulario.addEventListener('change', () => {
      const destino = new URL(formulario.action);
      destino.search = String(consulta());
      window.history.replaceState(null, '', destino.pathname + destino.search);
      cargar();
    });
    formulario.addEventListener('submit', (e) => {
      e.preventDefault();
      cargar();
    });
  }

  const alCambiarTema = () => {
    leerColores();
    pedirDibujo();
  };
  temaOscuro.addEventListener?.('change', alCambiarTema);
  document.fonts?.ready.then(pedirDibujo);

  leerColores();
  ajustarTamano();
  cargar();
})();
