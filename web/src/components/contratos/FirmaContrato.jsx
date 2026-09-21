import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  FileSignature,
  PenLine,
  Send,
  Upload,
} from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { api } from '../../lib/apiNetwork'
import { usePermisos } from '../../lib/AuthContext'
import { Aviso, Badge, Button, Card, Field, Input, Modal, Textarea } from '../ui'

/**
 * La firma del contrato, en la orden de venta o en la ficha del abonado.
 *
 * ── Las dos maneras y por qué conviven ──
 *
 * ELECTRÓNICA: el sistema le pide un enlace al proveedor, el abonado firma con
 * huella y rostro, y el proveedor avisa. Nadie toca nada.
 *
 * EN PAPEL: se imprime, se firma a mano, la oficina sube el escaneo y lo valida.
 *
 * La segunda no es un plan B improvisado: es lo que pasa cuando el proveedor no
 * contesta y el vendedor está sentado con el cliente delante. Por eso el botón
 * aparece solo, sin que nadie tenga que ir a apagar la firma electrónica para
 * todos los demás.
 */

const ESTADOS = {
  pendiente: { label: 'Pendiente', color: 'gris', icon: Clock },
  enviado: { label: 'Esperando al abonado', color: 'azul', icon: Send },
  firmado: { label: 'Firmado', color: 'verde', icon: Check },
  rechazado: { label: 'Rechazado', color: 'rojo', icon: AlertTriangle },
  vencido: { label: 'Vencido', color: 'ambar', icon: Clock },
  fallido: { label: 'No se pudo enviar', color: 'rojo', icon: AlertTriangle },
}

const fecha = (f) => (f ? new Date(f).toLocaleString() : '—')

export default function FirmaContrato({ instalacion = null, cliente = null, onError }) {
  const { puede, rol, esSuperAdmin } = usePermisos()
  const [tramites, setTramites] = useState([])
  const [config, setConfig] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [trabajando, setTrabajando] = useState(false)
  const [subiendo, setSubiendo] = useState(null)
  const [autorizando, setAutorizando] = useState(null)
  const archivoRef = useRef(null)

  const instalacionId = instalacion?.id ?? null
  const clienteId = cliente?.id ?? null

  const recargar = useCallback(async () => {
    setCargando(true)
    try {
      const [t, c] = await Promise.all([
        api.firmas.de({ instalacionId, clienteId }),
        api.firmas.config(),
      ])
      setTramites(t ?? [])
      setConfig(c)
    } catch (e) {
      onError?.(e)
    } finally {
      setCargando(false)
    }
  }, [instalacionId, clienteId, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  /** El último trámite es el que vale; los anteriores quedan como historial. */
  const actual = tramites[0] ?? null
  const firmado = tramites.some((t) => t.estado === 'firmado')

  async function mandarAFirmar() {
    setTrabajando(true)
    onError?.(null)
    try {
      const r = await api.firmas.solicitar({
        instalacion_id: instalacionId,
        cliente_id: clienteId,
      })

      /**
       * El fallo del proveedor se cuenta acá, no como un error de pantalla.
       *
       * Un `ErrorBanner` rojo haría pensar que no se guardó nada. Lo que pasó es
       * que el trámite existe, quedó anotado por qué no salió, y abajo aparece el
       * botón para pasar a papel.
       */
      if (r.motivo) {
        alert(
          `No se pudo mandar a firmar electrónicamente:\n\n${r.motivo}\n\n`
          + 'Podés imprimir el contrato y hacerlo firmar a mano. El botón para habilitarlo está abajo.',
        )
      }
      await recargar()
    } catch (e) {
      onError?.(e)
    } finally {
      setTrabajando(false)
    }
  }

  async function autorizar(tramite, motivo) {
    setTrabajando(true)
    onError?.(null)
    try {
      await api.firmas.autorizarManual(tramite.id, motivo)
      setAutorizando(null)
      await recargar()
    } catch (e) {
      onError?.(e)
    } finally {
      setTrabajando(false)
    }
  }

  /** Sube el escaneo del contrato firmado y cierra el trámite. */
  async function subirFirmado(e) {
    const archivo = e.target.files?.[0]
    if (!archivo || !subiendo) return

    setTrabajando(true)
    onError?.(null)
    try {
      const extension = archivo.name.split('.').pop() ?? 'pdf'
      const carpeta = clienteId ?? instalacionId
      const ruta = `${clienteId ? '' : 'ordenes/'}${carpeta}/contrato-firmado-${Date.now()}.${extension}`

      const { error: errSubida } = await supabase.storage
        .from('documentos')
        .upload(ruta, archivo, { contentType: archivo.type })
      if (errSubida) throw errSubida

      /**
       * El escaneo también entra a Documentos.
       *
       * Es el papel firmado: tiene que estar donde alguien lo va a buscar dentro
       * de dos años, no solo colgando del trámite de firma.
       */
      const { data: sesion } = await supabase.auth.getUser()
      await supabase.from('documentos').insert({
        client_id: clienteId,
        instalacion_id: instalacionId,
        categoria: 'contrato',
        nombre: `Contrato firmado — ${new Date().toLocaleDateString()}.${extension}`,
        ruta,
        mime: archivo.type,
        tamano: archivo.size,
        visible_cliente: false,
        created_by: sesion?.user?.id ?? null,
      })

      await api.firmas.registrarManual(subiendo.id, { documento_url: ruta })
      await recargar()
    } catch (e) {
      onError?.(e)
    } finally {
      setTrabajando(false)
      setSubiendo(null)
      if (archivoRef.current) archivoRef.current.value = ''
    }
  }

  /**
   * A quién le falta la autorización para el papel.
   *
   * ── El error que tenía esto ──
   *
   * El botón se mostraba con `t.puede_pasar_a_manual && t.metodo !== 'manual'`.
   * Las dos mitades estaban mal:
   *
   *   · `puede_pasar_a_manual` no existe. El middleware nunca lo devolvió, así
   *     que la condición era `undefined` y el botón no aparecía JAMÁS —tampoco
   *     para el super_admin—.
   *
   *   · `metodo !== 'manual'` pedía justo lo contrario de lo que pasa. Con la
   *     firma electrónica apagada, `solicitarFirma` crea todos los trámites en
   *     `manual` (ver firmaContrato.js). O sea que en el único escenario donde
   *     hace falta habilitar el papel, la condición daba false.
   *
   * El resultado era una pantalla sin salida: decía "falta que un administrador
   * habilite la firma en papel" y no había forma de que ningún administrador lo
   * hiciera. El endpoint existía y funcionaba; no se podía llegar.
   *
   * Ahora la pregunta es la que importa —¿está sin firmar y sin autorizar?— sin
   * mirar el método, porque el papel se habilita igual venga de donde venga.
   */
  const faltaAutorizar = (t) => t.estado !== 'firmado' && !t.autorizado_por

  const rolesQueAutorizan = Array.isArray(config?.roles_autorizan)
    ? config.roles_autorizan
    : []

  /**
   * Esto decide qué se DIBUJA, no quién puede.
   *
   * Quien decide de verdad es `comprobarQuePuedeAutorizar` en el servidor, que
   * mira lo mismo y además exige legajo activo. Repetir la cuenta acá es para
   * no ofrecer un botón que va a terminar en 403, y para poder decir a quién
   * pedírselo.
   */
  const puedeAutorizarPapel =
    esSuperAdmin || puede('contratos.firma_manual') || rolesQueAutorizan.includes(rol)

  if (cargando) return null

  return (
    <Card
      title="Firma del contrato"
      icon={FileSignature}
      subtitle={
        config?.api_habilitada
          ? `Firma electrónica con ${config.proveedor || 'el proveedor configurado'}`
          : 'Firma electrónica apagada: se firma en papel'
      }
      actions={
        !firmado && (
          <Button
            variante="primario"
            icon={Send}
            cargando={trabajando}
            onClick={mandarAFirmar}
          >
            {config?.api_habilitada ? 'Mandar a firmar' : 'Iniciar firma'}
          </Button>
        )
      }
    >
      {tramites.length === 0 ? (
        <Aviso>
          Todavía no se mandó a firmar.{' '}
          {config?.api_habilitada
            ? 'Se le va a enviar un enlace al abonado para que firme con huella y reconocimiento facial.'
            : 'La firma electrónica está apagada, así que el contrato se imprime y se firma a mano.'}
        </Aviso>
      ) : (
        <ul className="space-y-2">
          {tramites.map((t) => {
            const e = ESTADOS[t.estado] ?? ESTADOS.pendiente
            const Icon = e.icon

            return (
              <li
                key={t.id}
                className={`rounded-lg border px-3 py-2 ${
                  t.id === actual?.id ? 'border-slate-700 bg-[#F6F8FB]' : 'border-slate-800 opacity-60'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={e.color}>
                    <span className="flex items-center gap-1">
                      <Icon size={11} /> {e.label}
                    </span>
                  </Badge>
                  <span className="text-xs text-slate-400">
                    {t.metodo === 'manual' ? 'En papel' : 'Electrónica'}
                  </span>
                  {/* El que se pasó de plazo se ve rojo aunque la tarea de
                      vencimiento todavía no haya corrido. */}
                  {t.esperando_de_mas && (
                    <span className="text-[11px] text-amber-300">se pasó del plazo</span>
                  )}
                  <span className="ml-auto text-[11px] text-slate-600">{fecha(t.creado_en)}</span>
                </div>

                {t.error_api && (
                  <p className="mt-1 text-xs text-rose-300">El proveedor: {t.error_api}</p>
                )}

                {/* El enlace, para reenviárselo al abonado por donde sea. */}
                {t.estado === 'enviado' && t.enlace_firma && (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      readOnly
                      value={t.enlace_firma}
                      className="min-w-0 flex-1 truncate rounded border border-slate-800 bg-[#F6F8FB] px-2 py-1 text-[11px] text-slate-400"
                    />
                    <Button
                      variante="fantasma"
                      icon={Copy}
                      onClick={() => navigator.clipboard?.writeText(t.enlace_firma)}
                    >
                      Copiar
                    </Button>
                  </div>
                )}

                {t.estado === 'firmado' && (
                  <p className="mt-1 text-xs text-slate-400">
                    Firmado el {fecha(t.fecha_firma)}
                    {t.referencia_proveedor && ` · trámite ${t.referencia_proveedor}`}
                    {t.validado_por_nombre && ` · validó ${t.validado_por_nombre}`}
                  </p>
                )}

                {/* Quién habilitó el papel: es lo que justifica haber salteado
                    la verificación biométrica. */}
                {t.autorizado_por_nombre && t.estado !== 'firmado' && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Papel habilitado por {t.autorizado_por_nombre}
                    {t.motivo_manual && ` — ${t.motivo_manual}`}
                  </p>
                )}

                <div className="mt-2 flex flex-wrap gap-2">
                  {faltaAutorizar(t) && puedeAutorizarPapel && (
                    <Button variante="fantasma" icon={PenLine} onClick={() => setAutorizando(t)}>
                      Habilitar firma en papel
                    </Button>
                  )}

                  {/* Subir el escaneo: solo cuando el papel ya está habilitado. */}
                  {t.metodo === 'manual' && t.estado !== 'firmado' && t.autorizado_por && (
                    <Button
                      variante="primario"
                      icon={Upload}
                      cargando={trabajando && subiendo?.id === t.id}
                      onClick={() => {
                        setSubiendo(t)
                        setTimeout(() => archivoRef.current?.click(), 0)
                      }}
                    >
                      Subir contrato firmado
                    </Button>
                  )}

                  {faltaAutorizar(t) && !puedeAutorizarPapel && (
                    <span className="text-[11px] text-slate-500">
                      Falta habilitar la firma en papel.{' '}
                      {rolesQueAutorizan.length
                        ? `Puede hacerlo: ${rolesQueAutorizan.join(', ')}.`
                        : 'Todavía no hay ningún rol autorizado: se define en Ajustes → Firma.'}
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <input
        ref={archivoRef}
        type="file"
        accept="image/*,application/pdf"
        onChange={subirFirmado}
        className="hidden"
      />

      <ModalAutorizar
        tramite={autorizando}
        trabajando={trabajando}
        onCerrar={() => setAutorizando(null)}
        onConfirmar={autorizar}
      />
    </Card>
  )
}

/**
 * Pedir el motivo antes de habilitar el papel.
 *
 * No es burocracia: el motivo es lo que explica, meses después, por qué ese
 * contrato no tiene verificación biométrica. Sin él queda un contrato firmado a
 * mano en un sistema con firma electrónica encendida y nadie sabe por qué.
 */
function ModalAutorizar({ tramite, trabajando, onCerrar, onConfirmar }) {
  const [motivo, setMotivo] = useState('')

  useEffect(() => {
    if (tramite) setMotivo(tramite.error_api ? `El proveedor: ${tramite.error_api}` : '')
  }, [tramite])

  if (!tramite) return null

  return (
    <Modal abierto titulo="Habilitar la firma en papel" onCerrar={onCerrar}>
      <div className="space-y-4">
        <Aviso>
          El abonado va a firmar sin verificación de huella ni de rostro. Queda registrado que lo
          habilitaste vos.
        </Aviso>

        <Field label="Por qué" hint="Se guarda con tu nombre y la fecha">
          <Textarea
            rows={2}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="El proveedor no respondió"
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variante="primario"
            icon={PenLine}
            cargando={trabajando}
            onClick={() => onConfirmar(tramite, motivo.trim() || null)}
          >
            Habilitar
          </Button>
        </div>
      </div>
    </Modal>
  )
}
