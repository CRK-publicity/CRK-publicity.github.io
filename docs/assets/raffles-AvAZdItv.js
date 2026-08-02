import"./modulepreload-polyfill-Dezn_h7o.js";var e=`https://wiyhambpgiqbnzwrsykd.supabase.co`,t=`sb_publishable_jVr9XEN9yDC5CybLMBpc9Q_ShOtw0wz`,n=document.querySelector(`#raffles`),r=document.querySelector(`#raffle-detail`),i=document.querySelector(`#raffle-dialog`),a=document.querySelector(`#participation-dialog`),o=document.querySelector(`#participation-content`),s=`crk-raffle-contact-v1`,c=1e4,l=[],u=[],d=null,f=null,p=!1,m=new Intl.NumberFormat(`es-CO`,{style:`currency`,currency:`COP`,maximumFractionDigits:0}),h=e=>String(e||``),g=e=>h(e).replace(/[&<>'"]/g,e=>({"&":`&amp;`,"<":`&lt;`,">":`&gt;`,"'":`&#39;`,'"':`&quot;`})[e]);async function _(n,r){let i=await fetch(`${e}/functions/v1/raffle-public`,{method:n,headers:{apikey:t,"content-type":`application/json`},body:r?JSON.stringify(r):void 0}),a=await i.json().catch(()=>({}));if(!i.ok)throw Error(a.error||`No fue posible completar la solicitud`);return a}async function v(n,r){if(!(r instanceof File)||!r.size)return null;let i=new FormData;i.set(`reservationId`,f.id),i.set(`reservationCode`,f.code),i.set(`kind`,n),i.set(`file`,r);let a=await fetch(`${e}/functions/v1/raffle-file-upload`,{method:`POST`,headers:{apikey:t},body:i}),o=await a.json().catch(()=>({}));if(!a.ok)throw Error(o.error||`No fue posible cargar el archivo`);return o}function y(e){return{upcoming:`Próximamente`,active:`Activo`,sold_out:`Agotado`,finished:`Finalizado`}[e]||e}function b(e){return{available:`Disponible`,reserved:`Reservado temporalmente`,pending_validation:`Pago por validar`,paid:`Ocupado`,blocked:`No disponible`,winner:`Ganador`}[e]||`No disponible`}function x(e,t){return String(e).padStart(Math.max(2,String(Math.max(0,Number(t||100)-1)).length),`0`)}function S(){try{let e=JSON.parse(sessionStorage.getItem(s)||`{}`);return{fullName:h(e.fullName).slice(0,140),phone:h(e.phone).slice(0,32),email:h(e.email).slice(0,254),city:h(e.city).slice(0,100)}}catch{return{fullName:``,phone:``,email:``,city:``}}}function C(e){if(!(e instanceof HTMLFormElement))return;let t=new FormData(e),n={fullName:h(t.get(`fullName`)).trim().slice(0,140),phone:h(t.get(`phone`)).trim().slice(0,32),email:h(t.get(`email`)).trim().slice(0,254),city:h(t.get(`city`)).trim().slice(0,100)};sessionStorage.setItem(s,JSON.stringify(n))}function w(e){let t=document.createElement(`article`);if(t.className=`raffle-card`,e.prizeImageUrl){let n=document.createElement(`img`);n.src=e.prizeImageUrl,n.alt=e.prizeName,n.width=640,n.height=520,t.append(n)}let n=document.createElement(`div`);n.innerHTML=`<span class="status">${g(y(e.status))}</span>
    <h2>${g(e.title)}</h2>
    <p>${g(e.description)}</p>
    <div class="stats">
      <span><b>${m.format(e.priceCop)}</b>por número</span>
      <span><b>${e.availableCount}</b>disponibles</span>
      <span><b>${e.participantCount}</b>números registrados</span>
    </div>`;let r=document.createElement(`button`);return r.className=`primary`,r.textContent=`Elegir número`,r.onclick=()=>k(e),n.append(r),t.append(n),t}function T(){n.replaceChildren(...l.map(w)),l.length||n.append(document.querySelector(`#empty-template`).content.cloneNode(!0))}function E(){let e=document.createElement(`div`);e.className=`number-legend`;for(let[t,n]of[[`available`,`Disponible`],[`reserved`,`Reservado`],[`pending_validation`,`Por validar`],[`paid`,`Ocupado`],[`blocked`,`No disponible`]]){let r=document.createElement(`span`);r.className=`legend-item ${t}`,r.textContent=n,e.append(r)}return e}function D(e,t=!0){d=e;let n=new Set(e.numbers.filter(e=>e.state===`available`).map(e=>e.number));u=u.filter(e=>n.has(e));let a=S();r.replaceChildren();let o=document.createElement(`h2`);o.textContent=e.title;let s=document.createElement(`p`);s.className=`notice`,s.textContent=`Elige hasta ${e.maxNumbersPerParticipant} números. Los ocupados se actualizan automáticamente.`;let c=E(),l=document.createElement(`div`);l.className=`number-grid`,l.setAttribute(`aria-label`,`Números del sorteo ${e.title}`);for(let t of e.numbers){let n=document.createElement(`button`),i=x(t.number,e.numberCount);n.type=`button`,n.className=`number ${t.state}`,n.textContent=i,n.dataset.number=String(t.number),n.disabled=t.state!==`available`,n.title=`${i}: ${b(t.state)}`,n.setAttribute(`aria-label`,`Número ${i}, ${b(t.state)}`),n.onclick=()=>{u.includes(t.number)?u=u.filter(e=>e!==t.number):u.length<e.maxNumbersPerParticipant&&u.push(t.number),A(),u.length===1&&r.querySelector(`[name='fullName']`)?.focus()},l.append(n)}let f=document.createElement(`p`);f.id=`selection-total`,f.className=`selection-total`;let p=document.createElement(`form`);p.id=`raffle-contact-form`,p.className=`raffle-contact-card`,p.innerHTML=`<div class="contact-heading">
      <div><span>PASO 2</span><h3>Datos del participante</h3></div>
      <small>Se conservan únicamente durante esta sesión.</small>
    </div>
    <div class="form-grid">
      <label>Nombre completo
        <input name="fullName" maxlength="140" autocomplete="name" value="${g(a.fullName)}" required>
      </label>
      <label>Teléfono
        <input name="phone" type="tel" inputmode="tel" maxlength="32" autocomplete="tel" value="${g(a.phone)}" required>
      </label>
    </div>
    <div class="form-grid optional-contact">
      <label>Correo (opcional)
        <input name="email" type="email" maxlength="254" autocomplete="email" value="${g(a.email)}">
      </label>
      <label>Ciudad (opcional)
        <input name="city" maxlength="100" autocomplete="address-level2" value="${g(a.city)}">
      </label>
    </div>
    <label class="check">
      <input name="consentPreview" type="checkbox" required>
      <span>Acepto el tratamiento de mis datos para gestionar esta participación. <a href="../privacidad/" target="_blank" rel="noopener">Ver política</a>.</span>
    </label>
    <button class="primary reserve-button" type="submit">Reservar y continuar</button>
    <p class="error" id="reserve-error" role="alert"></p>`,p.addEventListener(`input`,()=>C(p)),p.addEventListener(`submit`,j),r.append(o,s,c,l,f,p),A(),t&&!i.open&&i.showModal()}function O(e){d=e;let t=new Map(e.numbers.map(e=>[Number(e.number),e.state])),n=[`available`,`reserved`,`pending_validation`,`paid`,`blocked`,`winner`];u=u.filter(e=>t.get(e)===`available`),r.querySelectorAll(`.number`).forEach(r=>{let i=Number(r.dataset.number),a=t.get(i)||`blocked`;r.classList.remove(...n),r.classList.add(a),r.disabled=a!==`available`;let o=x(i,e.numberCount);r.title=`${o}: ${b(a)}`,r.setAttribute(`aria-label`,`Número ${o}, ${b(a)}`)}),A()}function k(e){u=[],f=null,D(e,!0)}function A(){if(!d)return;r.querySelectorAll(`.number`).forEach(e=>{let t=u.includes(Number(e.dataset.number));e.classList.toggle(`selected`,t),e.setAttribute(`aria-pressed`,String(t))});let e=r.querySelector(`#selection-total`);e&&(e.textContent=u.length?`${u.map(e=>x(e,d.numberCount)).join(`, `)} · ${m.format(u.length*d.priceCop)}`:`Paso 1: selecciona uno o más números disponibles.`);let t=r.querySelector(`.reserve-button`);t&&(t.disabled=!u.length)}async function j(e){e.preventDefault();let t=e.currentTarget,n=t.querySelector(`#reserve-error`);if(n.textContent=``,!u.length||!t.reportValidity())return;C(t);let r=t.querySelector(`button[type='submit']`);r.disabled=!0,r.textContent=`Reservando…`;try{f=(await _(`POST`,{action:`reserve`,raffleId:d.id,numbers:u,website:``})).reservation,i.close(),M()}catch(e){n.textContent=e.message,await P({preserveOpenRaffle:!0})}finally{r.disabled=!u.length,r.textContent=`Reservar y continuar`}}function M(){let e=S();o.innerHTML=`<h2>Completa tu participación</h2>
    <p class="notice">Números <b>${u.map(e=>x(e,d.numberCount)).join(`, `)}</b> reservados hasta ${new Date(f.expiresAt).toLocaleTimeString(`es-CO`,{hour:`2-digit`,minute:`2-digit`})}. Total: <b>${m.format(u.length*d.priceCop)}</b>.</p>
    <form id="participant-form" class="form-stack">
      <div class="form-grid">
        <label>Nombre completo<input name="fullName" maxlength="140" autocomplete="name" value="${g(e.fullName)}" required></label>
        <label>Teléfono<input name="phone" type="tel" inputmode="tel" maxlength="32" autocomplete="tel" value="${g(e.phone)}" required></label>
      </div>
      <div class="form-grid">
        <label>Correo (opcional)<input name="email" type="email" maxlength="254" autocomplete="email" value="${g(e.email)}"></label>
        <label>Ciudad (opcional)<input name="city" maxlength="100" autocomplete="address-level2" value="${g(e.city)}"></label>
      </div>
      <div class="form-grid">
        <label>Foto del participante (opcional)<input name="participantPhoto" type="file" accept="image/jpeg,image/png,image/webp"></label>
        <label>Comprobante de pago<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp" required></label>
      </div>
      <label>Referencia de pago (opcional)<input name="paymentReference" maxlength="120"></label>
      <div class="form-grid">
        <label>Valor reportado<input name="reportedAmount" type="number" min="0" step="1" value="${u.length*d.priceCop}"></label>
        <label>Fecha del pago<input name="paidAt" type="date"></label>
      </div>
      <label>Observaciones (opcional)<textarea name="observations" maxlength="1000"></textarea></label>
      <label class="check"><input name="consent" type="checkbox" required><span>${g(d.privacyText)} <a href="../privacidad/" target="_blank" rel="noopener">Ver política</a>.</span></label>
      <label class="check"><input name="marketingConsent" type="checkbox"><span>Acepto recibir comunicaciones comerciales y mensajes por WhatsApp.</span></label>
      <p class="notice">Pago por Nequi: <b>${g(d.nequiNumber||`se indicará al confirmar`)}</b><br>${g(d.paymentInstructions||`Conserva el comprobante para la validación manual.`)}</p>
      <button class="primary">Registrar participación</button>
      <p class="error" id="form-error" role="alert"></p>
    </form>`;let t=o.querySelector(`#participant-form`);t.addEventListener(`input`,()=>C(t)),t.addEventListener(`submit`,N),a.showModal()}async function N(e){e.preventDefault();let t=e.currentTarget;C(t);let n=new FormData(t),r=o.querySelector(`#form-error`),i=t.querySelector(`button[type='submit'], button:not([type])`);i.disabled=!0,i.textContent=`Registrando…`;try{let e=await v(`payment_receipt`,n.get(`receipt`)),t=await v(`participant_photo`,n.get(`participantPhoto`)),r={action:`submit`,reservationId:f.id,reservationCode:f.code,fullName:n.get(`fullName`),phone:n.get(`phone`),email:n.get(`email`),city:n.get(`city`),paymentReference:n.get(`paymentReference`),reportedAmount:n.get(`reportedAmount`),paidAt:n.get(`paidAt`),observations:n.get(`observations`),receipt:e,participantPhoto:t,consent:n.get(`consent`)===`on`,marketingConsent:n.get(`marketingConsent`)===`on`,website:``};await _(`POST`,r),o.innerHTML=`<h2>Registro recibido</h2>
      <p class="notice">Tu participación queda pendiente de validación. Los números <b>${u.map(e=>x(e,d.numberCount)).join(`, `)}</b> ya aparecen ocupados. Conserva el código <b>${g(f.code)}</b>.</p>
      <div class="payment-step">
        <h3>Pago por Nequi</h3>
        <p>Envía ${m.format(u.length*d.priceCop)} a ${g(d.nequiNumber||`el número indicado por CRK`)}.</p>
        <div class="copy-row"><code>${g(d.nequiNumber||``)}</code><button type="button" data-copy="${g(d.nequiNumber||``)}">Copiar</button></div>
        <a class="primary" href="https://wa.me/573028402389?text=${encodeURIComponent(`Sorteo ${d.title}. Participante: ${r.fullName}. Números: ${u.map(e=>x(e,d.numberCount)).join(`, `)}. Valor: ${m.format(u.length*d.priceCop)}. Reserva: ${f.code}`)}" target="_blank" rel="noopener">Enviar mensaje</a>
      </div>`,o.querySelector(`[data-copy]`)?.addEventListener(`click`,async e=>{await navigator.clipboard.writeText(e.currentTarget.dataset.copy||``),e.currentTarget.textContent=`Copiado`}),await P()}catch(e){r.textContent=e.message,i.disabled=!1,i.textContent=`Registrar participación`}}async function P({preserveOpenRaffle:e=!1}={}){if(!p){p=!0;try{if(l=(await _(`GET`)).raffles||[],T(),e&&i.open&&d){let e=l.find(e=>e.id===d.id);e&&O(e)}}catch(t){e||(n.innerHTML=`<p class="empty">${g(t.message)}</p>`)}finally{p=!1}}}window.setInterval(()=>{document.hidden||P({preserveOpenRaffle:!0})},c),document.addEventListener(`visibilitychange`,()=>{document.hidden||P({preserveOpenRaffle:!0})}),P();