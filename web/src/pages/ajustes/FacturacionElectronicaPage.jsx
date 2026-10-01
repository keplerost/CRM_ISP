import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, FileText, Plug, Save } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Select, Textarea } from '../../components/ui'

/**
 * Con quién se emite la factura electrónica.
 *
 * Una pestaña por proveedor del país del ISP —como MikroWisp, pero sin las
 * pestañas de los otros nueve países—. El formulario se arma con los campos que
 * declara cada proveedor en el middleware: agregar uno es agregar una entrada
 * allá, no tocar esta pantalla.
 *
 * Lo que todavía no está integrado se dice: los datos se guardan, pero hasta
 * que se programe la conexión no sale ningún comprobante por ahí.
 */
export default function FacturacionElectronicaPage() {
  const [estado, setEstado] = useState(null)
  const [activa, setActiva] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.facturacionElectronica
      .listar()
      .then((r) => {
        setEstado(r)
        // Se abre en el que está activo, o en el primero.
        setActiva(r.proveedores.find((p) => p.guardado?.activo)?.id ?? r.proveedores[0]?.id)
      })
      .catch(setError)
  }, [])

  if (!estado && !error) return <Cargando />

  const proveedor = estado?.proveedores.find((p) => p.id === activa)

  const reemplazar = (nuevo) =>
    setEstado((e) => ({
      ...e,
      proveedores: e.proveedores.map((p) => {
        if (p.id === nuevo.id) return nuevo
        // Activar uno apaga los demás: la pantalla lo refleja sin recargar.
        return nuevo.guardado?.activo && p.guardado ? { ...p, guardado: { ...p.guardado, activo: false } } : p
      }),
    }))

  return (
    <div className="space-y-4">
      <Link to="/ajustes" className="inline-flex items-center gap-1 text-sm text-slate-400">
        <ArrowLeft size={15} /> Volver a Ajustes
      </Link>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">
          Facturación electrónica{estado ? ` — ${estado.pais.nombre}` : ''}
        </h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          {estado &&
            `Con qué proveedor se emiten los comprobantes ante ${estado.pais.ente.sigla} (${estado.pais.ente.nombre}). El país se cambia en Ajustes → General.`}
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {estado?.sinTabla && (
        <Aviso tipo="alerta">
          Todavía no se pueden guardar datos: falta correr la migración 200 en la base.
        </Aviso>
      )}

      {estado && (
        <>
          <div className="flex flex-wrap gap-1 border-b border-[rgba(15,23,42,0.08)] pb-2">
            {estado.proveedores.map((p) => (
              <button
                key={p.id}
                onClick={() => setActiva(p.id)}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${
                  activa === p.id
                    ? 'bg-sky-600/15 font-medium text-sky-300'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                {p.nombre}
                {p.guardado?.activo && <Badge color="verde">activo</Badge>}
              </button>
            ))}
          </div>

          {proveedor && (
            <FormProveedor
              key={proveedor.id}
              proveedor={proveedor}
              onGuardado={reemplazar}
              onError={setError}
            />
          )}
        </>
      )}
    </div>
  )
}

function FormProveedor({ proveedor, onGuardado, onError }) {
  const g = proveedor.guardado
  const [valores, setValores] = useState(() => {
    const v = { modo_prueba: g?.modo_prueba ?? true }
    for (const c of proveedor.campos) {
      if (c.tipo === 'secreto' || c.clave === 'modo_prueba') continue
      v[c.clave] = g?.datos?.[c.clave] ?? (c.tipo === 'interruptor' ? false : (c.porDefecto ?? ''))
    }
    return v
  })
  const [activo, setActivo] = useState(Boolean(g?.activo))
  const [guardando, setGuardando] = useState(false)
  const [probando, setProbando] = useState(false)
  const [mensaje, setMensaje] = useState(null)

  const set = (clave, valor) => {
    setMensaje(null)
    setValores((v) => ({ ...v, [clave]: valor }))
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setMensaje(null)
    onError(null)
    try {
      const r = await api.facturacionElectronica.guardar(proveedor.id, { activo, valores })
      // Los secretos no vuelven: se limpian del formulario para que no queden
      // escritos en la pantalla después de guardarlos.
      setValores((v) => {
        const limpio = { ...v }
        for (const c of proveedor.campos) if (c.tipo === 'secreto') delete limpio[c.clave]
        return limpio
      })
      onGuardado(r)
      setMensaje({ tipo: 'exito', texto: activo ? 'Guardado y marcado como activo.' : 'Guardado.' })
    } catch (err) {
      onError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function probar() {
    setProbando(true)
    setMensaje(null)
    onError(null)
    try {
      const r = await api.facturacionElectronica.probar(proveedor.id)
      setMensaje({ tipo: r.ok ? 'exito' : 'alerta', texto: r.mensaje })
    } catch (err) {
      onError(err)
    } finally {
      setProbando(false)
    }
  }

  return (
    <Card>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-100">{proveedor.nombre}</h2>
              {proveedor.integrado ? (
                <Badge color="verde">integrado</Badge>
              ) : (
                <Badge color="ambar">por integrar</Badge>
              )}
            </div>
            <p className="mt-1 text-xs leading-snug text-slate-500">{proveedor.descripcion}</p>
          </div>
          {proveedor.sitio && (
            <a
              href={proveedor.sitio}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
            >
              {new URL(proveedor.sitio).hostname} <ExternalLink size={12} />
            </a>
          )}
        </div>

        {/* El SRI de Ecuador tiene su propia pantalla, con el certificado de firma. */}
        {proveedor.configuraEn ? (
          <Link to={proveedor.configuraEn}>
            <Button variante="primario" icon={FileText}>
              Ir a la configuración del SRI
            </Button>
          </Link>
        ) : (
          <form onSubmit={guardar} className="space-y-4">
            {!proveedor.integrado && (
              <Aviso>
                Los datos se guardan, pero la conexión con {proveedor.nombre} todavía no está
                programada: hasta entonces no sale ningún comprobante por acá. Se programa al
                habilitar la facturación electrónica en este país.
              </Aviso>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              {proveedor.campos
                .filter((c) => c.tipo !== 'interruptor')
                .map((c) => (
                  <Campo
                    key={c.clave}
                    campo={c}
                    valor={valores[c.clave] ?? ''}
                    tieneGuardado={Boolean(g?.secretos?.[c.clave])}
                    onCambio={(v) => set(c.clave, v)}
                  />
                ))}
            </div>

            <div className="space-y-2">
              {proveedor.campos
                .filter((c) => c.tipo === 'interruptor')
                .map((c) => (
                  <Interruptor
                    key={c.clave}
                    etiqueta={c.etiqueta}
                    ayuda={c.ayuda}
                    checked={Boolean(valores[c.clave])}
                    onChange={(v) => set(c.clave, v)}
                  />
                ))}
              <Interruptor
                etiqueta="Usar este proveedor para emitir"
                ayuda="Uno solo por país: activar este apaga el que estaba."
                checked={activo}
                onChange={(v) => {
                  setMensaje(null)
                  setActivo(v)
                }}
              />
            </div>

            {mensaje && <Aviso tipo={mensaje.tipo}>{mensaje.texto}</Aviso>}

            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variante="fantasma" icon={Plug} onClick={probar} cargando={probando}>
                Probar conexión
              </Button>
              <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
                Guardar cambios
              </Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  )
}

function Campo({ campo, valor, tieneGuardado, onCambio }) {
  const etiqueta = campo.requerido ? `${campo.etiqueta} *` : campo.etiqueta
  const hint = campo.ayuda ?? (campo.ejemplo ? `Ej: ${campo.ejemplo}` : undefined)

  if (campo.tipo === 'opciones') {
    return (
      <Field label={etiqueta} hint={hint}>
        <Select value={valor} onChange={(e) => onCambio(e.target.value)}>
          {campo.opciones.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </Field>
    )
  }

  if (campo.tipo === 'texto_largo') {
    return (
      <Field label={etiqueta} hint={hint} className="sm:col-span-2">
        <Textarea rows={3} value={valor} onChange={(e) => onCambio(e.target.value)} />
      </Field>
    )
  }

  if (campo.tipo === 'secreto') {
    // Nunca se muestra el guardado: se dice que existe, y vacío lo conserva.
    return (
      <Field label={etiqueta} hint={tieneGuardado ? 'Guardada. Dejala vacía para no cambiarla.' : hint}>
        <Input
          type="password"
          autoComplete="new-password"
          value={valor}
          placeholder={tieneGuardado ? '••••••••' : ''}
          onChange={(e) => onCambio(e.target.value)}
        />
      </Field>
    )
  }

  return (
    <Field label={etiqueta} hint={hint}>
      <Input value={valor} placeholder={campo.ejemplo ?? ''} onChange={(e) => onCambio(e.target.value)} />
    </Field>
  )
}

function Interruptor({ etiqueta, ayuda, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 accent-sky-500"
      />
      <span>
        {etiqueta}
        {ayuda && <span className="block text-xs text-slate-500">{ayuda}</span>}
      </span>
    </label>
  )
}
