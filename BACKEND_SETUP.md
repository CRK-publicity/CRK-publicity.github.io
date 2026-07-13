# Activación del CRM y bot de WhatsApp

La web ya contiene el formulario conectado, el panel privado y las funciones del bot. Para activarlos en producción necesitas un proyecto de Supabase y una aplicación de Meta WhatsApp Business.

## 1. Crear el backend en Supabase

1. Crea un proyecto en Supabase y conserva su región, URL y clave pública.
2. Instala Supabase CLI e inicia sesión.
3. Desde la raíz del repositorio enlaza el proyecto y aplica la migración:

```powershell
supabase login
supabase link --project-ref TU_PROJECT_REF
supabase db push
```

4. En Authentication desactiva el registro público. Crea manualmente la cuenta de Iván y, después de su primer acceso, conviértela en propietaria desde SQL Editor:

```sql
insert into public.profiles (user_id, full_name, role)
select id, coalesce(raw_user_meta_data ->> 'full_name', split_part(email, '@', 1)), 'owner'
from auth.users where email = 'TU_CORREO_ADMIN'
on conflict (user_id) do update set role = 'owner';
```

Las cuentas nuevas quedan en estado `pending` y no pueden leer clientes hasta que un propietario las cambie a `agent`.

## 2. Configurar la web

Copia `.env.example` como `.env` y reemplaza los dos valores. La clave usada aquí debe ser la clave pública/publishable, nunca la `service_role`.

```powershell
npm install
npm run build
```

El panel quedará en `/crkpublicity/admin/`. Los datos siguen protegidos aunque alguien descubra la dirección, porque todas las tablas usan Row Level Security.

## 3. Preparar WhatsApp Business

En Meta for Developers:

1. Crea o selecciona un portafolio empresarial, una aplicación y una cuenta de WhatsApp Business.
2. Vincula el número que atenderá clientes.
3. Para producción crea un usuario del sistema y un token con permisos `whatsapp_business_management` y `whatsapp_business_messaging`.
4. Conserva el identificador del número, el App Secret y la versión vigente de Graph API.

No pegues estos valores en el sitio, GitHub ni este chat. Guárdalos como secretos de Supabase:

```powershell
supabase secrets set META_VERIFY_TOKEN="VALOR_LARGO_ALEATORIO"
supabase secrets set META_APP_SECRET="APP_SECRET_DE_META"
supabase secrets set META_ACCESS_TOKEN="TOKEN_DE_USUARIO_DEL_SISTEMA"
supabase secrets set META_PHONE_NUMBER_ID="ID_DEL_NUMERO"
supabase secrets set META_GRAPH_VERSION="vXX.X"
supabase secrets set ALLOWED_ORIGINS="https://iwandezu.github.io,http://localhost:5173"
supabase secrets set IP_HASH_SALT="VALOR_ALEATORIO_DE_32_O_MAS_CARACTERES"
```

## 4. Publicar las funciones

```powershell
supabase functions deploy public-lead
supabase functions deploy whatsapp-webhook
supabase functions deploy send-whatsapp
```

Configura en Meta esta URL de callback:

```text
https://TU_PROJECT_REF.supabase.co/functions/v1/whatsapp-webhook
```

Usa el mismo valor de `META_VERIFY_TOKEN` para la verificación. Suscribe el campo `messages` y suscribe la aplicación a la cuenta de WhatsApp Business.

## 5. Prueba obligatoria antes de anunciarlo

- Envía el formulario dos veces con el mismo teléfono: debe actualizar el contacto, no duplicarlo.
- Escribe al WhatsApp: debe aparecer el menú y registrarse la conversación.
- Responde `5`: el bot debe marcar “Espera asesor” y dejar de responder automáticamente.
- Entra al panel, cambia la etapa y responde manualmente.
- Confirma en Meta los estados enviado, entregado, leído o fallido.
- Comprueba que un usuario `pending` no pueda ver clientes.

## Seguridad y operación

- Activa MFA para las cuentas de Supabase y Meta.
- Rota tokens inmediatamente si se filtran.
- Da acceso solo a personas que atienden clientes.
- Define cuánto tiempo conservarás mensajes y elimina datos cuando ya no sean necesarios.
- No almacenes datos sensibles de pago en este CRM.
- Revisa semanalmente mensajes fallidos, contactos duplicados y usuarios autorizados.

Documentación oficial: [Supabase Edge Functions](https://supabase.com/docs/guides/functions), [seguridad y RLS](https://supabase.com/docs/guides/database/secure-data) y [WhatsApp Business Platform de Meta](https://www.postman.com/meta/whatsapp-business-platform/overview).