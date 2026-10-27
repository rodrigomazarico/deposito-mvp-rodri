# Depósito MVP

Aplicación web local de dos vistas para:

- **Depósito:** crear pedidos, guardar el WhatsApp del proveedor, abrir el pedido preformateado en una pestaña nueva, registrar compras rápidas sin pedido previo, adjuntar una foto/PDF de factura, extraer datos con OCR vía OpenRouter y confirmar la recepción.
- **Administración:** ver entregas, previsualizar imágenes/PDF de facturas y estado financiero; marcar contado o registrar pagos parciales/totales en cuenta corriente.

## Ejecutar

Requiere Node.js 18+:

```bash
cd deposito-mvp
$env:OPENROUTER_API_KEY = "sk-or-v1-..." # PowerShell
npm start
```

En macOS/Linux se puede usar `OPENROUTER_API_KEY="sk-or-v1-..." npm start`.
Abrí `http://127.0.0.1:4173`.

También se puede abrir `index.html` directamente, aunque servirlo por HTTP es más compatible con proveedores OCR y navegadores.

## OpenRouter

En producción, el OCR usa la función serverless `/api/ocr`, que lee `process.env.OPENROUTER_API_KEY` en el servidor. La clave nunca se incluye en el código público ni se envía al navegador. La configuración por defecto es:

- Base URL del servidor: `https://openrouter.ai/api/v1`
- Modelo: `google/gemma-3-4b-it`

Para desarrollo local también podés ingresar una clave en el formulario, solo para esa sesión. Si no hay clave de formulario ni variable de entorno, el botón **Completar factura manualmente** permite continuar sin OCR.

## Memoria de proveedores

La memoria no entrena ni modifica el modelo remoto: es recuperación local de contexto. Cada factura confirmada actualiza el registro correspondiente dentro de `Proveedores` con datos fiscales revisados por el usuario y una plantilla de lectura (`invoiceTemplate`) con campos esperados, columnas de ítems, etiquetas observadas y formato habitual del número de factura. En la siguiente carga del mismo proveedor, esa referencia se muestra como sugerencia y se agrega al prompt de OpenRouter como pista, siempre priorizando la factura actual.

La plantilla se actualiza únicamente al confirmar la recepción, no al subir un archivo ni ante una respuesta OCR fallida.

## WhatsApp de proveedores

Cada proveedor conserva su teléfono en `Proveedores.phone`. Al guardar un pedido se valida que incluya código de país y se genera un enlace `https://wa.me/<numero>?text=...` con el proveedor, cantidades e ítems. El enlace se abre en una pestaña nueva; si el navegador bloquea la ventana, queda disponible como enlace alternativo en el mensaje de confirmación.

## Compras rápidas

**Compra rápida / factura directa** permite cargar una factura sin crear un pedido previo. La compra se guarda en `Pedidos` con `source: "direct"` y estado `Recibido`, y su factura queda en `Facturas_Y_Pagos` con pago pendiente o contado. Administración la ve en la misma tabla, con previsualización y gestión de pagos igual que una recepción normal.

## Administración avanzada

En Administración se puede filtrar por proveedor o hacer clic en su nombre para abrir una ficha con pedidos, facturas, comprobantes y resumen de facturado, pagado y deuda. Las facturas con saldo pendiente durante 7 días o más muestran una alerta visual. El buscador también revisa las descripciones de productos de pedidos y facturas para consultar el historial.

## Despliegue gratuito con GitHub y Vercel

El proyecto incluye `vercel.json`, `api/ocr.mjs`, `.gitignore` y `.env.example`. En GitHub subí únicamente el contenido de esta carpeta; nunca agregues `.env` ni una clave real.

### Comandos Git

Reemplazá `TU_USUARIO` por tu usuario de GitHub y creá previamente un repositorio vacío llamado `deposito-mvp`:

```bash
cd deposito-mvp
git init
git add .
git commit -m "chore: preparar despliegue en Vercel"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/deposito-mvp.git
git push -u origin main
```

### Vercel en 3 pasos

1. En Vercel elegí **Add New → Project**, importá el repositorio y seleccioná `deposito-mvp` como Root Directory si el repositorio contiene una carpeta superior.
2. En **Settings → Environment Variables**, agregá `OPENROUTER_API_KEY` con la clave real para `Production`, `Preview` y `Development`. Opcionalmente agregá `OPENROUTER_BASE_URL`.
3. Presioná **Deploy**. Los próximos `git push` generarán despliegues automáticos.

La app queda estática en el navegador y el único acceso a OpenRouter pasa por `/api/ocr`, donde la variable de entorno permanece del lado servidor.

## Persistencia y estructura

El MVP no agrega backend ni dependencias externas. Usa `localStorage` con exactamente tres colecciones:

1. `Proveedores`
2. `Pedidos`
3. `Facturas_Y_Pagos`

Los pagos están embebidos dentro de cada factura (`payments[]`), por lo que no existe una cuarta colección. **Exportar datos** descarga esas tres colecciones en JSON.

Los datos quedan en el navegador actual; para una operación multiusuario se necesitaría reemplazar el adaptador de `localStorage` por una API con autenticación y base de datos.
