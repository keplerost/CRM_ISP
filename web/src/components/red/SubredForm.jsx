import { useState } from 'react'
import { Save } from 'lucide-react'
import { TIPOS_SUBRED, esCidrValido } from '../../lib/red'
import { Aviso, Button, Field, Input, Select, Textarea } from '../ui'

/**
 * Alta y edición de un bloque.
 *
 * El bloque se escribe como uno lo tiene a mano —el gateway con su prefijo,
 * "192.168.5.254/24"— y no hace falta normalizarlo: la base guarda lo escrito y
 * calcula la red aparte. Obligar a escribir la dirección de red exacta es pedir
 * una cuenta mental para guardar un dato que ya se sabe.
 */
export default function SubredForm({
  subred,
  routers,
  puntos,
  // De qué OLT es el bloque. La IP la da el puerto PON en el que apareció la
  // ONT —a través de su VLAN—, y un bloque de otra OLT no le enrutaría.
  olts = [],
  onGuardar,
  onCancelar,
}) {
  const [form, setForm] = useState({
    nombre: subred?.nombre ?? '',
    cidr: subred?.cidr ?? '',
    tipo: subred?.tipo ?? 'estatica',
    router_id: subred?.router_id ?? '',
    pool_router: subred?.pool_router ?? '',
    gateway: subred?.gateway ?? '',
    vlan: subred?.vlan ?? '',
    rango_desde: subred?.rango_desde ?? '',
    rango_hasta: subred?.rango_hasta ?? '',
    olt_id: subred?.olt_id ?? '',
    // No son columnas de la subred: viajan aparte y se guardan en las VLANs de
    // la OLT. `subred` los trae ya resueltos cuando se está editando.
    slot: subred?.slot ?? '',
    puerto: subred?.puerto ?? '',
    punto_id: subred?.punto_id ?? '',
    notas: subred?.notas ?? '',
  })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function guardar(e) {
    e.preventDefault()
    if (!esCidrValido(form.cidr)) {
      return setError(`"${form.cidr}" no es un bloque válido. Se escribe como 192.168.10.0/24.`)
    }

    setGuardando(true)
    setError(null)
    try {
      const texto = (v) => String(v ?? '').trim() || null
      await onGuardar({
        nombre: form.nombre.trim(),
        cidr: form.cidr.trim(),
        tipo: form.tipo,
        router_id: form.router_id || null,
        pool_router: texto(form.pool_router),
        gateway: texto(form.gateway),
        vlan: form.vlan === '' ? null : Number(form.vlan),
        rango_desde: texto(form.rango_desde),
        rango_hasta: texto(form.rango_hasta),
        olt_id: form.olt_id || null,
        punto_id: form.punto_id || null,
        notas: texto(form.notas),
        // Fuera de la subred: la página los usa para anotar de qué puerto es
        // esta VLAN y no los manda a la tabla.
        slot: form.slot,
        puerto: form.puerto,
      })
    } catch (err) {
      setError(
        err.code === '23505'
          ? `El bloque ${form.cidr} ya está cargado. Dos subredes con la misma red hacen que la ocupación de las dos mienta.`
          : err.message,
      )
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      {error && <Aviso tipo="alerta">{error}</Aviso>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={form.nombre} onChange={set('nombre')} placeholder="Clientes FTTH PROGRESO" required />
        </Field>

        <Field label="Red / CIDR" hint="El gateway con su prefijo también sirve">
          <Input
            value={form.cidr}
            onChange={set('cidr')}
            placeholder="10.10.1.0/24"
            required
            spellCheck={false}
          />
        </Field>

        <Field label="Tipo" hint={TIPOS_SUBRED[form.tipo]?.ayuda}>
          <Select value={form.tipo} onChange={set('tipo')}>
            {Object.entries(TIPOS_SUBRED).map(([valor, t]) => (
              <option key={valor} value={valor}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Router">
          <Select value={form.router_id} onChange={set('router_id')}>
            <option value="">Sin asignar</option>
            {routers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Gateway">
          <Input value={form.gateway} onChange={set('gateway')} placeholder="10.10.1.1" />
        </Field>

        {/* La VLAN es lo que une el bloque con el puerto PON, y por lo tanto lo
            que permite que una instalación elija sola su segmento. Sin ella, el
            técnico lo tiene que elegir de una lista arriba de una escalera. */}
        <Field label="VLAN" hint="con esto, un alta en ese puerto elige este bloque sola">
          <Input type="number" min={1} max={4094} value={form.vlan} onChange={set('vlan')} />
        </Field>

        <Field
          label="De qué OLT"
          hint="una dirección de otra OLT no enruta desde donde cuelga el abonado"
        >
          <Select value={form.olt_id} onChange={set('olt_id')}>
            <option value="">— cualquiera —</option>
            {olts.map((o) => (
              <option key={o.id} value={o.id}>
                {o.numero ? `${o.numero} · ` : ''}
                {o.nombre}
              </option>
            ))}
          </Select>
        </Field>

        {/* --- De qué puerto PON es este bloque ---
            Cierra la cadena puerto → VLAN → bloque, que es lo que permite que
            una instalación elija sola su segmento. El dato no se guarda en la
            subred sino en las VLANs de la OLT —varios bloques pueden compartir
            una VLAN— pero se carga desde acá porque hacerlo en otra pantalla es
            el paso que se olvida. */}
        <Field
          label="Placa"
          hint={form.olt_id && form.vlan ? 'de qué puerto PON es este bloque' : 'primero elegí OLT y VLAN'}
        >
          <Input
            type="number"
            min={0}
            value={form.slot}
            onChange={set('slot')}
            disabled={!form.olt_id || form.vlan === ''}
          />
        </Field>
        <Field label="Puerto PON" hint="los dos o ninguno">
          <Input
            type="number"
            min={0}
            value={form.puerto}
            onChange={set('puerto')}
            disabled={!form.olt_id || form.vlan === ''}
          />
        </Field>

        <Field label="Pool en el router" hint="Si la reparte por DHCP o PPP">
          <Input value={form.pool_router} onChange={set('pool_router')} placeholder="pool-norte" />
        </Field>

        {/* --- El rango que se entrega ---
            No es lo mismo que el bloque: de un /25 se puede querer entregar
            desde la .2 y dejar la .1 como local-address del perfil PPP. Al
            guardar, el pool del router se deja igual a esto — si no, el sistema
            dice una cosa y el router entrega otra. */}
        <Field label="Entrega desde" hint="la primera que recibe un abonado">
          <Input
            value={form.rango_desde}
            onChange={set('rango_desde')}
            placeholder="172.19.0.2"
            spellCheck={false}
          />
        </Field>
        <Field label="…hasta">
          <Input
            value={form.rango_hasta}
            onChange={set('rango_hasta')}
            placeholder="172.19.0.126"
            spellCheck={false}
          />
        </Field>

        <Field label="Nodo / torre">
          <Select value={form.punto_id} onChange={set('punto_id')}>
            <option value="">Sin asignar</option>
            {puntos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nombre}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Notas" className="sm:col-span-2">
          <Textarea rows={2} value={form.notas} onChange={set('notas')} />
        </Field>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" onClick={onCancelar}>
          Cancelar
        </Button>
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          {subred ? 'Guardar cambios' : 'Crear bloque'}
        </Button>
      </div>
    </form>
  )
}
