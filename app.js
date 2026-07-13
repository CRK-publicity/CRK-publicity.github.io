(() => {
  'use strict';
  const cart = new Map();
  const panel = document.querySelector('#quote-panel');
  const overlay = document.querySelector('.overlay');
  const items = document.querySelector('#quote-items');
  const total = document.querySelector('#quote-total');
  const count = document.querySelector('#cart-count');
  const toast = document.querySelector('#toast');
  const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2300);
  }

  function renderCart() {
    const entries = [...cart.entries()];
    count.textContent = String(entries.length);
    if (!entries.length) {
      items.innerHTML = '<p class="empty">Todavía no agregaste servicios.</p>';
      total.textContent = '$0 COP';
      return;
    }
    items.replaceChildren(...entries.map(([name, price]) => {
      const row = document.createElement('div');
      const info = document.createElement('span');
      const label = document.createElement('b');
      const value = document.createElement('small');
      const remove = document.createElement('button');
      label.textContent = name;
      value.textContent = money.format(price);
      remove.type = 'button';
      remove.textContent = 'Quitar';
      remove.addEventListener('click', () => { cart.delete(name); renderCart(); });
      info.append(label, value);
      row.append(info, remove);
      return row;
    }));
    total.textContent = money.format(entries.reduce((sum, [, price]) => sum + price, 0));
  }

  function setPanel(open) {
    panel.setAttribute('aria-hidden', String(!open));
    panel.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    document.body.classList.toggle('panel-open', open);
    if (open) panel.querySelector('.close').focus();
  }

  document.querySelectorAll('[data-service]').forEach((button) => button.addEventListener('click', () => {
    const name = button.dataset.service;
    const wasAdded = cart.has(name);
    if (wasAdded) cart.delete(name); else cart.set(name, Number(button.dataset.price));
    button.classList.toggle('added', !wasAdded);
    button.firstChild.textContent = wasAdded ? 'Agregar ' : 'Agregado ';
    renderCart();
    showToast(wasAdded ? 'Servicio retirado.' : 'Servicio agregado a tu cotización.');
  }));
  document.querySelectorAll('[data-open-quote]').forEach((button) => button.addEventListener('click', () => setPanel(true)));
  document.querySelectorAll('[data-close-quote]').forEach((button) => button.addEventListener('click', () => setPanel(false)));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setPanel(false); });

  const menu = document.querySelector('.menu');
  const nav = document.querySelector('#nav');
  menu.addEventListener('click', () => {
    const open = menu.getAttribute('aria-expanded') === 'true';
    menu.setAttribute('aria-expanded', String(!open));
    nav.classList.toggle('open', !open);
  });
  nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => { nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }));

  const form = document.querySelector('#lead-form');
  const messages = { name: 'Escribe tu nombre.', email: 'Ingresa un correo válido.', business: 'Escribe el nombre del negocio.', need: 'Selecciona una opción.' };
  function validate(field) {
    const error = field.parentElement.querySelector('.error');
    const valid = field.checkValidity();
    field.setAttribute('aria-invalid', String(!valid));
    error.textContent = valid ? '' : messages[field.name];
    return valid;
  }
  form.querySelectorAll('input:not([type="checkbox"]), select').forEach((field) => field.addEventListener('blur', () => validate(field)));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = [...form.querySelectorAll('input:not([type="checkbox"]), select')];
    const fieldsValid = fields.map(validate).every(Boolean);
    const consent = document.querySelector('#consent');
    const consentError = document.querySelector('#consent-error');
    consentError.textContent = consent.checked ? '' : 'Debes autorizar el uso de los datos para continuar.';
    if (!fieldsValid || !consent.checked) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    const success = document.querySelector('#form-success');
    success.classList.add('show');
    success.focus();
    form.reset();
    fields.forEach((field) => field.removeAttribute('aria-invalid'));
  });
  renderCart();
})();
