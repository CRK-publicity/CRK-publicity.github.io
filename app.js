(() => {
  'use strict';
  const cart = new Map();
  const panel = document.querySelector('#quote-panel');
  const overlay = document.querySelector('.overlay');
  const items = document.querySelector('#quote-items');
  const total = document.querySelector('#quote-total');
  const count = document.querySelector('#cart-count');
  const storeCount = document.querySelector('#store-cart-count');
  const toast = document.querySelector('#toast');
  const money = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const CART_STORAGE_KEY = 'crk-publicity:quote-cart:v1';

  function restoreCart() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY) || '[]');
      if (!Array.isArray(saved)) return;
      saved.slice(0, 12).forEach(([name, price]) => {
        if (typeof name === 'string' && name.length >= 2 && name.length <= 160 && Number.isFinite(price) && price >= 0 && price <= 1000000000) cart.set(name, price);
      });
    } catch { /* Storage is optional: the quote still works for this visit. */ }
  }

  function persistCart() {
    try { window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([...cart.entries()])); } catch { /* Storage is optional. */ }
  }

  function requestNeed(value) {
    const selected = [...cart.keys()].join(', ');
    const base = typeof value === 'string' ? value.trim() : '';
    return selected ? `${base || 'Consulta de tienda'} · SelecciÃ³n: ${selected}`.slice(0, 480) : base;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2300);
  }

  function renderCart() {
    const entries = [...cart.entries()];
    count.textContent = String(entries.length);
    if (storeCount) storeCount.textContent = String(entries.length);
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Todavía no agregaste servicios.';
      items.replaceChildren(empty);
      total.textContent = '$0 COP';
      persistCart();
      return;
    }
    items.replaceChildren(...entries.map(([name, price]) => {
      const row = document.createElement('div');
      const info = document.createElement('span');
      const label = document.createElement('b');
      const value = document.createElement('small');
      const remove = document.createElement('button');
      label.textContent = name;
      value.textContent = price > 0 ? money.format(price) : 'A cotizar';
      remove.type = 'button';
      remove.textContent = 'Quitar';
      remove.addEventListener('click', () => { cart.delete(name); renderCart(); });
      info.append(label, value);
      row.append(info, remove);
      return row;
    }));
    const pricedTotal = entries.reduce((sum, [, price]) => sum + price, 0);
    total.textContent = pricedTotal > 0 ? money.format(pricedTotal) : 'A confirmar';
    persistCart();
  }

  function setPanel(open) {
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    panel.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
    document.body.classList.toggle('panel-open', open);
    if (open) panel.querySelector('.close').focus();
  }

  const serviceButtonBindings = new WeakSet();
  function setServiceButtonLabel(button, label) {
    const textNode = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = `${label} `;
    else button.prepend(document.createTextNode(`${label} `));
  }
  function onServiceButtonClick(event) {
    const button = event.currentTarget;
    const name = button.dataset.service || '';
    const price = Number(button.dataset.price);
    if (!name || !Number.isFinite(price) || price < 0 || price > 1000000000) return;
    const wasAdded = cart.has(name);
    if (wasAdded) cart.delete(name); else cart.set(name, price);
    button.classList.toggle('added', !wasAdded);
    setServiceButtonLabel(button, wasAdded ? (button.dataset.addLabel || 'Agregar') : (button.dataset.addedLabel || 'Agregado'));
    renderCart();
    showToast(wasAdded ? 'Servicio retirado.' : 'Servicio agregado a tu cotización.');
  }
  function bindServiceButtons(scope = document) {
    scope.querySelectorAll('[data-service]').forEach((button) => {
      if (serviceButtonBindings.has(button)) return;
      serviceButtonBindings.add(button);
      button.addEventListener('click', onServiceButtonClick);
    });
  }
  function addCatalogActions() {
    document.querySelectorAll('.product-card .product-copy').forEach((copy) => {
      const title = copy.querySelector('h3');
      const whatsapp = copy.querySelector('a[href^="https://wa.me/"]');
      if (!title || !whatsapp || copy.querySelector('.catalog-add')) return;
      const actions = document.createElement('div');
      const add = document.createElement('button');
      const icon = document.createElement('b');
      actions.className = 'product-actions';
      add.className = 'catalog-add';
      add.type = 'button';
      add.dataset.service = title.textContent.trim();
      add.dataset.price = '0';
      add.dataset.addLabel = 'Agregar a cotizaciÃ³n';
      add.dataset.addedLabel = 'Agregado';
      icon.textContent = '+';
      add.append(document.createTextNode('Agregar a cotizaciÃ³n '), icon);
      whatsapp.classList.add('product-quote-link');
      actions.append(add, whatsapp);
      copy.append(actions);
    });
  }
  bindServiceButtons();
  addCatalogActions();
  bindServiceButtons();
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
  const CMS_PUBLIC_ASSET_ORIGIN = 'https://wiyhambpgiqbnzwrsykd.supabase.co';
  const CMS_MAX_TEXT_LENGTH = 900;

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
  function cleanText(value, maxLength = CMS_MAX_TEXT_LENGTH) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned && cleaned.length <= maxLength ? cleaned : null;
  }
  function cleanInteger(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
  }
  function readPath(value, path) {
    return path.split('.').reduce((current, part) => (isRecord(current) ? current[part] : undefined), value);
  }
  function safeSiteLink(value) {
    const raw = cleanText(value, 2048);
    if (!raw) return null;
    try {
      const url = new URL(raw, window.location.href);
      if (url.origin === window.location.origin) return url.href;
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  }
  function safeSiteImage(value) {
    const raw = cleanText(value, 2048);
    if (!raw) return null;
    try {
      const url = new URL(raw, window.location.href);
      if (url.origin === window.location.origin) return url.href;
      const publicPath = /^\/storage\/v1\/object\/public\/site-media\/[A-Za-z0-9._~%\-/]+$/.test(url.pathname)
        && !url.search
        && !url.hash;
      const signedPath = /^\/storage\/v1\/object\/sign\/site-media\/[A-Za-z0-9._~%\-/]+$/.test(url.pathname)
        && url.searchParams.has('token')
        && [...url.searchParams.keys()].every((key) => key === 'token');
      const isManagedMedia = url.origin === CMS_PUBLIC_ASSET_ORIGIN && (publicPath || signedPath);
      return isManagedMedia ? url.href : null;
    } catch {
      return null;
    }
  }
  function cleanProductCode(value) {
    const code = cleanText(value, 64);
    return code && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : null;
  }
  function normalizeService(value) {
    if (!isRecord(value)) return null;
    const title = cleanText(value.title, 110);
    const description = cleanText(value.description, 460);
    if (!title || !description) return null;
    const features = Array.isArray(value.features)
      ? value.features.map((feature) => cleanText(feature, 120)).filter(Boolean).slice(0, 12)
      : [];
    const ctaData = isRecord(value.cta) ? value.cta : {};
    const requestedCta = cleanText(ctaData.type ?? value.cta_type, 16);
    const productCode = cleanProductCode(ctaData.product_code ?? value.checkout_product_code);
    const configuredUrl = safeSiteLink(ctaData.url ?? value.cta_url);
    const ctaType = requestedCta === 'checkout' && (configuredUrl || productCode)
      ? 'checkout'
      : requestedCta === 'link' && configuredUrl
        ? 'link'
        : 'quote';
    const requestedTheme = cleanText(value.theme, 16);
    return {
      title,
      description,
      features,
      price: cleanInteger(value.price_cop, 0, 1000000000),
      badge: cleanText(value.badge, 42),
      theme: requestedTheme === 'featured' || value.featured === true ? 'featured' : requestedTheme === 'dark' ? 'dark' : '',
      cta: {
        type: ctaType,
        label: (cleanText(ctaData.label ?? value.cta_label, 36) || (ctaType === 'quote' ? 'Agregar' : 'Ver opción')).replace(/\s*\+\s*$/, ''),
        url: configuredUrl,
        productCode
      }
    };
  }
  function normalizeGalleryItem(value) {
    if (!isRecord(value)) return null;
    const imageUrl = safeSiteImage(value.image_url ?? value.imageUrl);
    if (!imageUrl) return null;
    const title = cleanText(value.title, 120) || 'Proyecto CRK Publicity';
    return {
      imageUrl,
      title,
      alt: cleanText(value.alt, 180) || title,
      category: cleanText(value.category, 60) || (value.section === 'products' ? 'Producto reciente' : 'Trabajo reciente'),
      url: safeSiteLink(value.url),
      featured: value.featured === true,
      wide: value.wide === true,
      width: cleanInteger(value.width, 1, 6000) || 808,
      height: cleanInteger(value.height, 1, 6000) || 632
    };
  }
  function parsePublicSiteConfig(payload) {
    if (!isRecord(payload)) return null;
    const source = isRecord(payload.snapshot) ? payload.snapshot : isRecord(payload.data) ? payload.data : payload;
    if (!isRecord(source)) return null;
    const content = isRecord(source.content) ? source.content : {};
    const rawServices = Array.isArray(source.services) ? source.services : [];
    const rawGallery = Array.isArray(source.gallery) ? source.gallery : Array.isArray(source.gallery_items) ? source.gallery_items : [];
    const services = rawServices.map(normalizeService).filter(Boolean).slice(0, 12);
    const gallery = rawGallery.map(normalizeGalleryItem).filter(Boolean).slice(0, 24);
    if (!Object.keys(content).length && !services.length && !gallery.length) return null;
    return { content, services, gallery };
  }
  function applySiteContent(content) {
    document.querySelectorAll('[data-site-content]').forEach((element) => {
      const text = cleanText(readPath(content, element.dataset.siteContent || ''), CMS_MAX_TEXT_LENGTH);
      if (text) element.textContent = text;
    });
    document.querySelectorAll('[data-site-link]').forEach((element) => {
      const destination = safeSiteLink(readPath(content, element.dataset.siteLink || ''));
      if (!destination) return;
      const url = new URL(destination);
      element.href = destination;
      if (url.origin !== window.location.origin) {
        element.target = '_blank';
        element.rel = 'noopener noreferrer';
      } else {
        element.removeAttribute('target');
        element.removeAttribute('rel');
      }
    });
    const pageTitle = cleanText(content.page_title, 120);
    if (pageTitle) document.title = pageTitle;
  }
  function createServiceCard(service, index) {
    const card = document.createElement('article');
    card.className = 'service-card';
    if (service.theme) card.classList.add(service.theme);
    const icon = document.createElement('div');
    icon.className = 'service-icon';
    icon.textContent = String(index + 1).padStart(2, '0');
    card.append(icon);
    if (service.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = service.badge;
      card.append(badge);
    }
    const title = document.createElement('h3');
    title.textContent = service.title;
    const description = document.createElement('p');
    description.textContent = service.description;
    const features = document.createElement('ul');
    service.features.forEach((feature) => {
      const item = document.createElement('li');
      item.textContent = feature;
      features.append(item);
    });
    const footer = document.createElement('div');
    footer.className = 'service-foot';
    const price = document.createElement('span');
    if (service.price === null) {
      price.textContent = 'A cotizar';
    } else {
      price.append(document.createTextNode('Desde '));
      const amount = document.createElement('strong');
      amount.textContent = money.format(service.price);
      price.append(amount);
    }
    footer.append(price);
    if (service.cta.type === 'quote') {
      const action = document.createElement('button');
      action.type = 'button';
      action.dataset.service = service.title;
      action.dataset.price = String(service.price ?? 0);
      action.dataset.addLabel = service.cta.label;
      action.dataset.addedLabel = 'Agregado';
      action.append(document.createTextNode(`${service.cta.label} `));
      const symbol = document.createElement('b');
      symbol.textContent = '+';
      action.append(symbol);
      footer.append(action);
    } else {
      const action = document.createElement('a');
      const fallbackCheckout = service.id && service.cta.productCode
        ? `pago/?service=${encodeURIComponent(service.id)}&product=${encodeURIComponent(service.cta.productCode)}`
        : null;
      const destination = service.cta.url || fallbackCheckout;
      const safeDestination = safeSiteLink(destination);
      if (!safeDestination) return null;
      const url = new URL(safeDestination);
      action.href = safeDestination;
      action.textContent = `${service.cta.label} +`;
      if (url.origin !== window.location.origin) {
        action.target = '_blank';
        action.rel = 'noopener noreferrer';
      }
      footer.append(action);
    }
    card.append(title, description, features, footer);
    return card;
  }
  function renderPublishedServices(services) {
    if (!services.length) return false;
    const grid = document.querySelector('[data-site-services]');
    if (!grid) return false;
    const cards = services.map(createServiceCard).filter(Boolean);
    if (!cards.length) return false;
    grid.setAttribute('aria-busy', 'true');
    grid.replaceChildren(...cards);
    bindServiceButtons(grid);
    grid.setAttribute('aria-busy', 'false');
    return true;
  }
  function createGalleryCard(item) {
    const card = item.url ? document.createElement('a') : document.createElement('article');
    card.className = 'work-card';
    if (item.featured) card.classList.add('work-card-featured');
    if (item.wide) card.classList.add('work-card-wide');
    if (card instanceof HTMLAnchorElement) {
      card.href = item.url;
      const url = new URL(item.url);
      if (url.origin !== window.location.origin) {
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
      }
    }
    const image = document.createElement('img');
    image.src = item.imageUrl;
    image.alt = item.alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.width = item.width;
    image.height = item.height;
    const caption = document.createElement('span');
    const category = document.createElement('small');
    category.textContent = item.category;
    const title = document.createElement('strong');
    title.textContent = item.title;
    const symbol = document.createElement('i');
    symbol.setAttribute('aria-hidden', 'true');
    symbol.textContent = item.url ? '↗' : '•';
    caption.append(category, title, symbol);
    card.append(image, caption);
    return card;
  }
  function renderPublishedGallery(gallery) {
    if (!gallery.length) return false;
    const section = document.querySelector('[data-site-gallery-section]');
    const grid = document.querySelector('[data-site-gallery]');
    if (!section || !grid) return false;
    grid.setAttribute('aria-busy', 'true');
    grid.replaceChildren(...gallery.map(createGalleryCard));
    section.hidden = false;
    grid.setAttribute('aria-busy', 'false');
    return true;
  }
  function applyPublishedSiteConfig(config) {
    applySiteContent(config.content);
    const didRenderServices = renderPublishedServices(config.services);
    const didRenderGallery = renderPublishedGallery(config.gallery);
    if (didRenderServices || didRenderGallery || Object.keys(config.content).length) {
      document.documentElement.dataset.siteConfig = 'published';
      const status = document.querySelector('#site-config-status');
      if (status) status.textContent = 'Contenido actualizado.';
    }
  }
  async function hydratePublishedSiteConfig() {
    if (!backendUrl || !publicKey) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5500);
    try {
      const response = await fetch(`${backendUrl}/functions/v1/public-site-config`, {
        method: 'GET',
        headers: { Accept: 'application/json', apikey: publicKey },
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) return;
      const config = parsePublicSiteConfig(await response.json());
      if (config) applyPublishedSiteConfig(config);
    } catch {
      // La página estática sigue siendo la fuente de respaldo si el CMS no está disponible.
    } finally {
      window.clearTimeout(timeout);
    }
  }
  function schedulePublishedSiteConfig() {
    const start = () => { void hydratePublishedSiteConfig(); };
    if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 1800 });
    else window.setTimeout(start, 350);
  }
  schedulePublishedSiteConfig();
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
        const message = `Hola CRK Publicity, soy ${data.get('name')} de ${data.get('business')}. Necesito: ${requestNeed(data.get('need'))}. Mi correo es ${data.get('email')}.`;
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
            body: JSON.stringify({ name: data.get('name'), email: data.get('email'), phone: data.get('phone'), business: data.get('business'), need: requestNeed(data.get('need')), consent: consent.checked, website: data.get('website') })
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
  restoreCart();
  renderCart();
})();
