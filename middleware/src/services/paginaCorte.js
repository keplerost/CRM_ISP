/**
 * La página que ve el abonado cortado.
 *
 * ── Qué tiene que contestar, en este orden ──
 *
 *   1. Por qué no tengo internet. Sin esto el abonado cree que se rompió algo y
 *      llama a soporte, que es la llamada que esta página viene a evitar.
 *   2. Cuánto debo.
 *   3. Dónde deposito.
 *   4. A quién le aviso que pagué.
 *
 * El orden importa: alguien que abre el navegador y encuentra esto está
 * molesto, y va a leer las dos primeras líneas. Si el monto está abajo de todo,
 * no lo lee.
 *
 * ── Lo que esta página NO hace ──
 *
 * Cobrar. Se evaluó un botón de pago y se descartó por ahora: cobrar en línea
 * exige la pasarela, conciliación automática y manejar el pago a medias. Sin eso
 * resuelto, un botón que a veces funciona es peor que un número de cuenta que
 * siempre funciona.
 *
 * ── La limitación que hay que decir en voz alta ──
 *
 * Un portal cautivo solo puede interceptar HTTP. Si el abonado abre una página
 * HTTPS —que hoy son casi todas— el navegador va a mostrar un error de conexión,
 * no esta página. Lo que sí funciona: los teléfonos y las computadoras prueban
 * una URL HTTP de control al conectarse a una red, y esa prueba es la que hace
 * saltar el aviso solo. Por eso también conviene que el abonado tenga el número
 * de WhatsApp por otro lado.
 */

import { aplicarPlantilla } from './mensajeria.js'

const dinero = (n) => `$${Number(n ?? 0).toFixed(2)}`

/** Escapa lo que va adentro del HTML. Los nombres traen comillas y ampersands. */
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/**
 * La identificación con la que se hace un depósito.
 *
 * ── Por qué no se muestra el RUC tal cual ──
 *
 * En Ecuador el RUC de una persona natural es su cédula más "001". La cuenta
 * bancaria, en cambio, está a nombre de la persona y el cajero pide la CÉDULA.
 * Mostrar el RUC de trece dígitos hace que el depositante escriba un número que
 * no empareja con el titular de la cuenta, y el depósito se rechaza en la
 * ventanilla.
 *
 * Un RUC de sociedad —que no termina en 001— se muestra entero, porque ahí la
 * cuenta sí está a nombre de la empresa.
 */
export function identificacionParaDeposito(ruc) {
  const limpio = String(ruc ?? '').replace(/\D/g, '')
  if (!limpio) return null
  if (limpio.length === 13 && limpio.endsWith('001')) return limpio.slice(0, 10)
  return limpio
}

/** El número, listo para un enlace de WhatsApp del Ecuador. */
export function aWhatsapp(numero) {
  const limpio = String(numero ?? '').replace(/\D/g, '')
  if (!limpio) return null
  // 0981864229 → 593981864229. Si ya viene con código de país, se respeta.
  if (limpio.startsWith('593')) return limpio
  if (limpio.startsWith('0')) return `593${limpio.slice(1)}`
  return limpio
}

/**
 * Qué mostrarle a este abonado.
 *
 * Separado del HTML para poder probarlo: lo que importa acá es QUÉ se dice, y
 * eso no debería exigir leer etiquetas para verificarlo.
 */
export function armar({ abonado, config = {}, cuentas = [], empresa = {} } = {}) {
  const enMora = Number(abonado?.saldo ?? 0) > 0

  /**
   * Aviso previo o corte: son dos páginas distintas y el abonado está en dos
   * situaciones distintas.
   *
   * El del aviso TODAVÍA TIENE SERVICIO. Decirle "tu servicio está suspendido"
   * sería mentirle, y la mentira se nota enseguida —está leyendo la página con
   * su propia conexión—. Lo que necesita es saber que le falta poco y dónde
   * pagar.
   */
  const previo = abonado?.en_aviso_previo === true && abonado?.estado !== 'cortado'

  /**
   * Los marcadores del texto, reemplazados con los datos de este abonado.
   *
   * El título y el mensaje salen del editor de plantillas, así que pueden traer
   * `{{nombre}}` o `{{saldo}}`. Sin esto, el abonado leería esas llaves tal
   * cual — y ese es exactamente el error que nadie ve al escribir la plantilla,
   * porque en la vista previa se reemplazan.
   */
  const conDatos = (texto) =>
    aplicarPlantilla(texto, {
      nombre: abonado?.nombre ?? '',
      primer_nombre: String(abonado?.nombre ?? '').split(' ')[0],
      codigo: abonado?.codigo ?? '',
      plan: abonado?.plan ?? '',
      saldo: `$${Number(abonado?.saldo ?? 0).toFixed(2)}`,
      empresa: empresa.nombre_comercial || empresa.razon_social || '',
      telefono: config.telefono_pagos || empresa.telefono || '',
    })

  /**
   * Por qué se le cortó.
   *
   * Se distingue el corte por mora del resto porque son dos conversaciones
   * distintas: al que debe se le pide que pague, y al que no debe NO se le puede
   * pedir plata — su corte es otra cosa y hay que hablar con él.
   */
  const motivo = previo
    ? 'aviso'
    : !enMora && abonado?.estado !== 'activo'
      ? 'suspendido'
      : enMora
        ? 'mora'
        : 'desconocido'

  return {
    encontrado: !!abonado,
    motivo,
    titulo: conDatos(
      previo
        ? (config.titulo_aviso ?? 'Tu factura está por vencer')
        : (config.titulo ?? 'Tu servicio está suspendido'),
    ),
    mensaje:
      previo
        ? conDatos(config.mensaje_aviso ?? 'Tenés una factura por vencer. Podés pagarla en las cuentas de abajo para no quedarte sin servicio.')
        : motivo === 'mora'
          ? conDatos(config.mensaje ?? '')
          : // Sin deuda, pedirle que pague sería mandarlo a depositar de más.
            'Tu servicio está suspendido, pero no tenemos una deuda registrada a tu nombre. Comunicate con nosotros para resolverlo.',

    abonado: abonado
      ? {
          nombre: abonado.nombre,
          codigo: abonado.codigo,
          plan: abonado.plan,
          desde: abonado.estado_desde,
        }
      : null,

    // El monto solo si hay deuda y si el ISP eligió publicarlo.
    saldo: (enMora || previo) && config.mostrar_saldo !== false ? Number(abonado.saldo) : null,
    facturas:
      enMora && config.mostrar_facturas !== false ? Number(abonado.facturas_pendientes ?? 0) : null,

    /**
     * Las cuentas publicadas.
     *
     * Nunca las de efectivo: "depositá en Caja Oficina" no significa nada para
     * alguien sentado en su casa.
     *
     * El titular y su identificación CAEN a los datos de la empresa cuando la
     * cuenta no los trae. Es lo que hace que un ISP nuevo solo tenga que cargar
     * sus cuentas: el nombre y la cédula del titular ya están en su ficha
     * fiscal, y pedirle que los repita cuenta por cuenta es pedirle que se
     * equivoque en una de ellas.
     */
    cuentas: cuentas
      .filter((c) => c.activa && c.mostrar_en_corte && c.tipo !== 'efectivo')
      .map((c) => ({
        banco: c.banco || c.nombre,
        tipo: c.tipo === 'banco' ? 'Cuenta' : 'Billetera',
        numero: c.numero,
        titular: c.titular || empresa.razon_social || null,
        identificacion: c.identificacion || identificacionParaDeposito(empresa.ruc),
      })),

    // El número al que se manda el comprobante. Si no se cargó uno propio, el de
    // la empresa: es mejor que un abonado que pagó escriba al número de ventas a
    // que no tenga a dónde escribir.
    whatsapp: aWhatsapp(config.whatsapp_pagos || empresa.telefono),
    whatsapp_visible: config.whatsapp_pagos || empresa.telefono || null,
    telefono: config.telefono_pagos ?? empresa.telefono ?? null,
    despues_de_pagar: config.aviso_despues_de_pagar ?? null,

    empresa: {
      nombre: empresa.nombre_comercial || empresa.razon_social || 'Tu proveedor de internet',
      logo: empresa.logo_b64 ?? null,
    },
  }
}

/**
 * El HTML.
 *
 * ── Por qué va todo en un archivo, sin CSS ni imágenes aparte ──
 *
 * Porque el que la mira está CORTADO: su navegador no puede bajar nada. Un
 * `<link>` a una hoja de estilos o una fuente de Google se quedaría cargando y
 * la página se vería rota justo cuando tiene que verse clara. Todo va embebido,
 * incluido el logo, que llega en base64 desde la configuración.
 */
export function html(datos) {
  const { abonado, cuentas, saldo } = datos

  const bloqueSaldo =
    saldo != null
      ? `<div class="monto${datos.motivo === 'aviso' ? ' aviso' : ''}">
           <span class="etiqueta">${datos.motivo === 'aviso' ? 'Tenés por pagar' : 'Tenés pendiente'}</span>
           <strong>${dinero(saldo)}</strong>
           ${datos.facturas ? `<span class="detalle">${datos.facturas} ${datos.facturas === 1 ? 'factura' : 'facturas'} sin pagar</span>` : ''}
         </div>`
      : ''

  const bloqueCuentas = cuentas.length
    ? `<section>
         <h2>Dónde depositar</h2>
         ${cuentas
           .map(
             (c) => `
           <div class="cuenta">
             <p class="banco">${esc(c.banco)}</p>
             <p class="numero" onclick="copiar('${esc(c.numero)}')" title="Tocá para copiar">${esc(c.numero)}</p>
             <p class="dato">${esc(c.tipo)}${c.titular ? ` · ${esc(c.titular)}` : ''}</p>
             ${c.identificacion ? `<p class="dato">C.I./RUC ${esc(c.identificacion)}</p>` : ''}
           </div>`,
           )
           .join('')}
       </section>`
    : ''

  const bloqueAviso = datos.whatsapp
    ? `<section>
         <h2>Ya pagué, ¿ahora qué?</h2>
         <p class="parrafo">${esc(datos.despues_de_pagar ?? '')}</p>
         <a class="boton" href="https://wa.me/${datos.whatsapp}?text=${encodeURIComponent(
           `Hola, soy ${abonado?.nombre ?? ''}${abonado?.codigo ? ` (código ${abonado.codigo})` : ''}. Acabo de pagar mi servicio.`,
         )}">Enviar comprobante por WhatsApp</a>
         <p class="dato">o escribinos al ${esc(datos.whatsapp_visible ?? datos.telefono ?? '')}</p>
       </section>`
    : datos.telefono
      ? `<section><h2>Ya pagué, ¿ahora qué?</h2>
           <p class="parrafo">${esc(datos.despues_de_pagar ?? '')}</p>
           <p class="dato">Llamanos al ${esc(datos.telefono)}</p>
         </section>`
      : ''

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(datos.titulo)}</title>
<style>
  /* Todo embebido: el que mira esta página está cortado y su navegador no
     puede bajar una hoja de estilos ni una fuente de ningún lado. */
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       background:#0f172a;color:#e2e8f0;line-height:1.5;padding:20px;
       display:flex;justify-content:center}
  .hoja{width:100%;max-width:440px}
  header{text-align:center;margin-bottom:22px}
  header img{max-height:56px;margin-bottom:10px}
  header .marca{font-size:13px;color:#94a3b8;letter-spacing:.04em;text-transform:uppercase}
  h1{font-size:22px;margin:14px 0 8px;color:#f8fafc}
  .parrafo{color:#cbd5e1;font-size:15px}
  .tarjeta{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:18px;margin-bottom:14px}
  .monto{text-align:center;background:#450a0a;border:1px solid #7f1d1d;border-radius:14px;
         padding:18px;margin-bottom:14px}
  .monto .etiqueta{display:block;font-size:13px;color:#fca5a5}
  .monto strong{display:block;font-size:40px;color:#fff;margin:4px 0;letter-spacing:-.02em}
  .monto .detalle{font-size:13px;color:#fca5a5}
  /* El aviso previo no es una emergencia: el abonado todavía tiene servicio y
     el rojo de alarma lo haría creer que ya se quedó sin internet. */
  .monto.aviso{background:#422006;border-color:#854d0e}
  .monto.aviso .etiqueta,.monto.aviso .detalle{color:#fcd34d}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-bottom:10px}
  .cuenta{border-top:1px solid #334155;padding:12px 0}
  .cuenta:first-of-type{border-top:0;padding-top:0}
  .banco{font-size:15px;color:#f8fafc;font-weight:600}
  /* El número grande y tocable: se va a copiar o a dictar por teléfono, y un
     dígito mal leído es un depósito perdido. */
  .numero{font-size:26px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
          color:#38bdf8;letter-spacing:.06em;margin:4px 0;cursor:pointer;word-break:break-all}
  .dato{font-size:13px;color:#94a3b8}
  .boton{display:block;text-align:center;background:#16a34a;color:#fff;text-decoration:none;
         padding:14px;border-radius:10px;font-size:16px;font-weight:600;margin:12px 0 8px}
  .ficha{font-size:13px;color:#94a3b8;text-align:center;margin-top:6px}
  footer{text-align:center;font-size:12px;color:#64748b;margin-top:18px}
  .copiado{position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#334155;
           color:#f8fafc;padding:10px 18px;border-radius:8px;font-size:14px;display:none}
</style>
</head>
<body>
<div class="hoja">
  <header>
    ${datos.empresa.logo ? `<img src="${datos.empresa.logo}" alt="">` : ''}
    <p class="marca">${esc(datos.empresa.nombre)}</p>
    <h1>${esc(datos.titulo)}</h1>
    <p class="parrafo">${esc(datos.mensaje)}</p>
  </header>

  ${bloqueSaldo}

  ${abonado ? `<div class="tarjeta"><p class="ficha">${esc(abonado.nombre)}${abonado.codigo ? ` · código ${esc(abonado.codigo)}` : ''}${abonado.plan ? ` · ${esc(abonado.plan)}` : ''}</p></div>` : ''}

  ${bloqueCuentas ? `<div class="tarjeta">${bloqueCuentas}</div>` : ''}
  ${bloqueAviso ? `<div class="tarjeta">${bloqueAviso}</div>` : ''}

  <footer>${
    datos.motivo === 'aviso'
      ? 'Esta página se muestra porque tenés una factura por vencer.'
      : 'Esta página se muestra porque tu servicio está suspendido.'
  }</footer>
</div>
<div class="copiado" id="copiado">Número copiado</div>
<script>
  function copiar(t){
    // Sin conexión no hay librerías: se usa lo que el navegador ya trae, y si
    // tampoco está, se seleccciona el texto para que se pueda copiar a mano.
    if(navigator.clipboard){navigator.clipboard.writeText(t).then(aviso,()=>{})}
    else{aviso()}
  }
  function aviso(){
    var c=document.getElementById('copiado');
    c.style.display='block';setTimeout(function(){c.style.display='none'},1400);
  }
</script>
</body>
</html>`
}

/** La página para alguien a quien no se pudo identificar por su IP. */
export function htmlDesconocido({ empresa = {}, telefono, whatsapp } = {}) {
  return html({
    titulo: 'Tu servicio está suspendido',
    mensaje:
      'No pudimos identificar tu conexión desde acá. Comunicate con nosotros y te ayudamos a reactivarla.',
    abonado: null,
    saldo: null,
    facturas: null,
    cuentas: [],
    whatsapp: aWhatsapp(whatsapp),
    whatsapp_visible: whatsapp ?? null,
    telefono: telefono ?? null,
    despues_de_pagar: 'Tené a mano tu cédula o el nombre del titular del servicio.',
    empresa: {
      nombre: empresa.nombre_comercial || empresa.razon_social || 'Tu proveedor de internet',
      logo: empresa.logo_b64 ?? null,
    },
  })
}
