import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Ban,
  Check,
  Copy,
  History,
  KeyRound,
  Pencil,
  Plug,
  Plus,
  ShieldAlert,
} from 'lucide-react'

import { api } from '../../lib/apiNetwork'
import { supabase } from '../../lib/supabaseClient'
import { MOTIVOS_REVOCACION } from '../../lib/motivos'
import {
  Aviso,
  Badge,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Modal,
  PedirMotivo,
  Select,
  Table,
  Tabs,
  Textarea,
} from '../../components/ui'

/**
 * Integraciones: las llaves con las que entran los sistemas externos.
 *
 * ── Qué se decide acá ──
 *
 * Quién puede preguntarle cosas al sistema desde afuera, qué puede preguntar y
 * qué puede hacer. Un CRM, un bot de WhatsApp, el webhook de una pasarela.
 *
 * ── Lo que esta pantalla tiene que dejar claro ──
 *
 * Que "acreditar el pago solo" y "dejarlo a verificar" son cosas distintas, y
 * que la diferencia no la decide quien llama sino esta pantalla. Un bot de chat
 * recibe la palabra del abonado; una pasarela avisa lo que ya cobró. Si eso se
 * confunde al emitir la llave, se descubre en la conciliación del mes siguiente.
 */

/**
 * Lo que se le puede habilitar a una llave.
 *
 * Es un subconjunto a propósito del catálogo del personal: acá solo aparece lo
 * que tiene sentido que haga un programa de afuera. `clientes.editar` o
 * `pagos.anular` no están y no es un olvido — nada que se opere desde un chat
 * tiene por qué poder anular un cobro.
 */
const PERMISOS = [
  {
    clave: 'clientes.ver',
    nombre: 'Consultar el estado del abonado',
    nota: 'Si está activo o cortado, su plan, cuánto debe y en qué fecha le toca el corte. Es lo que el bot necesita para contestar "¿por qué no tengo internet?".',
  },
  {
    clave: 'facturacion.ver',
    nombre: 'Consultar facturas por cédula',
    nota: 'Las facturas con saldo y, si las pide, el historial. No incluye el PDF ni los datos fiscales.',
  },
  {
    clave: 'pagos.registrar',
    nombre: 'Registrar pagos',
    nota: 'Qué pasa con ese pago lo decide el interruptor de abajo: se acredita solo o queda a verificar.',
  },
  {
    clave: 'red.diagnostico',
    nombre: 'Diagnosticar la conexión',
    nota: 'Contesta "¿por qué no tengo internet?" con una conclusión, no con mediciones: avería en la zona, corte por deuda, equipo apagado, señal baja o todo bien. Incluye reiniciarle la ONT.',
  },
  {
    clave: 'red.wifi',
    nombre: 'Cambiar el WiFi del abonado',
    nota: 'Nombre de la red y clave, por TR-069. Si el ACS no llega al equipo, queda pedido y la respuesta lo dice.',
  },
  {
    clave: 'ventas.cobertura',
    nombre: 'Validar cobertura por GPS',
    nota: 'El prospecto comparte su ubicación y la API contesta si hay una caja cerca con puertos libres. Una caja llena cuenta como sin cobertura: prometer y que la cuadrilla vuelva sin instalar es el error más caro.',
  },
  {
    clave: 'ventas.planes',
    nombre: 'Consultar el catálogo de planes',
    nota: 'Nombre, velocidad y precio de los planes activos. No expone la traffic table ni los perfiles de red.',
  },
  {
    clave: 'ventas.solicitudes',
    nombre: 'Agendar instalaciones',
    nota: 'Crea la orden de instalación con el prospecto y reserva el cupo en la agenda del equipo técnico. No crea la ficha de abonado: esa nace cuando el técnico instala.',
  },
  {
    clave: 'soporte.crear',
    nombre: 'Abrir reclamos',
    nota: 'Un ticket por tipo de falla: si ya tiene uno abierto por lo mismo, la API contesta el número del que existe en vez de duplicarlo.',
  },
]

const FORM_VACIO = {
  nombre: '',
  permisos: ['clientes.ver', 'facturacion.ver'],
  cuenta_id: '',
  confirma_pagos: false,
  reactiva_servicio: false,
  ips: '',
  notas: '',
}

const fechaCorta = (v) =>
  v ? new Date(v).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' }) : '—'

export default function IntegracionesPage() {
  const [tab, setTab] = useState('llaves')
  const [llaves, setLlaves] = useState([])
  // La llave que se está por revocar.
  const [aRevocar, setARevocar] = useState(null)
  const [revocando, setRevocando] = useState(false)
  const [llamadas, setLlamadas] = useState([])
  const [cuentas, setCuentas] = useState([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)

  const [creando, setCreando] = useState(null)
  const [editando, setEditando] = useState(null)
  const [guardando, setGuardando] = useState(false)
  // La llave recién emitida, en claro. Vive solo en este estado y se pierde al
  // cerrar el cartel: no se guarda en ningún lado, ni acá ni en el servidor.
  const [emitida, setEmitida] = useState(null)
  const [copiada, setCopiada] = useState(false)

  const recargar = useCallback(async () => {
    setCargando(true)
    setError(null)
    try {
      const [ll, cu] = await Promise.all([
        api.integraciones.llaves(),
        supabase.from('cuentas_pago').select('id, nombre, tipo').eq('activa', true).order('nombre'),
      ])
      setLlaves(ll)
      setCuentas(cu.data ?? [])
    } catch (err) {
      setError(err)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    recargar()
  }, [recargar])

  // El registro se pide recién al abrir su pestaña: son cientos de filas y no
  // hacen falta para lo que se viene a hacer acá, que es emitir o revocar.
  useEffect(() => {
    if (tab !== 'registro') return
    api.integraciones.llamadas({ limite: 200 }).then(setLlamadas).catch(setError)
  }, [tab])

  const activas = useMemo(() => llaves.filter((l) => l.activa && !l.revocada_at), [llaves])

  async function crear(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    try {
      const r = await api.integraciones.crear({
        nombre: creando.nombre,
        permisos: creando.permisos,
        cuenta_id: creando.cuenta_id || null,
        confirma_pagos: creando.confirma_pagos,
        reactiva_servicio: creando.reactiva_servicio,
        ips_permitidas: creando.ips
          .split(/[\s,]+/)
          .map((i) => i.trim())
          .filter(Boolean),
        notas: creando.notas,
      })

      setCreando(null)
      setEmitida(r)
      setCopiada(false)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function revocar(motivo) {
    setRevocando(true)
    try {
      await api.integraciones.revocar(aRevocar.id, motivo)
      setARevocar(null)
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setRevocando(false)
    }
  }

  /**
   * Guarda los cambios de una llave.
   *
   * Los permisos, la cuenta y los dos interruptores de cobro se editan acá y no
   * al emitirla: cuando se emite todavía no se sabe cómo va a andar la
   * integración. Es el lugar donde se le abre el registro directo a un bot que
   * ya demostró que verifica bien.
   */
  async function guardarEdicion(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    try {
      const r = await api.integraciones.guardar(editando.id, {
        nombre: editando.nombre,
        permisos: editando.permisos,
        cuenta_id: editando.cuenta_id || null,
        confirma_pagos: editando.confirma_pagos,
        reactiva_servicio: editando.reactiva_servicio,
        ips_permitidas: String(editando.ips ?? '')
          .split(/[\s,]+/)
          .map((i) => i.trim())
          .filter(Boolean),
        notas: editando.notas,
      })
      setEditando(null)
      if (r.aviso) setError(new Error(r.aviso))
      await recargar()
    } catch (err) {
      setError(err)
    } finally {
      setGuardando(false)
    }
  }

  async function alternarActiva(llave) {
    try {
      await api.integraciones.guardar(llave.id, { activa: !llave.activa })
      await recargar()
    } catch (err) {
      setError(err)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link to="/ajustes" className="text-slate-400 hover:text-slate-100">
          <ArrowLeft size={18} />
        </Link>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Integraciones</h1>
          <p className="text-xs text-slate-500">
            Las llaves con las que el CRM, el bot de WhatsApp y las pasarelas hablan con el sistema.
          </p>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Tabs
        activa={tab}
        onCambiar={setTab}
        tabs={[
          { clave: 'llaves', label: 'Llaves', icon: KeyRound, contador: activas.length },
          { clave: 'registro', label: 'Registro de llamadas', icon: History },
        ]}
      />

      {tab === 'llaves' && (
        <Card
          title="Llaves emitidas"
          icon={Plug}
          actions={
            <Button icon={Plus} onClick={() => setCreando({ ...FORM_VACIO })}>
              Emitir llave
            </Button>
          }
        >
          {cargando ? (
            <Cargando />
          ) : llaves.length === 0 ? (
            <Aviso>
              Todavía no hay ninguna llave. Emitile una al proveedor del CRM con los permisos
              mínimos que necesite: siempre se le pueden agregar después.
            </Aviso>
          ) : (
            <Table
              columnas={['Nombre', 'Llave', 'Permisos', 'Pagos', 'Último uso', '']}
              filas={llaves}
              renderFila={(l) => {
                const viva = l.activa && !l.revocada_at
                return (
                  <tr key={l.id} className={`text-slate-300 ${viva ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2">
                      <span className="block text-slate-100">{l.nombre}</span>
                      <span className="text-[11px] text-slate-500">
                        {l.revocada_at
                          ? `Revocada el ${fechaCorta(l.revocada_at)}`
                          : `Creada el ${fechaCorta(l.created_at)}`}
                      </span>
                      {/*
                        De quién se copiaron los permisos. Es rastro, no vínculo:
                        contesta "¿por qué esta llave puede cobrar?" sin sugerir
                        que cambiarle los permisos a esa persona cambie los de acá.
                      */}
                      {l.generada_desde_nombre && (
                        <span className="text-[11px] text-slate-500">
                          Permisos copiados de {l.generada_desde_nombre}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{l.prefijo}…</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(l.permisos ?? []).map((p) => (
                          <Badge key={p} color="gris">
                            {PERMISOS.find((x) => x.clave === p)?.nombre ?? p}
                          </Badge>
                        ))}
                      </div>
                      {l.ips_permitidas?.length > 0 && (
                        <span className="mt-1 block text-[11px] text-slate-500">
                          Solo desde {l.ips_permitidas.join(', ')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {!(l.permisos ?? []).includes('pagos.registrar') ? (
                        <span className="text-slate-600">—</span>
                      ) : l.confirma_pagos ? (
                        <Badge color="ambar">Acredita sola</Badge>
                      ) : (
                        <Badge color="gris">A verificar</Badge>
                      )}
                      {l.reactiva_servicio && (
                        <span className="mt-1 block text-[11px] text-sky-400">Reactiva servicio</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400">{fechaCorta(l.ultimo_uso)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        {viva && (
                          <>
                            <Button
                              variante="fantasma"
                              icon={Pencil}
                              onClick={() =>
                                setEditando({
                                  ...l,
                                  ips: (l.ips_permitidas ?? []).join(', '),
                                  cuenta_id: l.cuenta_id ?? '',
                                })
                              }
                            >
                              Editar
                            </Button>
                            <Button variante="fantasma" onClick={() => alternarActiva(l)}>
                              Pausar
                            </Button>
                            <Button variante="fantasma" icon={Ban} onClick={() => setARevocar(l)}>
                              Revocar
                            </Button>
                          </>
                        )}
                        {!l.activa && !l.revocada_at && (
                          <Button variante="fantasma" onClick={() => alternarActiva(l)}>
                            Reanudar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              }}
            />
          )}
        </Card>
      )}

      {tab === 'registro' && (
        <Card
          title="Lo que pidieron"
          icon={History}
          subtitle="Las últimas 200 llamadas. Es lo que contesta “¿quién consultó esta cédula?”."
        >
          <Table
            columnas={['Cuándo', 'Llave', 'Pedido', 'Cédula', 'Resultado', 'IP']}
            filas={llamadas}
            vacio="Todavía no llamó nadie."
            renderFila={(c) => (
              <tr key={c.id} className="text-slate-300">
                <td className="px-3 py-2 text-xs text-slate-400">{fechaCorta(c.created_at)}</td>
                <td className="px-3 py-2 text-xs">{c.llave_nombre ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-[11px]">
                  {c.metodo} {c.ruta}
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{c.identificacion ?? '—'}</td>
                <td className="px-3 py-2 text-xs">
                  <span className={c.status >= 400 ? 'text-red-400' : 'text-emerald-400'}>
                    {c.status}
                  </span>
                  {c.error && <span className="block text-[11px] text-slate-500">{c.error}</span>}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{c.ip ?? '—'}</td>
              </tr>
            )}
          />
        </Card>
      )}

      {/* --- Emitir --- */}
      <Modal
        abierto={Boolean(creando)}
        titulo="Emitir una llave"
        onCerrar={() => setCreando(null)}
        ancho="max-w-2xl"
      >
        {creando && (
          <form onSubmit={crear} className="space-y-4">
            <Field label="Nombre" hint="Con qué la vas a reconocer dentro de seis meses.">
              <Input
                value={creando.nombre}
                onChange={(e) => setCreando({ ...creando, nombre: e.target.value })}
                placeholder="Bot de WhatsApp"
                autoFocus
              />
            </Field>

            <Field label="Qué puede hacer">
              <div className="space-y-2">
                {PERMISOS.map((p) => (
                  <label
                    key={p.clave}
                    className="flex cursor-pointer gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={creando.permisos.includes(p.clave)}
                      onChange={(e) =>
                        setCreando({
                          ...creando,
                          permisos: e.target.checked
                            ? [...creando.permisos, p.clave]
                            : creando.permisos.filter((x) => x !== p.clave),
                        })
                      }
                    />
                    <span>
                      <span className="block text-[13px] text-slate-100">{p.nombre}</span>
                      <span className="block text-[11px] leading-snug text-slate-500">{p.nota}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>

            {creando.permisos.includes('pagos.registrar') && (
              <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-[12px] leading-snug text-amber-200/90">
                  <ShieldAlert size={13} className="mr-1 inline" />
                  Un pago reportado por un chat es la palabra del abonado, y una captura se edita en
                  treinta segundos. Dejá esto apagado para el bot: el pago queda en la bandeja y
                  cobranza lo confirma contra el extracto. Encendelo solo para el webhook de una
                  pasarela, donde quien avisa es el que recibió la plata.
                </p>

                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={creando.confirma_pagos}
                    onChange={(e) =>
                      setCreando({ ...creando, confirma_pagos: e.target.checked })
                    }
                  />
                  <span className="text-[13px] text-slate-100">
                    Acreditar los pagos al instante, sin verificación
                  </span>
                </label>

                {creando.confirma_pagos && (
                  <>
                    <Field
                      label="Cuenta por defecto (opcional)"
                      hint="Dejala vacía si el sistema externo informa a qué cuenta entró cada pago. Solo se usa como red por si alguno llega sin decirlo."
                    >
                      <Select
                        value={creando.cuenta_id}
                        onChange={(e) => setCreando({ ...creando, cuenta_id: e.target.value })}
                      >
                        <option value="">Sin cuenta fija — la dice cada pago</option>
                        {cuentas.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nombre} ({c.tipo})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={creando.reactiva_servicio}
                        onChange={(e) =>
                          setCreando({ ...creando, reactiva_servicio: e.target.checked })
                        }
                      />
                      <span className="text-[13px] text-slate-100">
                        Reactivar el servicio del cortado apenas se acredita
                        <span className="block text-[11px] text-slate-500">
                          Le quita la IP del corte en el MikroTik. Solo pasa con pagos ya
                          confirmados: uno que espera verificación nunca reactiva nada.
                        </span>
                      </span>
                    </label>
                  </>
                )}
              </div>
            )}

            <Field
              label="IPs desde las que puede llamar"
              hint="Separadas por coma. Vacío = desde cualquier lado. Cargarlas es la diferencia entre una llave filtrada que sirve desde cualquier café y una que solo sirve desde el servidor del proveedor."
            >
              <Input
                value={creando.ips}
                onChange={(e) => setCreando({ ...creando, ips: e.target.value })}
                placeholder="200.10.20.30, 200.10.20.31"
              />
            </Field>

            <Field label="Notas">
              <Textarea
                rows={2}
                value={creando.notas}
                onChange={(e) => setCreando({ ...creando, notas: e.target.value })}
                placeholder="Proveedor, contacto, para qué se usa."
              />
            </Field>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setCreando(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={guardando}>
                {guardando ? 'Emitiendo…' : 'Emitir'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* --- Editar una llave ya emitida --- */}
      <Modal
        abierto={Boolean(editando)}
        titulo={`Editar «${editando?.nombre ?? ''}»`}
        onCerrar={() => setEditando(null)}
        ancho="max-w-2xl"
      >
        {editando && (
          <form onSubmit={guardarEdicion} className="space-y-4">
            <Aviso>
              La llave en sí no se puede ver ni cambiar — solo lo que puede hacer. Si se perdió,
              revocala y emití otra.
            </Aviso>

            <Field label="Nombre">
              <Input
                value={editando.nombre}
                onChange={(e) => setEditando({ ...editando, nombre: e.target.value })}
              />
            </Field>

            <Field label="Qué puede hacer">
              <div className="space-y-2">
                {PERMISOS.map((p) => (
                  <label
                    key={p.clave}
                    className="flex cursor-pointer gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-2.5"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={(editando.permisos ?? []).includes(p.clave)}
                      onChange={(e) =>
                        setEditando({
                          ...editando,
                          permisos: e.target.checked
                            ? [...(editando.permisos ?? []), p.clave]
                            : (editando.permisos ?? []).filter((x) => x !== p.clave),
                        })
                      }
                    />
                    <span>
                      <span className="block text-[13px] text-slate-100">{p.nombre}</span>
                      <span className="block text-[11px] leading-snug text-slate-500">{p.nota}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>

            {(editando.permisos ?? []).includes('pagos.registrar') && (
              <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-[12px] leading-snug text-amber-200/90">
                  <ShieldAlert size={13} className="mr-1 inline" />
                  Con esto encendido, lo que el sistema externo registre <b>entra a la caja sin que
                  lo mire nadie</b>. Encendelo cuando ya viste cómo se porta: solo acredita solo lo
                  que llegue con <code className="font-mono">bank_api</code>,{' '}
                  <code className="font-mono">qr_validado</code> o{' '}
                  <code className="font-mono">human</code>; un{' '}
                  <code className="font-mono">ocr_only</code> siempre queda a verificar.
                  <br />
                  <br />
                  La cuenta la dice cada pago: el sistema externo manda el número que leyó del
                  comprobante y acá se resuelve solo, sea corriente o ahorros. Si el número no es de
                  ninguna cuenta tuya, el pago se rechaza.
                </p>

                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={Boolean(editando.confirma_pagos)}
                    onChange={(e) => setEditando({ ...editando, confirma_pagos: e.target.checked })}
                  />
                  <span className="text-[13px] text-slate-100">
                    Acreditar los pagos al instante, sin verificación
                  </span>
                </label>

                {editando.confirma_pagos && (
                  <>
                    <Field
                      label="Cuenta por defecto (opcional)"
                      hint="Dejala vacía si el sistema externo informa a qué cuenta entró cada pago: ahí gana lo que diga el comprobante y esta no se usa nunca. Solo hace falta como red por si algún pago llega sin decirlo — y si no hay ninguna de las dos, ese pago queda a verificar en vez de acreditarse."
                    >
                      <Select
                        value={editando.cuenta_id ?? ''}
                        onChange={(e) => setEditando({ ...editando, cuenta_id: e.target.value })}
                      >
                        <option value="">Sin cuenta fija — la dice cada pago</option>
                        {cuentas.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.nombre} ({c.tipo})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={Boolean(editando.reactiva_servicio)}
                        onChange={(e) =>
                          setEditando({ ...editando, reactiva_servicio: e.target.checked })
                        }
                      />
                      <span className="text-[13px] text-slate-100">
                        Reactivar el servicio del cortado apenas se acredita
                        <span className="block text-[11px] text-slate-500">
                          Le quita la IP del corte en el MikroTik. Es lo único de todo esto que el
                          sistema externo no puede hacer por su cuenta.
                        </span>
                      </span>
                    </label>
                  </>
                )}
              </div>
            )}

            <Field
              label="IPs desde las que puede llamar"
              hint="Separadas por coma. Vacío = desde cualquier lado. Cargalas cuando el proveedor tenga su servidor definitivo."
            >
              <Input
                value={editando.ips ?? ''}
                onChange={(e) => setEditando({ ...editando, ips: e.target.value })}
                placeholder="200.10.20.30, 200.10.20.31"
              />
            </Field>

            <Field label="Notas">
              <Textarea
                rows={2}
                value={editando.notas ?? ''}
                onChange={(e) => setEditando({ ...editando, notas: e.target.value })}
              />
            </Field>

            <div className="flex justify-end gap-2">
              <Button variante="fantasma" type="button" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
              <Button type="submit" disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </form>
        )}
      </Modal>

      {/* --- La llave recién emitida --- */}
      <Modal
        abierto={Boolean(emitida)}
        titulo="Copiá la llave ahora"
        onCerrar={() => setEmitida(null)}
        ancho="max-w-2xl"
      >
        {emitida && (
          <div className="space-y-4">
            <Aviso tipo="alerta">
              Esta es la única vez que se ve. No se guarda en ningún lado: si se pierde, hay que
              revocarla y emitir otra.
            </Aviso>

            <div className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 p-3">
              <code className="flex-1 break-all font-mono text-[12px] text-emerald-300">
                {emitida.llave}
              </code>
              <Button
                icon={copiada ? Check : Copy}
                variante="fantasma"
                onClick={() => {
                  navigator.clipboard.writeText(emitida.llave)
                  setCopiada(true)
                }}
              >
                {copiada ? 'Copiada' : 'Copiar'}
              </Button>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[12px] text-slate-400">
              <p className="mb-2 text-slate-300">Cómo la usa el proveedor:</p>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
{`curl -H "X-API-Key: ${emitida.llave}" \\
  ${(import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/$/, '')}/api/integracion/ping`}
              </pre>
            </div>

            <div className="flex justify-end">
              <Button onClick={() => setEmitida(null)}>Ya la copié</Button>
            </div>
          </div>
        )}
      </Modal>

      <PedirMotivo
        abierto={!!aRevocar}
        titulo="Revocar la llave"
        etiquetaAccion="Revocar la llave"
        icon={Ban}
        cargando={revocando}
        advertencia="Deja de funcionar en el acto: el sistema que la esté usando va a empezar a recibir error 403. El registro de lo que hizo queda."
        datos={
          aRevocar
            ? [
                ['Llave', aRevocar.nombre],
                ['Prefijo', aRevocar.prefijo],
                ['Permisos', `${(aRevocar.permisos ?? []).length}`],
                ['Último uso', aRevocar.ultimo_uso ? new Date(aRevocar.ultimo_uso).toLocaleString('es-EC') : 'nunca se usó'],
              ]
            : []
        }
        sugerencias={MOTIVOS_REVOCACION}
        onCancelar={() => setARevocar(null)}
        onConfirmar={revocar}
      />
    </div>
  )
}
