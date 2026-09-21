import { useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, ErrorBanner, Field, Input, Select } from '../ui'

/**
 * Alta y edición de un router MikroTik.
 *
 * Dos formas de conectarse, y la elección cambia el puerto sugerido:
 *   binaria → API de RouterOS. Lo habitual en un ISP.
 *   rest    → REST API v7 sobre HTTP/HTTPS. Para redes donde el puerto de la
 *             API está bloqueado por firewall.
 *
 * El puerto es libre: se escribe el que esté configurado en /ip service. Ningún
 * comportamiento se deduce de ese número.
 */

const PUERTOS = {
  binaria: { plano: 8728, seguro: 8729 },
  rest: { plano: 80, seguro: 443 },
}

const VACIO = {
  nombre: '',
  ip_host: '',
  modo_api: 'binaria',
  puerto_api: PUERTOS.binaria.plano,
  usa_https: 'false',
  usuario: '',
  password: '',
}

/** Convierte una fila de la base al formato del formulario. */
const desdeFila = (r) => ({
  nombre: r.nombre ?? '',
  ip_host: r.ip_host ?? '',
  modo_api: r.modo_api ?? (Number(r.puerto_api) === 80 || Number(r.puerto_api) === 443 ? 'rest' : 'binaria'),
  puerto_api: r.puerto_api ?? PUERTOS.binaria.plano,
  usa_https: r.usa_https ? 'true' : 'false',
  usuario: r.usuario ?? '',
  // Nunca se precarga: está cifrada y el navegador no tiene la clave.
  password: '',
})

export default function RouterForm({ router = null, onGuardado, onCancelar }) {
  const editando = Boolean(router)
  const [form, setForm] = useState(() => (router ? desdeFila(router) : VACIO))
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  /**
   * Al cambiar modo o cifrado, el puerto se ajusta solo — salvo que ya tenga uno
   * propio, en cuyo caso no se pisa.
   */
  const cambiarConexion = (campo) => (e) => {
    setForm((f) => {
      const nuevo = { ...f, [campo]: e.target.value }
      const anterior = PUERTOS[f.modo_api][f.usa_https === 'true' ? 'seguro' : 'plano']
      if (Number(f.puerto_api) === anterior) {
        nuevo.puerto_api = PUERTOS[nuevo.modo_api][nuevo.usa_https === 'true' ? 'seguro' : 'plano']
      }
      return nuevo
    })
  }

  async function guardar(e) {
    e.preventDefault()
    setError(null)
    setGuardando(true)

    try {
      const datos = {
        nombre: form.nombre,
        ip_host: form.ip_host,
        modo_api: form.modo_api,
        puerto_api: Number(form.puerto_api) || PUERTOS[form.modo_api].plano,
        usa_https: form.usa_https === 'true',
        usuario: form.usuario,
      }

      // Al editar, una contraseña vacía significa "dejá la que ya estaba".
      // Solo se pide el cifrado cuando de verdad hay una nueva.
      if (form.password) {
        datos.password_encrypted = (await api.cifrar(form.password)).encrypted
      } else if (!editando) {
        throw new Error('La contraseña es obligatoria')
      }

      await onGuardado(datos)
      if (!editando) setForm(VACIO)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  const esBinaria = form.modo_api === 'binaria'
  const seguro = form.usa_https === 'true'

  return (
    <form onSubmit={guardar} className="space-y-4">
      {esBinaria ? (
        <Aviso>
          Se usa la <b>API de RouterOS</b> por IP y puerto. Si cambiaste el puerto de la API por
          seguridad, poné el tuyo — no tiene que ser 8728. Verificalo con{' '}
          <code>/ip service print</code>. El usuario necesita el permiso <code>api</code> en{' '}
          <code>/user group</code>.
        </Aviso>
      ) : (
        <Aviso tipo="alerta">
          Se usa la <b>REST API de RouterOS v7</b>. Conviene solo si el puerto de la API está
          bloqueado por firewall. Habilitá el servicio <code>www</code> en <code>/ip service</code>.
        </Aviso>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={form.nombre} onChange={set('nombre')} placeholder="Router Borde" required />
        </Field>

        <Field label="IP o host">
          <Input value={form.ip_host} onChange={set('ip_host')} placeholder="10.8.0.11" required />
        </Field>

        <Field label="Modo de conexión">
          <Select value={form.modo_api} onChange={cambiarConexion('modo_api')}>
            <option value="binaria">API de RouterOS</option>
            <option value="rest">REST API v7</option>
          </Select>
        </Field>

        <Field label={esBinaria ? 'Cifrado' : 'Protocolo'}>
          <Select value={form.usa_https} onChange={cambiarConexion('usa_https')}>
            <option value="false">{esBinaria ? 'api (sin TLS)' : 'HTTP (www)'}</option>
            <option value="true">{esBinaria ? 'api-ssl (TLS)' : 'HTTPS (www-ssl)'}</option>
          </Select>
        </Field>

        <Field
          label="Puerto"
          hint={`Cualquiera, el que tengas en /ip service. El estándar es ${PUERTOS[form.modo_api][seguro ? 'seguro' : 'plano']}.`}
        >
          <Input
            type="number"
            value={form.puerto_api}
            onChange={set('puerto_api')}
            min={1}
            max={65535}
            placeholder="8728"
          />
        </Field>

        <Field label="Usuario">
          <Input value={form.usuario} onChange={set('usuario')} autoComplete="off" required />
        </Field>

        <Field
          label="Contraseña"
          hint={
            editando
              ? 'Dejala vacía para conservar la actual. Escribí una nueva solo si querés cambiarla.'
              : undefined
          }
          className="sm:col-span-2"
        >
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            placeholder={editando ? '•••••••• (sin cambios)' : ''}
            required={!editando}
          />
        </Field>
      </div>

      {/* Aviso, no bloqueo: el puerto es libre y puede haber motivos para usarlo. */}
      {esBinaria && !seguro && Number(form.puerto_api) === 8729 && (
        <Aviso tipo="alerta">
          El 8729 es el puerto estándar de <code>api-ssl</code>, pero elegiste conexión sin TLS. Si
          tu API va cifrada, cambiá <b>Cifrado</b> a <code>api-ssl</code>.
        </Aviso>
      )}

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="flex justify-end gap-2">
        {onCancelar && (
          <Button type="button" variante="fantasma" onClick={onCancelar}>
            Cancelar
          </Button>
        )}
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          {editando ? 'Guardar cambios' : 'Guardar router'}
        </Button>
      </div>
    </form>
  )
}
