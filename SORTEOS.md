# Sorteos y Premios

El módulo usa Vite en `/sorteos/`, Supabase Auth, Edge Functions y el bucket privado `raffle-private`.

## Flujo

1. El propietario, con MFA, crea y activa un sorteo desde **CRM → Participantes**.
2. La migración crea exactamente los números `00`–`99`.
3. La web reserva los números mediante una operación SQL atómica. La reserva vence según la configuración del sorteo.
4. El participante acepta la política y registra sus datos; el estado inicial siempre es `pending_validation`.
5. El propietario aprueba, rechaza o libera el registro desde el CRM. La aprobación bloquea definitivamente los números.

Nequi se utiliza únicamente como instrucciones de pago y validación manual. El sistema no afirma ni infiere pagos confirmados al abrir Nequi o WhatsApp.

## Despliegue de Supabase

Antes de publicar la ruta, aplica y revisa la migración:

```powershell
supabase db push
supabase functions deploy raffle-public --no-verify-jwt
supabase functions deploy raffle-admin
```

Configura `ALLOWED_ORIGINS` incluyendo el dominio de Cloudflare Pages y el dominio de producción. Las variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` deben estar en el entorno de compilación; no expongas nunca una clave de servicio.

## Pendiente obligatorio antes de producción

- Revisar con asesoría legal colombiana los permisos para rifas, sorteos promocionales, impuestos, edad mínima y tratamiento de datos.
- Publicar términos concretos, versión de privacidad y método verificable de selección del ganador.
- Configurar una política de retención y copias de seguridad.
- Conectar únicamente APIs oficiales o webhooks autorizados si se automatiza una confirmación de pago.
- Activar CAPTCHA/Turnstile si el volumen o riesgo de spam lo requiere.

No uses “donación” para encubrir pagos obligatorios: configura el tipo legal real de cada sorteo.
