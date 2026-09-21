import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Truck, MapPin, ArrowRight, AlertTriangle } from 'lucide-react'
import { Button, Field, Input, Textarea, Select, Modal, Aviso } from '../ui'
import { supabase } from '../../lib/supabaseClient'
import { trasladosApi } from '../../lib/traslados'
import { hoyISO } from '../../lib/campo'

/**
 * "Este abonado se muda."
 *
 * ── Qué pasa al confirmar ──
 *
 * Se guarda dónde está hoy —OLT, puerto PON, VLAN, NAP, IP— y se agenda la
 * orden de trabajo en la dirección nueva. Nada más: no se toca la OLT y no se
 * corta el servicio. El abonado sigue conectado en el domicilio viejo hasta que
 * se mude de verdad, que es lo que corresponde.
 *
 * ── Por qué no se pregunta puerto PON, VLAN ni segmento ──
 *
 * Porque el sistema los sabe mejor. Cuando el técnico llegue al domicilio nuevo
 * y mida, la cadena "dónde apareció la ONT → VLAN de ese puerto → subred" da el
 * segmento sola. Preguntárselos acá sería pedirle a alguien que adivine hoy
 * algo que se va a saber con certeza el día de la visita — y encima abrirle la
 * puerta a configurar la red a mano.
 *
 * Vale igual si se muda a otra OLT: al equipo nuevo no le importa de dónde
 * vino.
 */
export default function Trasladar({ cliente, onError, onGuardado }) {
  const [abierto, setAbierto] = useState(false)
  const [enCurso, setEnCurso] = useState(null)
  const [tecnicos, setTecnicos] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [hecho, setHecho] = useState(null)

  const [form, setForm] = useState({
    direccion: '',
    referencia: '',
    latitud: '',
    longitud: '',
    fecha: hoyISO(),
    motivo: '',
    tecnicoId: '',
  })

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const cargar = useCallback(async () => {
    try {
      const [t, tec] = await Promise.all([
        trasladosApi.abierto(cliente.id),
        supabase.from('tecnicos').select('id, nombre').eq('activo', true).order('nombre'),
      ])
      setEnCurso(t)
      setTecnicos(tec.data ?? [])
    } catch (err) {
      // Que falte la migración 94 no puede romper la ficha del abonado.
      if (err?.code !== '42P01') onError?.(err)
    }
  }, [cliente.id, onError])

  useEffect(() => {
    cargar()
  }, [cargar])

  const ubicarme = () => {
    if (!navigator.geolocation) {
      onError?.(new Error('Este dispositivo no da ubicación.'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        setForm((f) => ({
          ...f,
          latitud: p.coords.latitude.toFixed(7),
          longitud: p.coords.longitude.toFixed(7),
        })),
      // Nunca se inventa una coordenada: si el navegador no la da, se dice.
      (err) => onError?.(new Error(`No se pudo tomar la ubicación: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const confirmar = async () => {
    setGuardando(true)
    try {
      const id = await trasladosApi.iniciar({ clienteId: cliente.id, ...form })
      const abiertoAhora = await trasladosApi.abierto(cliente.id)
      setEnCurso(abiertoAhora)
      setHecho(abiertoAhora ?? { id })
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  const cerrar = () => {
    setAbierto(false)
    setHecho(null)
    setForm((f) => ({ ...f, direccion: '', referencia: '', latitud: '', longitud: '', motivo: '' }))
  }

  return (
    <>
      {/* Con un traslado en curso el botón no ofrece abrir otro: muestra el que
          hay. Dos traslados abiertos sobre el mismo abonado significan dos fotos
          del origen, y la segunda se sacaría con el servicio a medio mover. */}
      {enCurso ? (
        <Link
          to={
            enCurso.instalacion_id
              ? `/clientes/instalaciones/${enCurso.instalacion_id}`
              : `/clientes/instalaciones`
          }
          className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/20"
        >
          <Truck size={15} /> Traslado en curso
          {enCurso.orden_numero ? ` · orden #${enCurso.orden_numero}` : ''}
          <ArrowRight size={14} />
        </Link>
      ) : (
        <Button variante="secundario" icon={Truck} onClick={() => setAbierto(true)}>
          Trasladar
        </Button>
      )}

      <Modal abierto={abierto} titulo="Trasladar el servicio a otro domicilio" onCerrar={cerrar}>
        {hecho ? (
          <div className="space-y-3">
            <Aviso>
              Traslado abierto y visita agendada
              {hecho.orden_numero ? ` con la orden #${hecho.orden_numero}` : ''}.
            </Aviso>

            {hecho.sn_anterior ? (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-400" />
                  <div>
                    <p className="font-medium text-amber-200">Queda una ONT por dar de baja</p>
                    <p className="mt-1 text-slate-300">
                      La <b>{hecho.sn_anterior}</b> sigue autorizada en {hecho.olt_anterior ?? 'su OLT'}
                      {hecho.puerto_anterior != null ? `, puerto ${hecho.puerto_anterior}` : ''}
                      {hecho.vlan_anterior != null ? `, VLAN ${hecho.vlan_anterior}` : ''}.
                    </p>
                    <p className="mt-1 text-slate-400">
                      Si el abonado se lleva el mismo equipo, no se va a poder autorizar en el
                      domicilio nuevo hasta que se dé de baja esta. Ya quedó en la cola del tablero
                      GPON: nadie tiene que avisar por teléfono.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400">
                Este abonado no tiene ninguna ONT enlazada, así que no hay nada que dar de baja.
              </p>
            )}

            <Button variante="primario" onClick={cerrar} className="w-full">
              Listo
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Se agenda la visita al domicilio nuevo y se guarda dónde está conectado hoy. El
              servicio <b>no se corta</b>: sigue andando en {cliente.direccion ?? 'la dirección actual'}{' '}
              hasta que se haga la mudanza.
            </p>

            <Field label="Dirección nueva" hint="A dónde va el técnico.">
              <Input
                value={form.direccion}
                onChange={set('direccion')}
                placeholder="Av. Amazonas 456 y Segunda"
              />
            </Field>

            <Field label="Referencia" hint="Opcional. Lo que evita la llamada de '¿dónde es?'.">
              <Input
                value={form.referencia}
                onChange={set('referencia')}
                placeholder="Casa verde, frente a la escuela"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Latitud">
                <Input value={form.latitud} onChange={set('latitud')} placeholder="-0.9345" />
              </Field>
              <Field label="Longitud">
                <Input value={form.longitud} onChange={set('longitud')} placeholder="-79.2210" />
              </Field>
            </div>
            <Button variante="fantasma" icon={MapPin} onClick={ubicarme}>
              Usar la ubicación de este dispositivo
            </Button>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Fecha de la visita">
                <Input type="date" value={form.fecha} onChange={set('fecha')} />
              </Field>
              <Field label="Técnico" hint="Se puede asignar después.">
                <Select value={form.tecnicoId} onChange={set('tecnicoId')}>
                  <option value="">— sin asignar —</option>
                  {tecnicos.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nombre}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Motivo" hint="Opcional.">
              <Textarea
                rows={2}
                value={form.motivo}
                onChange={set('motivo')}
                placeholder="Se muda por trabajo"
              />
            </Field>

            <div className="t-card-sm p-2.5 text-[12px] text-slate-400">
              No se pregunta puerto PON, VLAN ni segmento: salen solos de dónde aparezca la ONT
              cuando el técnico mida en el domicilio nuevo. Vale igual si el sector nuevo cuelga de
              otra OLT.
            </div>

            {/* La IP fija no viaja: es de la subred del sector viejo. Se avisa
                acá y no cuando el técnico ya está en la casa, porque a veces hay
                que pedirla o reservarla antes. */}
            {cliente.tipo_ip === 'fija' && (
              <Aviso tipo="alerta">
                Este abonado tiene <b>IP fija</b> ({cliente.ip ?? 'sin dirección cargada'}). Esa
                dirección es de la subred del sector actual y no se muda con él: en el domicilio
                nuevo hay que asignarle una del segmento que le toque. El asistente la propone en
                el paso de red, y sin eso no va a dejar cerrar la orden.
              </Aviso>
            )}

            <div className="flex gap-2">
              <Button
                variante="primario"
                icon={Truck}
                cargando={guardando}
                disabled={!form.direccion.trim()}
                onClick={confirmar}
                className="flex-1"
              >
                Abrir el traslado
              </Button>
              <Button onClick={cerrar} disabled={guardando}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
