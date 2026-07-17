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
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Todavía no agregaste servicios.';
      items.replaceChildren(empty);
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
    panel.inert = !open;
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
  const messages = { name: 'Escribe tu nombre.', email: 'Ingresa un correo válido.', phone: 'Ingresa un número de WhatsApp válido.', business: 'Escribe el nombre del negocio.', need: 'Selecciona una opción.' };
  const backendUrl = import.meta.env.VITE_SUPABASE_URL;
  const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  function trackSiteEvent(eventType) {
    if (!backendUrl || !publicKey) return;
    void fetch(`${backendUrl}/functions/v1/track-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: publicKey },
      body: JSON.stringify({ eventType }),
      keepalive: true
    }).catch(() => undefined);
  }
  function scheduleVisitTracking() {
    const send = () => trackSiteEvent('visit');
    if ('requestIdleCallback' in window) window.requestIdleCallback(send, { timeout: 2500 });
    else window.setTimeout(send, 1500);
  }
  scheduleVisitTracking();
  document.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const action = event.target.closest('a[href], button');
    if (action && !action.disabled) trackSiteEvent('click');
  }, { capture: true });

  function initHeroVideo() {
    const video = document.querySelector('.hero-chart-video');
    if (!video) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    let visible = true;
    const syncPlayback = () => {
      if (document.hidden || !visible || reducedMotion.matches || connection?.saveData) video.pause();
      else void video.play().catch(() => undefined);
    };
    if (reducedMotion.matches || connection?.saveData) {
      video.removeAttribute('autoplay');
      video.preload = 'none';
      video.pause();
    }
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; syncPlayback(); }, { rootMargin: '120px', threshold: 0.05 });
      observer.observe(video);
    }
    document.addEventListener('visibilitychange', syncPlayback);
    reducedMotion.addEventListener?.('change', syncPlayback);
    syncPlayback();
  }
  initHeroVideo();
  function validate(field) {
    const error = field.parentElement.querySelector('.error');
    const valid = field.checkValidity();
    field.setAttribute('aria-invalid', String(!valid));
    if (error) error.textContent = valid ? '' : messages[field.name];
    return valid;
  }
  const leadFields = [...form.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]):not(#website), select')];
  leadFields.forEach((field) => field.addEventListener('blur', () => validate(field)));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fieldsValid = leadFields.map(validate).every(Boolean);
    const consent = document.querySelector('#consent');
    const consentError = document.querySelector('#consent-error');
    consentError.textContent = consent.checked ? '' : 'Debes autorizar el uso de los datos para continuar.';
    if (!fieldsValid || !consent.checked) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    const success = document.querySelector('#form-success');
    const data = new FormData(form);
    submit.disabled = true;
    submit.firstChild.textContent = 'Enviando… ';
    success.classList.remove('show', 'failed');
    try {
      if (!backendUrl || !publicKey) {
        const message = `Hola CRK Publicity, soy ${data.get('name')} de ${data.get('business')}. Necesito: ${data.get('need')}. Mi correo es ${data.get('email')}.`;
        window.open(`https://wa.me/573028402389?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
        success.querySelector('b').textContent = 'Continuemos por WhatsApp.';
        success.querySelector('span').textContent = 'Abrimos una conversación con tus datos para atenderte directamente.';
      } else {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 12000);
        let response;
        try {
          response = await fetch(`${backendUrl}/functions/v1/public-lead`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: publicKey },
            signal: controller.signal,
            body: JSON.stringify({ name: data.get('name'), email: data.get('email'), phone: data.get('phone'), business: data.get('business'), need: data.get('need'), consent: consent.checked, website: data.get('website') })
          });
        } finally {
          window.clearTimeout(timeout);
        }
        if (!response.ok) {
          const reason = response.status === 409
            ? 'Para proteger tus datos, confirma tu correo y WhatsApp con nosotros.'
            : response.status === 429
              ? 'Espera unos minutos antes de volver a intentarlo.'
              : 'No pudimos registrar la solicitud.';
          throw new Error(reason);
        }
        success.querySelector('b').textContent = 'Solicitud recibida.';
        success.querySelector('span').textContent = 'Ya quedó registrada para que nuestro equipo pueda responderte.';
      }
      success.classList.add('show');
      success.focus();
      form.reset();
      leadFields.forEach((field) => field.removeAttribute('aria-invalid'));
    } catch (error) {
      success.querySelector('b').textContent = 'No pudimos registrar la solicitud.';
      const detail = success.querySelector('span');
      const link = document.createElement('a');
      link.href = 'https://wa.me/573028402389';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'escríbenos por WhatsApp';
      detail.replaceChildren(document.createTextNode(`${error.message || 'Inténtalo de nuevo'} También puedes `), link, document.createTextNode('.'));
      success.classList.add('show', 'failed');
      success.focus();
    } finally {
      submit.disabled = false;
      submit.firstChild.textContent = 'Solicitar diagnóstico ';
    }
  });

  function initProductSlider(slider) {
    const track = slider.querySelector('.product-slider-track');
    const slides = [...slider.querySelectorAll('.product-slide')];
    const dotsContainer = slider.querySelector('.product-slider-dots');
    const counter = slider.querySelector('.product-slider-counter');
    const previous = slider.querySelector('.product-slider-control.previous');
    const next = slider.querySelector('.product-slider-control.next');
    if (!track || !slides.length || !dotsContainer || !counter || !previous || !next) return;

    let activeIndex = 0;
    let pointerStartX = null;
    const dots = slides.map((slide, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.setAttribute('aria-label', 'Ver imagen ' + (index + 1));
      dot.addEventListener('click', () => showSlide(index));
      return dot;
    });
    dotsContainer.replaceChildren(...dots);

    function showSlide(requestedIndex) {
      activeIndex = (requestedIndex + slides.length) % slides.length;
      track.style.transform = 'translate3d(' + (-activeIndex * 100) + '%, 0, 0)';
      slides.forEach((slide, index) => {
        const active = index === activeIndex;
        slide.setAttribute('aria-hidden', String(!active));
      });
      dots.forEach((dot, index) => {
        const active = index === activeIndex;
        dot.classList.toggle('active', active);
        dot.setAttribute('aria-current', active ? 'true' : 'false');
      });
      counter.textContent = (activeIndex + 1) + ' / ' + slides.length;

      const activeImage = slides[activeIndex].querySelector('img');
      if (!activeImage) return;
      const updateBackground = () => {
        const source = activeImage.currentSrc || activeImage.src;
        slider.style.setProperty('--slider-bg', 'url("' + source + '")');
      };
      if (activeImage.complete) updateBackground();
      else activeImage.addEventListener('load', updateBackground, { once: true });
    }

    previous.addEventListener('click', () => showSlide(activeIndex - 1));
    next.addEventListener('click', () => showSlide(activeIndex + 1));
    slider.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showSlide(activeIndex - 1);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        showSlide(activeIndex + 1);
      }
      if (event.key === 'Home') {
        event.preventDefault();
        showSlide(0);
      }
      if (event.key === 'End') {
        event.preventDefault();
        showSlide(slides.length - 1);
      }
    });
    slider.addEventListener('pointerdown', (event) => {
      if (event.isPrimary) pointerStartX = event.clientX;
    });
    slider.addEventListener('pointerup', (event) => {
      if (pointerStartX === null || !event.isPrimary) return;
      const distance = event.clientX - pointerStartX;
      pointerStartX = null;
      if (Math.abs(distance) < 45) return;
      showSlide(activeIndex + (distance < 0 ? 1 : -1));
    });
    slider.addEventListener('pointercancel', () => { pointerStartX = null; });

    const multipleSlides = slides.length > 1;
    previous.hidden = !multipleSlides;
    next.hidden = !multipleSlides;
    dotsContainer.hidden = !multipleSlides;
    counter.hidden = !multipleSlides;
    showSlide(0);
  }

  const productSliders = [...document.querySelectorAll('[data-product-slider]')];
  if ('IntersectionObserver' in window) {
    const sliderObserver = new IntersectionObserver((entries) => {
      entries.filter((entry) => entry.isIntersecting).forEach((entry) => { initProductSlider(entry.target); sliderObserver.unobserve(entry.target); });
    }, { rootMargin: '500px 0px' });
    productSliders.forEach((slider) => sliderObserver.observe(slider));
  } else productSliders.forEach(initProductSlider);
  renderCart();
})();
