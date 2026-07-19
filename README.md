# CRK Publicity

Sitio comercial y CRM de CRK Publicity. El frontend es una aplicación estática **Vite multi‑página** (no usa React ni Next.js) y puede publicarse gratis en Cloudflare Pages.

## Preparar y probar localmente

Requiere Node.js 20 o superior.

```powershell
npm ci
Copy-Item .env.example .env
npm run check
npm run build
npm run preview
```

El archivo `.env` solo debe contener valores públicos del navegador:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Nunca agregues claves `service_role`, tokens de Mercado Pago ni secretos de Supabase a variables `VITE_*` ni al repositorio.

## Publicar en Cloudflare Pages (Git)

1. Sube este repositorio a GitHub, GitLab o Bitbucket.
2. En Cloudflare abre **Workers & Pages → Create application → Pages → Connect to Git**.
3. Selecciona el repositorio y usa estos valores:

   - **Production branch:** `main` (o la rama principal del repositorio).
   - **Root directory:** `/`.
   - **Build command:** `npm run build`.
   - **Build output directory:** `dist`.
   - **Node.js version:** `20` (variable de entorno `NODE_VERSION=20`).

4. En **Settings → Environment variables** añade, para Production y Preview, `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con los valores públicos de tu proyecto.
5. Guarda y pulsa **Save and Deploy**. Cada push a la rama de producción generará un nuevo despliegue.

Cloudflare Pages toma automáticamente `public/_headers` durante el build. Ese archivo añade cabeceras de seguridad y caché; no se necesita `_redirects` porque el proyecto tiene entradas HTML reales para cada sección.

## Publicación directa con Wrangler (opcional)

La integración Git no requiere `wrangler.toml`. Para una subida manual, instala o ejecuta Wrangler sin añadirlo al proyecto:

```powershell
npm ci
npm run build
npx wrangler login
npx wrangler pages deploy dist --project-name crkpublicity
```

## Rutas generadas

Después de `npm run build`, la carpeta que debes publicar es `dist/` y contiene:

- `/` — sitio público.
- `/admin/` — panel privado.
- `/pago/` — checkout.
- `/privacidad/` — política de privacidad.

El backend, autenticación, CRM y funciones de pago continúan en Supabase; Cloudflare Pages aloja únicamente estos archivos estáticos. Ejecuta `npm run audit:security` antes de un despliegue cuando necesites una comprobación completa.

## Comandos exactos

- Build de producción: `npm run build`
- Carpeta a subir: `dist`
- Pruebas: `npm run check`
- Auditoría: `npm run audit:security`

## Organización

Repositorio de desarrollo web de CRK Publicity.
