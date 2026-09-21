import { useEffect, useState } from 'react'
import { AlertTriangle, Building2, Check, Eye, Save, ShieldAlert, Wifi } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import {
  Aviso, Badge, Button, Card, ErrorBanner, Field, Input, Select, SkeletonTabla, Textarea,
} from '../../components/ui'

/**
 * La página que ve el abonado cortado.
 *
 * ── Qué se decide acá ──
 *
 * Lo que esa página dice, que tiene consecuencias directas: el monto es una
 * cifra que alguien va a depositar y el número es al que va a mandar el
 * comprobante. Los dos tienen que poder corregirse sin tocar código.
 *
 * ── Por qué casi nada hay que cargar dos veces ──
 *
 * Un ISP que instala este sistema ya cargó sus cuentas en Cobranza y su ficha
 * fiscal en Empresa. Pedirle que repita acá el titular, su cédula y su teléfono
 * es pedirle que se equivoque en alguno — y el que se equivoca en un número de
 * cuenta se entera cuando un abonado deposita en el lugar equivocado.
 *
 * Así que los campos vacíos CAEN a la ficha de la empresa, y la pantalla dice
 * con qué se van a completar. Lo que se escribe acá es solo lo que difiere.
 *
 * Las cuentas de banco y billetera se publican salvo que alguien las apague:
 * una cuenta existe para que le depositen. La caja de la oficina nunca —
 * "depositá en Caja Oficina" no significa nada para alguien sentado en su casa.
 */
export default function PaginaCortePage() {
  const [config, setConfig] = useState(null)
  const [cuentas, setCuentas] = useState([])
  const [routers, setRouters] = useState([])
  const [empresa, setEmpresa] = useState({})
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [error, setError] = useState(null)

  const recargar = async () => {
    setCargando(true)
    try {
      const [c, q, r, e] = await Promise.all([
        supabase.from('config_corte').select('*').eq('id', 1).maybeSingle(),
        supabase.from('cuentas_pago').select('*').order('nombre'),
        supabase.from('routers_mikrotik').select('id, nombre, lista_morosos').order('nombre'),
        // Para poder mostrar de dónde sale cada dato que se completa solo.
        supabase.from('sri_config').select('ruc, razon_social, telefono').limit(1).maybeSingle(),
      ])
      if (c.error) throw c.error
      setConfig(c.data ?? { id: 1 })
      setCuentas(q.data ?? [])
      setRouters(r.data ?? [])
      setEmpresa(e.data ?? {})
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setCargando(false)
    }
  }

  useEffect(() => {
    recargar()
  }, [])

  const cambiar = (campo, valor) => {
    setConfig((c) => ({ ...c, [campo]: valor }))
    setGuardado(false)
  }

  const guardar = async () => {
    setGuardando(true)
    setError(null)
    try {
      const { error: e } = await supabase
        .from('config_corte')
        .upsert({ ...config, id: 1, actualizado_en: new Date().toISOString() })
      if (e) throw e
      setGuardado(true)
    } catch (e) {
      setError(e)
    } finally {
      setGuardando(false)
    }
  }

  const cambiarCuenta = async (cuenta, campo, valor) => {
    setCuentas((cs) => cs.map((c) => (c.id === cuenta.id ? { ...c, [campo]: valor } : c)))
    const { error: e } = await supabase
      .from('cuentas_pago')
      .update({ [campo]: valor === '' ? null : valor })
      .eq('id', cuenta.id)
    if (e) setError(e)
  }

  if (cargando) return <SkeletonTabla filas={6} columnas={3} />

  const publicadas = cuentas.filter((c) => c.mostrar_en_corte && c.tipo !== 'efectivo')
  // La cédula del titular, deducida del RUC: para una persona natural el RUC es
  // la cédula más "001", y la cuenta está a nombre de la persona.
  const cedulaEmpresa = /^\d{13}001$/.test(String(empresa.ruc ?? ''))
    ? String(empresa.ruc).slice(0, 10)
    : (empresa.ruc ?? null)

  const whatsappEfectivo = config?.whatsapp_pagos || empresa.telefono
  const listo = config?.activa && publicadas.length > 0 && whatsappEfectivo

  return (
    <div className="space-y-4">
      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Página del abonado cortado</h1>
        <p className="mt-0.5 max-w-3xl text-xs leading-snug text-slate-500">
          Lo que ve alguien suspendido cuando abre el navegador: por qué se le cortó, cuánto debe,
          dónde depositar y a quién avisarle que pagó.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      {/* La limitación técnica, dicha adelante y no escondida en una ayuda: es
          la que explica por qué algunos abonados no van a ver nada. */}
      <Aviso>
        Un portal cautivo solo puede interceptar tráfico <b>HTTP</b>. Si el abonado abre una página
        HTTPS —que hoy son casi todas— va a ver un error de conexión, no esta página. Lo que sí
        funciona: los celulares y las computadoras prueban una dirección HTTP al conectarse a una
        red, y esa prueba es la que hace saltar el aviso solo. Por eso conviene igual que el abonado
        tenga el número de WhatsApp por otro lado.
      </Aviso>

      {!listo && (
        <Aviso tipo="alerta">
          <AlertTriangle size={14} className="mr-1 inline" />
          Todavía falta:{' '}
          {[
            !config?.activa && 'encender la página',
            !whatsappEfectivo && 'poner el número al que se manda el comprobante',
            publicadas.length === 0 && 'elegir al menos una cuenta para publicar',
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </Aviso>
      )}

      <Card title="Qué dice la página">
        <div className="space-y-4 p-4">
          <label className="flex items-start gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={!!config?.activa}
              onChange={(e) => cambiar('activa', e.target.checked)}
              className="mt-1"
            />
            <span>
              La página está en uso
              <span className="block text-[11px] text-slate-500">
                Apagada, el servidor contesta que no está configurada en vez de mostrar una página a
                medio llenar.
              </span>
            </span>
          </label>

          <Field label="Título">
            <Input value={config?.titulo ?? ''} onChange={(e) => cambiar('titulo', e.target.value)} />
          </Field>

          <Field
            label="Por qué se le cortó"
            hint="Lo primero que lee. El tono es una decisión comercial, por eso se edita acá."
          >
            <Textarea
              rows={2}
              value={config?.mensaje ?? ''}
              onChange={(e) => cambiar('mensaje', e.target.value)}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="WhatsApp para comprobantes"
              hint={
                empresa.telefono
                  ? `si lo dejás vacío se usa el de la empresa: ${empresa.telefono}`
                  : 'el dato más importante después del monto'
              }
            >
              <Input
                value={config?.whatsapp_pagos ?? ''}
                onChange={(e) => cambiar('whatsapp_pagos', e.target.value)}
                placeholder={empresa.telefono ?? '0981864229'}
              />
            </Field>
            <Field label="Teléfono" hint="para el que no usa WhatsApp">
              <Input
                value={config?.telefono_pagos ?? ''}
                onChange={(e) => cambiar('telefono_pagos', e.target.value)}
              />
            </Field>
          </div>

          <Field label="Qué hacer después de pagar" hint="es lo que evita la segunda llamada">
            <Textarea
              rows={2}
              value={config?.aviso_despues_de_pagar ?? ''}
              onChange={(e) => cambiar('aviso_despues_de_pagar', e.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-4 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config?.mostrar_saldo !== false}
                onChange={(e) => cambiar('mostrar_saldo', e.target.checked)}
              />
              Mostrar cuánto debe
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={config?.mostrar_facturas !== false}
                onChange={(e) => cambiar('mostrar_facturas', e.target.checked)}
              />
              Mostrar cuántas facturas
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button variante="primario" icon={Save} cargando={guardando} onClick={guardar}>
              Guardar
            </Button>
            {guardado && (
              <span className="text-xs text-emerald-400">
                <Check size={13} className="mr-1 inline" />
                Guardado
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card
        title="Dónde depositar"
        subtitle="Solo las cuentas que marques acá aparecen en la página. Las de efectivo nunca."
      >
        <div className="p-4">
          <table className="w-full text-xs">
            <tbody>
              {cuentas.map((c) => (
                <tr key={c.id} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-2 pr-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={c.tipo === 'efectivo'}
                        checked={!!c.mostrar_en_corte}
                        onChange={(e) => cambiarCuenta(c, 'mostrar_en_corte', e.target.checked)}
                      />
                      <span className={c.tipo === 'efectivo' ? 'text-slate-600' : 'text-slate-200'}>
                        {c.banco || c.nombre}
                        {c.tipo === 'efectivo' && (
                          <span className="ml-1 text-[11px]">
                            — no se publica: no significa nada para alguien en su casa
                          </span>
                        )}
                      </span>
                    </label>
                  </td>
                  <td className="py-2 pr-2 font-mono text-slate-400">{c.numero ?? '—'}</td>
                  <td className="py-2">
                    {/* En Ecuador el cajero la pide. Sin ella el abonado llega a
                        la ventanilla y no puede completar el depósito. */}
                    <Input
                      value={c.identificacion ?? ''}
                      onChange={(e) => cambiarCuenta(c, 'identificacion', e.target.value)}
                      placeholder={cedulaEmpresa ? `${cedulaEmpresa} (de la empresa)` : 'C.I./RUC del titular'}
                      title={
                        cedulaEmpresa
                          ? 'Vacío usa la identificación de la ficha de la empresa. Cargala solo si esta cuenta está a nombre de otra persona.'
                          : 'C.I. o RUC del titular de la cuenta'
                      }
                      className="max-w-[220px] py-1 text-xs"
                      disabled={c.tipo === 'efectivo'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <EnviarAlRouter routers={routers} />
    </div>
  )
}

/**
 * Mandar el tráfico del cortado a esta página.
 *
 * Es una regla en el router, no una opción del sistema: hasta que exista, el
 * cortado sigue viendo lo que veía antes —en La Maná, la página de WispHub—.
 */
function EnviarAlRouter({ routers }) {
  const [routerId, setRouterId] = useState('')
  const [destino, setDestino] = useState('')
  const [puerto, setPuerto] = useState(8090)
  const [hecho, setHecho] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [error, setError] = useState(null)

  const equipo = routers.find((r) => r.id === routerId)

  const instalar = async () => {
    setTrabajando(true)
    setError(null)
    try {
      setHecho(await api.mikrotik.redireccionPago(routerId, { destino, puerto }))
    } catch (e) {
      setError(e)
    } finally {
      setTrabajando(false)
    }
  }

  return (
    <Card
      title="Mandar al cortado a esta página"
      subtitle="Crea la regla en el router. Hasta que exista, el cortado sigue viendo lo de antes."
    >
      <div className="space-y-3 p-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Router">
            <Select value={routerId} onChange={(e) => setRouterId(e.target.value)}>
              <option value="">Elegí el router…</option>
              {routers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nombre}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="IP de este servidor"
            hint="la que el router puede alcanzar, no localhost"
          >
            <Input
              value={destino}
              onChange={(e) => setDestino(e.target.value)}
              placeholder="192.168.1.50"
            />
          </Field>

          <Field label="Puerto" hint="el de PORTAL_CORTE_PORT">
            <Input type="number" value={puerto} onChange={(e) => setPuerto(e.target.value)} />
          </Field>
        </div>

        {equipo && (
          <p className="text-[11px] text-slate-500">
            <ShieldAlert size={12} className="mr-1 inline" />
            La regla va a usar la lista de cortes de este router:{' '}
            <b className="font-mono text-slate-400">{equipo.lista_morosos}</b>.
          </p>
        )}

        <Button
          icon={Wifi}
          cargando={trabajando}
          disabled={!routerId || !destino}
          onClick={instalar}
        >
          Crear la regla en el router
        </Button>

        {hecho && (
          <Aviso>
            <Check size={13} className="mr-1 inline text-emerald-400" />
            {hecho.mensaje}
          </Aviso>
        )}

        {/* Lo que hay que hacer con la página vieja. Sin esto queda una regla de
            WispHub adelante y el abonado sigue viendo la de ellos. */}
        <Aviso tipo="alerta">
          <AlertTriangle size={13} className="mr-1 inline" />
          Si este router venía de otro sistema, ya tiene su propia regla de redirección más arriba
          en la cadena y esa gana. Andá a <b>Red → Redes IPv4 → Comparar</b> para verlas y apagarlas
          cuando esta página esté probada.
        </Aviso>
      </div>
    </Card>
  )
}
