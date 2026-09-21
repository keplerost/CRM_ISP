/**
 * Genera el documento de plantillas para entregarle al CRM.
 *
 *   node --env-file=middleware/.env supabase/generar-plantillas-crm.mjs
 *
 * ── Por qué se genera y no se escribe a mano ──
 *
 * Porque el documento tiene que decir EXACTAMENTE lo que el sistema manda. Un
 * `purpose` copiado a mano que después alguien cambia en la pantalla deja al
 * proveedor con una plantilla aprobada que nunca se va a usar — y eso solo se
 * descubre el día que un aviso de corte no sale.
 *
 * Sale de `v_plantillas_whatsapp`, que es la misma fuente que lee el driver.
 *
 * No modifica nada: solo lee y escribe el .md.
 */

import { writeFileSync } from 'node:fs'

const url = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.')
  process.exit(1)
}

const cabeceras = { apikey: key, Authorization: `Bearer ${key}` }

const filas = await (
  await fetch(
    `${url}/rest/v1/v_plantillas_whatsapp?select=*&order=clave`,
    { headers: cabeceras },
  )
).json()

/** El orden en que se leen: primero lo que más se manda. */
const ORDEN = [
  'sms_factura_generada',
  'sms_aviso_pago_1',
  'sms_aviso_pago_2',
  'sms_aviso_pago_3',
  'sms_corte_servicio',
  'sms_pago_confirmado',
  'sms_incidencia_abierta',
  'sms_incidencia_resuelta',
  'sms_mantenimiento_programado',
  'sms_bienvenida',
]

const ordenadas = ORDEN.map((c) => filas.find((f) => f.clave === c)).filter(Boolean)

const bloques = ordenadas.map((f, i) => {
  const vars = f.variables ?? []
  const ejemplos = f.ejemplos ?? []

  const tabla = vars.length
    ? [
        '',
        '| Posición | Nombre de la variable | Ejemplo |',
        '|---|---|---|',
        ...vars.map(
          (v, n) => `| \`{{${n + 1}}}\` | \`${v}\` | ${ejemplos[n] ?? '—'} |`,
        ),
      ].join('\n')
    : '\n**Sin variables.** Menos partes móviles, aprobación más rápida y nada que pueda llegar vacío.'

  const ejemploJson = vars.length
    ? [
        '',
        'Lo que el sistema le manda al CRM:',
        '',
        '```json',
        JSON.stringify(
          {
            phone: '593991234567',
            purpose: f.purpose_crm,
            variables: Object.fromEntries(vars.map((v, n) => [v, ejemplos[n] ?? ''])),
          },
          null,
          2,
        ),
        '```',
      ].join('\n')
    : [
        '',
        'Lo que el sistema le manda al CRM:',
        '',
        '```json',
        JSON.stringify({ phone: '593991234567', purpose: f.purpose_crm, variables: {} }, null, 2),
        '```',
      ].join('\n')

  return `
## ${i + 1} · ${f.nombre_interno}

| | |
|---|---|
| **Nombre en el CRM** (\`purpose\`) | \`${f.purpose_crm ?? '— sin definir —'}\` |
| **Nombre en Meta** | \`${f.nombre_meta}\` |
| **Idioma** | \`${f.idioma}\` |
| **Categoría** | **${f.categoria}** |

${f.descripcion ?? ''}

**Texto para Meta** — pegar tal cual:

\`\`\`
${f.cuerpo_meta}
\`\`\`
${tabla}
${ejemploJson}
`
})

const doc = `# Las 10 plantillas — para el CRM y para aprobar en Meta

Generado desde la base del ISP. **Es lo que el sistema manda de verdad**: si un
\`purpose\` cambia acá, este documento hay que volver a generarlo.

---

## Cómo se usa este documento

Cada plantilla tiene **dos identidades**, y las dos hacen falta:

| | Para qué |
|---|---|
| **Nombre en Meta** | Con ese nombre se registra la plantilla en el Administrador de WhatsApp |
| **Nombre en el CRM** (\`purpose\`) | Es lo que el sistema del ISP manda para pedir ese aviso |

El flujo es:

1. Registrás la plantilla en **Meta** con su nombre, su idioma, su categoría y el
   texto de este documento.
2. Cuando Meta la aprueba, la das de alta en **tu CRM** con el \`purpose\`
   indicado, apuntando a esa plantilla.
3. El sistema del ISP manda \`purpose\` + variables; tu CRM elige la plantilla y
   rellena.

---

## Antes de cargar la primera

**Categoría UTILITY en las diez.** Ninguna va como Marketing:

- Utilidad se aprueba en minutos, cuesta menos y casi no genera bloqueos.
- Marketing se aprueba más lento y, cuando alguien la marca como spam, **baja la
  calificación de calidad del número entero**. Con la calificación en rojo, Meta
  reduce el límite de mensajes y termina pausando plantillas.

Un aviso de corte no es publicidad.

**Las cuatro reglas por las que Meta rechaza una plantilla.** Los textos de acá ya
las cumplen; si los modificás, revisalas:

1. El cuerpo **no puede empezar** con una variable.
2. El cuerpo **no puede terminar** con una variable.
3. No puede haber **dos variables seguidas** sin texto en el medio.
4. Las posiciones van \`{{1}}\`, \`{{2}}\`, \`{{3}}\`… sin saltos y sin repetir.

**El nombre de la empresa no va en el texto.** WhatsApp ya lo muestra arriba del
mensaje. Ponerlo gasta una variable, hace que el cuerpo empiece como Meta no
acepta, y no le dice nada nuevo a quien lo lee.

**Las variables viajan por nombre, no por posición.** El sistema manda
\`{ "saldo": "$20.00" }\`, no un arreglo. La tabla de cada plantilla dice qué
nombre corresponde a cada \`{{n}}\` del texto de Meta — esa correspondencia es lo
único que hay que respetar al armar la plantilla del lado del CRM.
${bloques.join('\n---\n')}
---

## Resumen

| Aviso | \`purpose\` | Nombre en Meta | Variables |
|---|---|---|---|
${ordenadas
  .map(
    (f) =>
      `| ${f.nombre_interno} | \`${f.purpose_crm}\` | \`${f.nombre_meta}\` | ${
        (f.variables ?? []).length ? (f.variables ?? []).join(', ') : '—'
      } |`,
  )
  .join('\n')}

---

## Los dos que más rinden

**\`outage_started\`** y **\`outage_resolved\`**. Un corte de fibra que afecta a 180
abonados genera unos 40 mensajes al canal de soporte en los primeros diez
minutos, todos preguntando lo mismo. Avisarles antes de que pregunten es la
diferencia entre atender el corte y atender el teléfono.

El texto de \`outage_started\` dice "no es necesario que reinicie su equipo" a
propósito: es lo que el abonado hace doce veces mientras espera.

---

## Qué pasa si falta alguna

El sistema del ISP no la manda por WhatsApp: se cae al SMS o al correo del
abonado, y queda escrito el motivo. **No se intenta igual** — mandar un
\`purpose\` que el CRM no conoce termina en un rechazo y el abonado no recibe nada
por ningún lado.
`

const salida = 'docs/plantillas-para-el-crm.md'
writeFileSync(salida, doc)

console.log(`Generado: ${salida}`)
console.log(`  ${ordenadas.length} plantillas`)
const sinPurpose = ordenadas.filter((f) => !f.purpose_crm)
console.log(
  sinPurpose.length
    ? `  FALTAN purpose: ${sinPurpose.map((f) => f.clave).join(', ')}`
    : '  todas con su purpose cargado',
)
