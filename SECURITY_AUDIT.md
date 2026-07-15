# Auditoría técnica de seguridad, integridad y carga

Fecha: 2026-07-15  
Alcance: web pública, panel CRM, funciones Supabase, migraciones SQL, dependencias y build de producción.

## Resultado

- Dependencias: 0 vulnerabilidades conocidas mediante `npm audit`.
- Pruebas automatizadas: 18 controles de seguridad, integridad, accesibilidad y rendimiento.
- Build: producción compilada correctamente con Vite.
- Secretos: los archivos `.env` no están versionados; el frontend solo recibe la clave pública de Supabase.
- Inyección DOM: no se utilizan `innerHTML`, `eval` ni construcción dinámica de scripts.

## Hallazgos corregidos

1. Verificación MFA: el envío de WhatsApp ahora consulta el nivel de garantía al cliente autenticado de Supabase, en lugar de leer el nivel desde un JWT decodificado localmente.
2. Integridad del formulario: contacto, conversación, mensaje y actividad se guardan en una sola transacción SQL. Un fallo revierte toda la operación.
3. Concurrencia: solicitudes simultáneas del mismo contacto se serializan mediante bloqueo transaccional.
4. Privilegios: la función de ingesta revoca acceso a `public`, `anon` y `authenticated`; solo `service_role` puede ejecutarla.
5. CORS y respuestas API: origen permitido exacto y cabeceras JSON defensivas con denegación por defecto.
6. CSP y servidor: `base-uri 'none'`, `frame-ancestors 'none'`, medios del mismo origen, actualización de solicitudes inseguras, HSTS y caché inmutable para MP4.
7. Carga: analítica de visita diferida, video pausado fuera de pantalla o con ahorro de datos, sliders inicializados cerca del viewport y contenido inferior con `content-visibility`.
8. CSS: eliminados selectores y animaciones de diseños anteriores sin referencias activas.
9. Accesibilidad: el panel de cotización cerrado queda `inert`, invisible y fuera del recorrido de teclado.

## Métricas comparativas

| Recurso | Antes | Después | Cambio |
|---|---:|---:|---:|
| CSS principal, sin comprimir | 66,30 KB | 54,74 KB | -17,4 % |
| CSS principal, gzip | 12,13 KB | 11,12 KB | -8,3 % |
| JS público, gzip | 2,67 KB | 3,07 KB | +0,40 KB por controles de carga |
| CSS + JS público, gzip | 14,80 KB | 14,19 KB | -4,1 % |

## Riesgos residuales

- GitHub Pages no permite configurar todas las cabeceras HTTP. La meta CSP protege gran parte del frontend, pero `frame-ancestors` requiere cabecera; el paquete para cPanel sí la incluye.
- Enviar un mensaje a Meta y registrarlo en la base de datos no puede ser una única transacción. Para tolerancia total a reintentos se recomienda un patrón outbox con identificador idempotente.
- `noindex` y `robots.txt` no protegen el panel: la protección real sigue siendo Supabase Auth, MFA y RLS.
- Esta revisión no sustituye una prueba de penetración ni acredita conformidad ISO 27001.

## Repetición de auditoría

```powershell
npm.cmd run audit:security
```

Referencias: OWASP Top 10:2025 y OWASP Content Security Policy Cheat Sheet.
