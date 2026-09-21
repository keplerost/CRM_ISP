import { useState } from 'react'
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react'
import { portalApi } from '../../lib/portalApi'
import { Tarjeta } from './PortalApp'

/**
 * Los datos del abonado.
 *
 * Solo lo que puede corregir: teléfono, correo y dirección. El nombre y la
 * cédula se muestran pero no se editan — van impresos en la factura y el SRI
 * los valida contra el RUC, así que dejarlos cambiar sería dejar que alguien se
 * emita comprobantes a otro nombre.
 *
 * Y hay una advertencia que tiene que estar: cambiar el celular cambia a dónde
 * llega el código para entrar. Si se equivoca de número, se queda afuera de su
 * propio portal y no hay forma de que lo resuelva solo.
 */
export default function PortalPerfil({ cuenta, recargar }) {
  const [form, setForm] = useState({ ...cuenta.contacto })
  const [cambiandoClave, setCambiandoClave] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: e.target.value }))
  }

  const celularCambio =
    (form.telefono_movil ?? '') !== (cuenta.contacto.telefono_movil ?? '') ||
    (form.telefono ?? '') !== (cuenta.contacto.telefono ?? '')

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      await portalApi.guardarContacto(form)
      await recargar()
      setGuardado(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <form onSubmit={guardar} className="space-y-3">
      {/* Lo que no se toca, arriba y en gris: se ve que está y que no se edita,
          sin tener que probar el campo para descubrirlo. */}
      <Tarjeta titulo="Tus datos">
        <div className="space-y-2.5 text-sm">
          <Fijo etiqueta="Nombre" valor={cuenta.nombre} />
          <Fijo etiqueta="Cédula / RUC" valor={cuenta.identificacion} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          El nombre y la cédula salen impresos en tus facturas. Si hay que corregirlos, escribinos.
        </p>
      </Tarjeta>

      <Tarjeta titulo="Cómo contactarte">
        <div className="space-y-4">
          <Campo etiqueta="Celular" valor={form.telefono_movil} onChange={set('telefono_movil')} tipo="tel" />
          <Campo etiqueta="Otro teléfono" valor={form.telefono} onChange={set('telefono')} tipo="tel" />
          <Campo etiqueta="Correo" valor={form.email} onChange={set('email')} tipo="email" />
          <Campo etiqueta="Dirección" valor={form.direccion} onChange={set('direccion')} />
        </div>
      </Tarjeta>

      {/* La advertencia solo cuando de verdad aplica. */}
      {celularCambio && (
        <div className="flex gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-200/90">
            Estás cambiando tu teléfono. El código para entrar a este portal va a llegar al número
            nuevo: revisá que esté bien escrito antes de guardar.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-rose-400">{error}</p>}
      {guardado && (
        <p className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-300">
          Listo, guardamos tus datos.
        </p>
      )}

      <button
        type="submit"
        disabled={guardando}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3.5 text-base font-medium text-white disabled:opacity-40"
      >
        {guardando && <Loader2 size={18} className="animate-spin" />}
        Guardar
      </button>

      {/* Fuera del formulario de datos: son dos guardados distintos, y meterlos
          en el mismo botón haría que cambiar un teléfono pida la contraseña. */}
      <div className="pt-2">
        {cambiandoClave ? (
          <CambiarClave tiene={cuenta.tiene_clave} onListo={() => setCambiandoClave(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setCambiandoClave(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 py-3.5 text-sm text-slate-300"
          >
            <KeyRound size={16} />
            {cuenta.tiene_clave ? 'Cambiar mi contraseña' : 'Crear una contraseña'}
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * Definir o cambiar la contraseña.
 *
 * Si ya tenía una, se pide la anterior aunque la sesión esté abierta: es lo que
 * impide que alguien que agarró el celular desbloqueado se quede con la cuenta.
 *
 * Si no tenía, la está creando por primera vez — ya probó que el celular es
 * suyo al entrar con el código, así que no hay nada más que pedirle.
 */
function CambiarClave({ tiene, onListo }) {
  const [actual, setActual] = useState('')
  const [nueva, setNueva] = useState('')
  const [trabajando, setTrabajando] = useState(false)
  const [error, setError] = useState(null)
  const [hecho, setHecho] = useState(false)

  async function enviar(e) {
    e.preventDefault()
    e.stopPropagation()
    setTrabajando(true)
    setError(null)
    try {
      await portalApi.cambiarClave(actual, nueva)
      setHecho(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setTrabajando(false)
    }
  }

  if (hecho) {
    return (
      <div className="space-y-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <p className="text-sm text-emerald-300">
          Listo. De ahora en adelante podés entrar con tu cédula y esta contraseña.
        </p>
        <p className="text-xs leading-relaxed text-emerald-300/70">
          Si habías entrado desde otro teléfono o computadora, esa sesión se cerró.
        </p>
        <button
          type="button"
          onClick={onListo}
          className="w-full rounded-xl bg-slate-800 py-2.5 text-sm text-slate-200"
        >
          Volver
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <h2 className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {tiene ? 'Cambiar contraseña' : 'Crear contraseña'}
      </h2>

      {tiene && (
        <div>
          <label className="mb-1.5 block text-sm text-slate-400">Contraseña actual</label>
          <input
            type="password"
            autoComplete="current-password"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none focus:border-sky-500"
          />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-sm text-slate-400">Contraseña nueva</label>
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none focus:border-sky-500"
        />
        <p className="mt-1.5 text-xs text-slate-500">
          Al menos 8 caracteres. Una frase larga que recuerdes es mejor que algo corto y retorcido.
        </p>
      </div>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onListo}
          className="flex-1 rounded-xl bg-slate-800 py-3 text-sm text-slate-300"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={enviar}
          disabled={trabajando || nueva.length < 8 || (tiene && !actual)}
          className="flex flex-[2] items-center justify-center gap-2 rounded-xl bg-sky-600 py-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {trabajando && <Loader2 size={16} className="animate-spin" />}
          Guardar
        </button>
      </div>
    </div>
  )
}

const Fijo = ({ etiqueta, valor }) => (
  <div className="flex justify-between gap-3">
    <span className="text-slate-500">{etiqueta}</span>
    <span className="text-right text-slate-300">{valor || '—'}</span>
  </div>
)

const Campo = ({ etiqueta, valor, onChange, tipo = 'text' }) => (
  <div>
    <label className="mb-1.5 block text-sm text-slate-400">{etiqueta}</label>
    <input
      type={tipo}
      value={valor ?? ''}
      onChange={onChange}
      className="w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-base text-slate-100 outline-none focus:border-sky-500"
    />
  </div>
)
