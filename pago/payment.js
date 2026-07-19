(() => {
  "use strict";

  const formPanel = document.querySelector("#checkout-panel");
  const form = document.querySelector("#payment-form");
  const submitButton = form.querySelector("button[type=submit]");
  const scopeConfirmation = document.querySelector("#scope-confirmation");
  const privacyConfirmation = document.querySelector("#privacy-confirmation");
  const resultPanel = document.querySelector("#payment-result");
  const resultIcon = document.querySelector("#result-icon");
  const resultTitle = document.querySelector("#result-title");
  const resultMessage = document.querySelector("#result-message");
  const resultOrder = document.querySelector("#result-order");
  const resultPrimary = document.querySelector("#result-primary");
  const formError = document.querySelector("#payment-error");
  const productEyebrow = document.querySelector("#product-eyebrow");
  const productTitle = document.querySelector("#product-title");
  const productIntro = document.querySelector("#product-intro");
  const productPrice = document.querySelector("#product-price");
  const productScope = document.querySelector("#product-scope");
  const payButtonLabel = document.querySelector("#pay-button-label");
  const backendUrl = import.meta.env.VITE_SUPABASE_URL;
  const publicKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const trustedCheckoutHosts = new Set([
    "www.mercadopago.com",
    "sandbox.mercadopago.com",
    "www.mercadopago.com.co",
    "sandbox.mercadopago.com.co"
  ]);
  const acceptanceVersions = Object.freeze({
    scope: "site-checkout-2026-07-17-v1",
    privacy: "privacy-2026-07-16-v1"
  });
  const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
  const fieldMessages = {
    name: "Escribe tu nombre completo.",
    email: "Ingresa un correo válido.",
    phone: "Ingresa un WhatsApp válido."
  };
  const defaultProduct = Object.freeze({
    serviceId: "",
    productCode: "web_starter",
    eyebrow: "Paquete web inicial",
    title: "Tu negocio merece una web clara.",
    description: "Una landing esencial de una página, basada en una estructura probada y personalizada con tu marca.",
    amount: 200000,
    currency: "COP",
    features: ["Diseño responsive y personalización básica", "Formulario y botón de WhatsApp", "SEO local esencial"]
  });
  let volatileRequestId = "";
  let activeProduct = { ...defaultProduct };
  let requestStorageKey = "crkPaymentRequestId:web_starter";

  function createRequestId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function savedRequestId() {
    try {
      return sessionStorage.getItem(requestStorageKey) || volatileRequestId;
    } catch {
      return volatileRequestId;
    }
  }

  function saveRequestId(value) {
    volatileRequestId = value;
    try {
      sessionStorage.setItem(requestStorageKey, value);
    } catch {
      // El UUID en memoria sigue protegiendo este intento si el almacenamiento está bloqueado.
    }
  }

  function clearRequestId() {
    volatileRequestId = "";
    try {
      sessionStorage.removeItem(requestStorageKey);
    } catch {
      // La navegación ya puede continuar sin acceso al almacenamiento.
    }
  }

  function validateField(field) {
    const error = field.parentElement.querySelector(".field-error");
    const valid = field.checkValidity();
    field.setAttribute("aria-invalid", String(!valid));
    if (error) error.textContent = valid ? "" : fieldMessages[field.name];
    return valid;
  }

  function validateConfirmation(field) {
    const valid = field.checked;
    field.setAttribute("aria-invalid", String(!valid));
    return valid;
  }

  function checkoutUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const safeAuthority = !url.username && !url.password && !url.port;
      return url.protocol === "https:" && trustedCheckoutHosts.has(url.hostname) && safeAuthority ? url.href : "";
    } catch {
      return "";
    }
  }

  function renderProduct(product) {
    productEyebrow.textContent = product.eyebrow;
    productTitle.textContent = product.title;
    productIntro.textContent = product.description;
    productPrice.replaceChildren(document.createTextNode(money.format(product.amount) + " "), (() => {
      const currency = document.createElement("small");
      currency.textContent = product.currency;
      return currency;
    })());
    productScope.replaceChildren();
    product.features.forEach((feature) => {
      const item = document.createElement("li");
      const marker = document.createElement("span");
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = "✓";
      item.append(marker, document.createTextNode(" " + feature));
      productScope.append(item);
    });
    payButtonLabel.textContent = "Pagar " + money.format(product.amount) + " " + product.currency;
  }

  function usableService(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cta = value.cta && typeof value.cta === "object" && !Array.isArray(value.cta) ? value.cta : {};
    const id = String(value.id || "");
    const code = String(cta.product_code || "");
    const amount = Number(value.price_cop);
    const title = String(value.title || "").trim();
    const description = String(value.description || "").trim();
    const features = Array.isArray(value.features) ? value.features.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8) : [];
    if (!uuidPattern.test(id) || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(code) || cta.type !== "checkout"
      || !Number.isSafeInteger(amount) || amount < 1000 || String(value.currency || "") !== "COP" || !title || !description) return null;
    return {
      serviceId: id,
      productCode: code,
      eyebrow: "Pago seguro",
      title,
      description,
      amount,
      currency: "COP",
      features: features.length ? features : ["Servicio personalizado por CRK Publicity"]
    };
  }

  async function loadRequestedService() {
    const parameters = new URLSearchParams(window.location.search);
    const requestedId = parameters.get("service") || "";
    const requestedCode = parameters.get("product") || "";
    if (!requestedId && !requestedCode) return true;
    if ((requestedId && !uuidPattern.test(requestedId)) || (requestedCode && !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(requestedCode)) || !backendUrl || !publicKey) return false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(backendUrl + "/functions/v1/public-site-config", {
        method: "GET",
        headers: { apikey: publicKey },
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return false;
      const services = Array.isArray(data?.snapshot?.services) ? data.snapshot.services : [];
      const source = services.find((item) => requestedId
        ? String(item?.id || "") === requestedId
        : String(item?.cta?.product_code || "") === requestedCode);
      const service = usableService(source);
      if (!service) return false;
      activeProduct = service;
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function postFunction(name, payload, timeoutMs = 15000) {
    if (!backendUrl || !publicKey) throw new Error("Los pagos aún no están configurados.");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(backendUrl + "/functions/v1/" + name, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: publicKey },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const fallback = response.status === 409
          ? "Los datos no coinciden con este intento de pago. Inicia uno nuevo."
          : response.status === 429
            ? "Espera unos minutos antes de volver a intentarlo."
            : response.status === 503
              ? "El pago está en proceso de activación. Escríbenos por WhatsApp."
              : "No pudimos completar la operación.";
        const failure = new Error(typeof data.error === "string" ? data.error : fallback);
        failure.code = typeof data.code === "string" ? data.code : "request_failed";
        throw failure;
      }
      return data;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("La conexión tardó demasiado. Inténtalo nuevamente.");
      }
      if (error instanceof TypeError) {
        throw new Error("No pudimos conectar con el servicio de pago. Revisa tu conexión.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function showResult() {
    formPanel.hidden = true;
    resultPanel.hidden = false;
  }

  function renderStatus(data) {
    const status = String(data.status || "");
    const amount = Number(data.amount);
    const validAmount = Number.isSafeInteger(amount) && amount > 0;
    resultIcon.className = "result-icon";
    resultOrder.textContent = validAmount ? String(data.title || "Página web inicial") + " · " + money.format(amount) : "";

    if (status === "approved") {
      resultIcon.textContent = "✓";
      resultIcon.classList.add("approved");
      resultTitle.textContent = "Pago confirmado";
      resultMessage.textContent = "Recibimos la confirmación de Mercado Pago. Te contactaremos para iniciar el proyecto.";
      resultPrimary.textContent = "Continuar por WhatsApp";
      resultPrimary.href = "https://wa.me/573028402389?text=Hola%20CRK%20Publicity%2C%20mi%20pago%20fue%20aprobado%20y%20quiero%20iniciar%20mi%20p%C3%A1gina%20web.";
      resultPrimary.target = "_blank";
      resultPrimary.rel = "noopener noreferrer";
      return true;
    }

    if (["rejected", "cancelled", "error"].includes(status)) {
      resultIcon.textContent = "×";
      resultIcon.classList.add("failed");
      resultTitle.textContent = "El pago no se completó";
      resultMessage.textContent = "No se acreditó ningún cobro. Puedes intentarlo nuevamente o pedirnos ayuda.";
      resultPrimary.textContent = "Intentar de nuevo";
      resultPrimary.href = "./";
      resultPrimary.removeAttribute("target");
      resultPrimary.removeAttribute("rel");
      return true;
    }

    if (["refunded", "charged_back"].includes(status)) {
      resultIcon.textContent = "!";
      resultIcon.classList.add("failed");
      resultTitle.textContent = status === "refunded" ? "Pago devuelto" : "Pago reversado";
      resultMessage.textContent = "Comunícate con CRK Publicity para revisar el estado de la operación.";
      return true;
    }

    resultIcon.textContent = "…";
    resultIcon.classList.add("pending");
    resultTitle.textContent = status === "pending" ? "Pago pendiente" : "Verificando el pago";
    resultMessage.textContent = "Mercado Pago aún no ha confirmado el resultado. Esta página se actualizará automáticamente.";
    return false;
  }

  async function verifyOrder(orderId) {
    showResult();
    let announced = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const data = await postFunction("payment-status", { orderId }, 10000);
        const finalStatus = renderStatus(data);
        if (!announced) {
          resultPanel.focus?.();
          announced = true;
        }
        if (finalStatus) return;
      } catch (error) {
        if (attempt === 5) {
          resultIcon.textContent = "!";
          resultIcon.className = "result-icon failed";
          resultTitle.textContent = "No pudimos verificar el pago";
          resultMessage.textContent = error instanceof Error ? error.message : "Consulta el estado por WhatsApp.";
          if (!announced) resultPanel.focus?.();
          return;
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
    }
    resultMessage.textContent = "La confirmación está tardando más de lo esperado. Puedes cerrar esta página y consultarnos por WhatsApp.";
  }

  const orderId = new URLSearchParams(window.location.search).get("order") || "";
  if (uuidPattern.test(orderId)) {
    void verifyOrder(orderId);
    return;
  }

  const fields = Array.from(form.querySelectorAll("input:not([type=checkbox]):not(#payment-website)"));
  fields.forEach((field) => field.addEventListener("blur", () => validateField(field)));
  [scopeConfirmation, privacyConfirmation].forEach((field) => {
    field.addEventListener("change", () => validateConfirmation(field));
  });
  void (async () => {
    const loaded = await loadRequestedService();
    if (!loaded) {
      formError.textContent = "Este servicio ya no está disponible para pago en línea. Escríbenos por WhatsApp para ayudarte.";
      return;
    }
    requestStorageKey = "crkPaymentRequestId:" + (activeProduct.serviceId || activeProduct.productCode);
    renderProduct(activeProduct);
    submitButton.disabled = false;
  })();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    const validFields = fields.map(validateField).every(Boolean);
    const validScope = validateConfirmation(scopeConfirmation);
    const validPrivacy = validateConfirmation(privacyConfirmation);
    if (!validFields || !validScope || !validPrivacy) {
      formError.textContent = "Revisa tus datos y confirma las condiciones y la política de privacidad.";
      const invalidField = form.querySelector("[aria-invalid=true]");
      invalidField?.focus();
      return;
    }

    const data = new FormData(form);
    let clientRequestId = savedRequestId();
    if (!uuidPattern.test(clientRequestId)) {
      clientRequestId = createRequestId();
      saveRequestId(clientRequestId);
    }
    submitButton.disabled = true;
    payButtonLabel.textContent = "Preparando pago…";

    try {
      const response = await postFunction("create-payment", {
        productCode: activeProduct.productCode,
        serviceId: activeProduct.serviceId || undefined,
        clientRequestId,
        name: data.get("name"),
        email: data.get("email"),
        phone: data.get("phone"),
        scopeAccepted: true,
        privacyAccepted: true,
        scopeVersion: acceptanceVersions.scope,
        privacyVersion: acceptanceVersions.privacy,
        website: data.get("website")
      });
      const target = checkoutUrl(response.checkoutUrl);
      if (!uuidPattern.test(String(response.orderId || "")) || !target) throw new Error("Mercado Pago devolvió una respuesta inválida.");
      window.addEventListener("pagehide", clearRequestId, { once: true });
      window.location.assign(target);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "identity_conflict") clearRequestId();
      formError.textContent = error instanceof Error ? error.message : "No pudimos iniciar el pago.";
      submitButton.disabled = false;
      payButtonLabel.textContent = "Pagar " + money.format(activeProduct.amount) + " " + activeProduct.currency;
    }
  });
})();
