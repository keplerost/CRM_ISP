import { useEffect, useState } from 'react'
import { useConfirmar } from '../../lib/confirmar'
import { CheckCircle2, FileKey, PenTool, Trash2, Upload } from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import { Aviso, Badge, Button, Card, Cargando, ErrorBanner, Field, Input, Modal } from '../ui'

/**
 * Carga del certificado de firma electrónica (.p12) y prueba de firma.
 *
 * El archivo se manda en base64 al middleware, que lo valida abriéndolo y lo
 * guarda cifrado. El navegador no firma nada: la clave privada nunca sale del
 * backend.
 */
export default function CertificadoFirma() {
  const confirmar = useConfirmar()
  const [estado, setEstado] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [archivo, setArchivo] = useState(null)
  const [password, setPassword] = useState('')
  const [subiendo, setSubiendo] = useState(false)
  const [probando, setProbando] = useState(false)
  const [prueba, setPrueba] = useState(null)
  const [error, setError] = useState(null)

  const consultar = () =>
    api.sri
      .certificado()
      .then(setEstado)
      .catch(setError)
      .finally(() => setCargando(false))

  useEffect(() => {
    consultar()
  }, [])

  /** El input de archivo da un File; el backend espera base64. */
  function elegirArchivo(e) {
    const f = e.target.files?.[0]
    if (!f) return setArchivo(null)

    const lector = new FileReader()
    lector.onload = () => setArchivo({ nombre: f.name, tamano: f.size, b64: lector.result })
    lector.onerror = () => setError(new Error('No se pudo leer el archivo'))
    lector.readAsDataURL(f)
  }

  async function subir(e) {
    e.preventDefault()
    setSubiendo(true)
    setError(null)
    setPrueba(null)
    try {
      await api.sri.subirCertificado({ certificado_b64: archivo.b64, password })
      setArchivo(null)
      setPassword('')
      await consultar()
    } catch (err) {
      setError(err)
    } finally {
      setSubiendo(false)
    }
  }

  async function probar() {
    setProbando(true)
    setError(null)
    try {
      setPrueba(await api.sri.probarFirma())
    } catch (err) {
      setError(err)
    } finally {
      setProbando(false)
    }
  }

  async function borrar() {
    if (!await confirmar('¿Quitar el certificado? Vas a tener que volver a subirlo para firmar.')) return
    try {
      await api.sri.borrarCertificado()
      setPrueba(null)
      await consultar()
    } catch (err) {
      setError(err)
    }
  }

  if (cargando) return <Cargando texto="Consultando el certificado…" />

  const cargado = estado?.cargado && !estado?.problema

  return (
    <Card title="Certificado de firma electrónica" icon={FileKey}>
      <div className="space-y-4">
        <ErrorBanner error={error} onCerrar={() => setError(null)} />

        {estado?.problema && (
          <Aviso tipo="alerta">
            Hay un certificado guardado pero no se puede usar: {estado.problema}
            {estado.hint && <span className="mt-1 block text-[11px]">{estado.hint}</span>}
          </Aviso>
        )}

        {cargado ? (
          <>
            <div className="t-panel p-4">
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-400" />
                <span className="text-sm font-medium text-slate-100">Certificado cargado</span>
                {estado.porVencer && <Badge color="ambar">vence pronto</Badge>}
              </div>

              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <Dato label="Titular" valor={estado.sujeto} />
                <Dato label="Emitido por" valor={estado.emisor} />
                <Dato label="Serie" valor={estado.serie} mono />
                <Dato label="Válido desde" valor={estado.validoDesde} />
                <Dato label="Válido hasta" valor={estado.validoHasta} />
                <Dato
                  label="Días restantes"
                  valor={estado.diasParaVencer}
                  color={estado.porVencer ? 'text-amber-400' : 'text-emerald-400'}
                />
              </dl>
            </div>

            {estado.porVencer && (
              <Aviso tipo="alerta">
                Faltan {estado.diasParaVencer} días para que venza. Cuando expire, el SRI empieza a
                rechazar todos los comprobantes. Conviene renovarlo antes.
              </Aviso>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variante="primario" icon={PenTool} onClick={probar} cargando={probando}>
                Probar firma
              </Button>
              <Button variante="fantasma" icon={Trash2} onClick={borrar}>
                Quitar certificado
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={subir} className="space-y-4">
            <Aviso>
              Subí el archivo <code>.p12</code> que te entregó la entidad certificadora (Security
              Data, ANF, Uanataca o el Banco Central). Se guarda cifrado y la clave privada nunca
              sale del servidor.
            </Aviso>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Archivo .p12">
                <input
                  type="file"
                  accept=".p12,.pfx"
                  onChange={elegirArchivo}
                  required
                  className="w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-300
                    file:mr-3 file:rounded file:border-0 file:bg-slate-800 file:px-3 file:py-1 file:text-xs file:text-slate-200"
                />
              </Field>

              <Field label="Contraseña del certificado">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>
            </div>

            {archivo && (
              <p className="text-xs text-slate-500">
                {archivo.nombre} — {(archivo.tamano / 1024).toFixed(1)} KB
              </p>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                variante="primario"
                icon={Upload}
                cargando={subiendo}
                disabled={!archivo || !password}
              >
                Validar y guardar
              </Button>
            </div>
          </form>
        )}

        <Modal
          abierto={prueba !== null}
          titulo="Resultado de la prueba de firma"
          onCerrar={() => setPrueba(null)}
          ancho="max-w-4xl"
        >
          {prueba && (
            <div className="space-y-4">
              <Aviso tipo={prueba.ok ? 'info' : 'alerta'}>
                {prueba.ok ? (
                  <>
                    <b>La firma se generó y verifica correctamente.</b> El certificado sirve para
                    firmar comprobantes.
                  </>
                ) : (
                  <>
                    <b>La firma no pasó la verificación:</b>{' '}
                    {prueba.verificacion.problemas.join(' · ')}
                  </>
                )}
              </Aviso>

              <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                <Dato label="Titular" valor={prueba.certificado.sujeto} />
                <Dato label="Emitido por" valor={prueba.certificado.emisor} />
              </dl>

              <div>
                <p className="mb-1 text-xs text-slate-400">Clave de acceso de la prueba</p>
                <p className="break-all font-mono text-xs text-slate-100">{prueba.claveAcceso}</p>
              </div>

              <Aviso tipo="alerta">{prueba.aviso}</Aviso>

              <div>
                <p className="mb-1 text-xs text-slate-400">XML firmado</p>
                <pre className="max-h-80 overflow-auto rounded-lg bg-black/40 p-3 text-[10px] leading-relaxed text-slate-300">
                  {prueba.xmlFirmado}
                </pre>
              </div>
            </div>
          )}
        </Modal>
      </div>
    </Card>
  )
}

function Dato({ label, valor, mono, color }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className={`${mono ? 'font-mono' : ''} ${color ?? 'text-slate-200'} break-words`}>
        {valor ?? '—'}
      </dd>
    </div>
  )
}
