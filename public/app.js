// Lo poco que la web hace del lado del navegador. Todo funciona sin esto;
// solo suma comodidad.
(() => {
  // Preguntar antes de borrar o cortar.
  document.addEventListener('submit', (evento) => {
    const pregunta = evento.target.getAttribute('data-confirmar');
    if (pregunta && !window.confirm(pregunta)) evento.preventDefault();
  });

  // Los desplegables de orden se aplican al elegir.
  for (const lista of document.querySelectorAll('select[data-enviar]')) {
    lista.addEventListener('change', () => lista.form.submit());
  }

  // El menú "Más" se cierra al tocar afuera o con Escape.
  const mas = document.querySelector('details.mas');
  if (mas) {
    document.addEventListener('click', (evento) => {
      if (mas.open && !mas.contains(evento.target)) mas.open = false;
    });
    document.addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape' && mas.open) {
        mas.open = false;
        mas.querySelector('summary').focus();
      }
    });
  }

  // Las cajas de texto crecen con lo que se escribe.
  for (const caja of document.querySelectorAll('textarea')) {
    const ajustar = () => {
      caja.style.height = 'auto';
      caja.style.height = caja.scrollHeight + 2 + 'px';
    };
    caja.addEventListener('input', ajustar);
    if (caja.value) ajustar();
  }

  // Al abrir "Agregar…", el cursor va al primer campo.
  for (const bloque of document.querySelectorAll('details.agregar')) {
    bloque.addEventListener('toggle', () => {
      if (bloque.open) bloque.querySelector('input:not([type=hidden]), textarea, select')?.focus();
    });
  }
})();
