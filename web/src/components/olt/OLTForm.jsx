import { useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Button, ErrorBanner, Field, Input, Select } from '../ui'

const VACIO = {
  nombre: '',
  marca: 'Huawei',
  ip_host: '',
  puerto_ssh: 22,
  usuario: '',
  password: '',
  enable_password: '',
  snmp_puerto: 161,
  snmp_ro: '',
  snmp_rw: '',
  via_vpn: false,
}

/** Convierte una fila de la base al formato del formulario. */
const desdeFila = (o) => ({
  nombre: o.nombre ?? '',
  marca: o.marca ?? 'Huawei',
  ip_host: o.ip_host ?? '',
  puerto_ssh: o.puerto_ssh ?? 22,
  usuario: o.usuario ?? '',
  // Nunca se precargan: están cifradas y el navegador no tiene la clave.
  password: '',
  enable_password: '',
  snmp_puerto: o.snmp_puerto ?? 161,
  snmp_ro: '',
  snmp_rw: '',
  via_vpn: Boolean(o.via_vpn),
})

/**
 * Alta y edición de una OLT.
 *
 * Las contraseñas NO se guardan en claro: se mandan al middleware, que devuelve
 * el ciphertext (AES-256-GCM) y eso es lo que va a la base. El navegador nunca
 * ve la clave de cifrado, y por eso tampoco puede mostrar la contraseña actual
 * al editar.
 */
export default function OLTForm({ olt = null, onGuardado, onCancelar }) {
  const editando = Boolean(olt)
  const [form, setForm] = useState(() => (olt ? desdeFila(olt) : VACIO))
  const [error, setError] = useState(null)
  const [guardando, setGuardando] = useState(false)

  // V-SOL siempre pide contraseña de enable; Huawei no siempre.
  const esVsol = /vsol|v-sol/i.test(form.marca)

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  async function guardar(e) {
    e.preventDefault()
    setError(null)
    setGuardando(true)

    try {
      const datos = {
        nombre: form.nombre,
        marca: form.marca,
        ip_host: form.ip_host,
        puerto_ssh: Number(form.puerto_ssh) || 22,
        usuario: form.usuario,
        snmp_puerto: Number(form.snmp_puerto) || 161,
        via_vpn: Boolean(form.via_vpn),
      }

      // Las comunidades SNMP se guardan cifradas igual que las contraseñas: la
      // de lectura expone todo el equipo y la de escritura permite cambiarlo.
      for (const [campo, columna] of [
        ['snmp_ro', 'snmp_ro_encrypted'],
        ['snmp_rw', 'snmp_rw_encrypted'],
      ]) {
        if (form[campo]) datos[columna] = (await api.cifrar(form[campo])).encrypted
      }

      // Al editar, un campo de contraseña vacío significa "dejá la que estaba".
      // Solo se pide el cifrado cuando de verdad hay una nueva.
      if (form.password) {
        datos.password_encrypted = (await api.cifrar(form.password)).encrypted
      } else if (!editando) {
        throw new Error('La contraseña es obligatoria')
      }

      if (form.enable_password) {
        datos.enable_password_encrypted = (await api.cifrar(form.enable_password)).encrypted
      } else if (!editando) {
        datos.enable_password_encrypted = null
      }

      await onGuardado(datos)
      if (!editando) setForm(VACIO)
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre">
          <Input value={form.nombre} onChange={set('nombre')} placeholder="OLT Central" required />
        </Field>

        <Field label="Marca">
          <Select value={form.marca} onChange={set('marca')}>
            <option value="Huawei">Huawei (MA5800 / VRP)</option>
            <option value="VSOL">V-SOL</option>
          </Select>
        </Field>

        <Field label="IP de gestión">
          <Input value={form.ip_host} onChange={set('ip_host')} placeholder="192.168.1.10" required />
        </Field>

        <Field label="Puerto SSH">
          <Input
            type="number"
            value={form.puerto_ssh}
            onChange={set('puerto_ssh')}
            min={1}
            max={65535}
          />
        </Field>

        <Field label="Usuario">
          <Input value={form.usuario} onChange={set('usuario')} autoComplete="off" required />
        </Field>

        <Field
          label="Contraseña"
          hint={editando ? 'Vacía = se conserva la actual' : undefined}
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

        {/*
          En V-SOL no es opcional, y dejarlo vacío no falla de forma obvia: el
          equipo rechaza el enable, devuelve la sesión al prompt de LOGIN y a
          partir de ahí cada comando se interpreta como un intento de usuario y
          contraseña, hasta que corta la sesión. Lo que se ve es "la OLT cerró
          la sesión", que manda a buscar el problema a otro lado.
        */}
        <Field
          label={
            esVsol ? 'Contraseña de enable (necesaria en V-SOL)' : 'Contraseña de enable (opcional)'
          }
          hint={
            editando
              ? 'Vacía = se conserva la actual.'
              : 'Es una SEGUNDA contraseña, la que pide el equipo al escribir "enable". Suele ser distinta de la de login.'
          }
          className="sm:col-span-2"
        >
          <Input
            type="password"
            value={form.enable_password}
            onChange={set('enable_password')}
            autoComplete="new-password"
            placeholder={editando ? '•••••••• (sin cambios)' : ''}
          />
        </Field>

        <div className="sm:col-span-2 border-t border-slate-800 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            SNMP y acceso
          </p>
        </div>

        <Field label="Puerto SNMP (UDP)">
          <Input
            type="number"
            value={form.snmp_puerto}
            onChange={set('snmp_puerto')}
            min={1}
            max={65535}
          />
        </Field>

        <Field label="Se llega por túnel VPN" hint="Cambia dónde mirar primero cuando no responde.">
          <Select
            value={form.via_vpn ? 'si' : 'no'}
            onChange={(e) => setForm((f) => ({ ...f, via_vpn: e.target.value === 'si' }))}
          >
            <option value="no">No, alcance directo</option>
            <option value="si">Sí, por VPN</option>
          </Select>
        </Field>

        <Field
          label="Comunidad SNMP de solo lectura"
          hint={editando ? 'Vacía = se conserva la actual' : 'Opcional'}
        >
          <Input
            type="password"
            value={form.snmp_ro}
            onChange={set('snmp_ro')}
            autoComplete="new-password"
            placeholder={editando ? '•••••••• (sin cambios)' : 'public'}
          />
        </Field>

        <Field
          label="Comunidad SNMP de lectura/escritura"
          hint="Permite modificar el equipo. Cargala solo si hace falta."
        >
          <Input
            type="password"
            value={form.snmp_rw}
            onChange={set('snmp_rw')}
            autoComplete="new-password"
            placeholder={editando ? '•••••••• (sin cambios)' : ''}
          />
        </Field>

        {esVsol && !form.enable_password && !editando && (
          <div className="sm:col-span-2">
            <Aviso tipo="alerta">
              Sin esta contraseña, el sistema va a probar con la de login. Si el equipo la rechaza
              —lo habitual— devuelve la sesión al prompt de login y todas las operaciones fallan con
              un error que parece de conexión.
              <span className="mt-1 block text-xs">
                Si no la sabés: entrá por SSH con PuTTY, escribí <code>enable</code> y probá. Lo que
                funcione es lo que va acá.
              </span>
            </Aviso>
          </div>
        )}
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <div className="flex justify-end gap-2">
        {onCancelar && (
          <Button type="button" variante="fantasma" onClick={onCancelar}>
            Cancelar
          </Button>
        )}
        <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
          {editando ? 'Guardar cambios' : 'Guardar OLT'}
        </Button>
      </div>
    </form>
  )
}
