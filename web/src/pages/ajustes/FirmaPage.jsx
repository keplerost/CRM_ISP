import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  Clock,
  Fingerprint,
  KeyRound,
  PenLine,
  Plug,
  Save,
  ShieldAlert,
} from 'lucide-react'
import { api } from '../../lib/apiNetwork'
import {
  Aviso,
  Button,
  Card,
  Cargando,
  ErrorBanner,
  Field,
  Input,
  Select,
} from '../../components/ui'

/**
 * Ajustes de la firma del contrato.
 *
 * ── Lo que esta pantalla decide ──
 *
 * Si los contratos se firman con biometría o en papel, y qué pasa el día que el
 * proveedor no responde. Las dos cosas son operativas, no técnicas: quien las
 * cambia es quien atiende, no quien programa.
 */

/** Los roles del sistema, para elegir quién puede habilitar el papel. */
const ROLES = [
  ['super_admin', 'Super administrador'],
  ['admin', 'Administrador'],
  ['finanzas', 'Finanzas'],
  ['supervisor', 'Supervisor'],
  ['cajero', 'Cajero'],
  ['cobrador', 'Cobrador'],
  ['vendedor', 'Vendedor'],
  ['tecnico', 'Técnico'],
  ['bodega', 'Bodega'],
]

export default function FirmaPage() {
  const [form, setForm] = useState(null)
  const [clave, setClave] = useState('')
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [probando, setProbando] = useState(false)
  const [prueba, setPrueba] = useState(null)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => {
    setGuardado(false)
    setForm((f) => ({ ...f, [campo]: e.target.value }))
  }

  const cargar = useCallback(async () => {
    setCargando(true)
    try {
      setForm(await api.firmas.config())
    } catch (e) {
      setError(e)
    } finally {
      setCargando(false)
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    try {
      const datos = {
        api_habilitada: form.api_habilitada,
        proveedor: form.proveedor,
        api_url: form.api_url,
        timeout_segundos: Number(form.timeout_segundos),
        vigencia_horas: Number(form.vigencia_horas),
        roles_autorizan: form.roles_autorizan,
      }
      // La clave solo se manda si se escribió una: vacío significa "dejá la que
      // está", no "borrala".
      if (clave.trim()) datos.api_key = clave.trim()

      setForm(await api.firmas.guardarConfig(datos))
      setClave('')
      setGuardado(true)
    } catch (e) {
      setError(e)
    } finally {
      setGuardando(false)
    }
  }

  async function probar() {
    setProbando(true)
    setPrueba(null)
    try {
      setPrueba(await api.firmas.probar(form.api_url))
    } catch (e) {
      setPrueba({ ok: false, mensaje: e.message })
    } finally {
      setProbando(false)
    }
  }

  function alternarRol(rol) {
    setGuardado(false)
    setForm((f) => {
      const actuales = f.roles_autorizan ?? []
      return {
        ...f,
        roles_autorizan: actuales.includes(rol)
          ? actuales.filter((r) => r !== rol)
          : [...actuales, rol],
      }
    })
  }

  if (cargando) return <Cargando />
  if (!form) return <ErrorBanner error={error} onCerrar={() => setError(null)} />

  const roles = form.roles_autorizan ?? []

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link
          to="/ajustes"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200"
        >
          <ArrowLeft size={16} /> Ajustes
        </Link>
        {guardado && (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <Check size={14} /> Guardado
          </span>
        )}
      </div>

      <div>
        <h1 className="t-titulo text-lg font-bold text-slate-100">Firma del contrato</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Cómo firma el abonado, y qué pasa el día que el proveedor no responde.
        </p>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <form onSubmit={guardar} className="space-y-4">
        <Card title="Firma electrónica" icon={Fingerprint}>
          {/*
            El interruptor, con lo que implica cada posición dicho en la
            pantalla. "Apagado" no es "roto": es el modo en que se trabaja
            mientras no haya proveedor contratado.
          */}
          <label className="flex cursor-pointer items-start gap-3 t-panel p-3">
            <input
              type="checkbox"
              checked={Boolean(form.api_habilitada)}
              onChange={(e) => {
                setGuardado(false)
                setForm((f) => ({ ...f, api_habilitada: e.target.checked }))
              }}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              <span className="block text-sm text-slate-100">
                Usar el proveedor de firma electrónica
              </span>
              <span className="block text-xs text-slate-500">
                {form.api_habilitada
                  ? 'Al mandar a firmar se le envía un enlace al abonado para que firme con huella y reconocimiento facial.'
                  : 'Apagado: los contratos se imprimen y se firman a mano. Es lo que corresponde mientras no haya proveedor contratado.'}
              </span>
            </span>
          </label>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Proveedor" hint="Solo para reconocerlo en las pantallas">
              <Input
                value={form.proveedor ?? ''}
                onChange={set('proveedor')}
                placeholder="Nombre del proveedor"
              />
            </Field>
            <Field label="URL de la API" hint="A dónde se le pide el enlace de firma">
              <Input
                value={form.api_url ?? ''}
                onChange={set('api_url')}
                placeholder="https://api.proveedor.ec/firmas"
              />
            </Field>

            <Field
              label="Clave de la API"
              hint={
                form.tiene_clave
                  ? 'Ya hay una cargada. Escribí una nueva solo si querés reemplazarla.'
                  : 'No hay ninguna cargada'
              }
              className="sm:col-span-2"
            >
              <div className="flex gap-2">
                <Input
                  type="password"
                  value={clave}
                  onChange={(e) => setClave(e.target.value)}
                  placeholder={form.tiene_clave ? '••••••••••••' : 'Pegá acá la clave'}
                  autoComplete="new-password"
                />
                <Button
                  type="button"
                  icon={Plug}
                  cargando={probando}
                  onClick={probar}
                  title="Comprueba que el proveedor responda, sin crear ningún trámite"
                >
                  Probar
                </Button>
              </div>
            </Field>
          </div>

          {/*
            El resultado de la prueba dice el tiempo. No es un adorno: si tarda
            veinte segundos en contestar, cada venta va a esperar eso.
          */}
          {prueba && (
            <div
              className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                prueba.ok
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200'
                  : 'border-amber-500/30 bg-amber-500/5 text-amber-200'
              }`}
            >
              {prueba.ok ? <Check size={14} className="mt-0.5" /> : <ShieldAlert size={14} className="mt-0.5" />}
              <span>{prueba.mensaje}</span>
            </div>
          )}

          <p className="mt-3 flex items-start gap-2 text-[11px] text-slate-500">
            <KeyRound size={12} className="mt-0.5 shrink-0" />
            La clave se guarda cifrada y no vuelve a mostrarse. Una credencial que el navegador
            puede leer es una credencial que cualquiera con la consola abierta puede llevarse.
          </p>
        </Card>

        <Card title="Tiempos" icon={Clock} subtitle="Lo que evita que el sistema quede esperando">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Espera de la llamada (segundos)"
              hint="Cuánto se aguanta al pedir el enlace. Pasado eso se ofrece el papel."
            >
              <Input
                type="number"
                min={5}
                max={300}
                value={form.timeout_segundos ?? 30}
                onChange={set('timeout_segundos')}
              />
            </Field>
            <Field
              label="Vigencia del enlace (horas)"
              hint="Cuánto vale el enlace que ya se le mandó al abonado"
            >
              <Input
                type="number"
                min={1}
                max={720}
                value={form.vigencia_horas ?? 72}
                onChange={set('vigencia_horas')}
              />
            </Field>
          </div>

          <Aviso>
            Son dos esperas distintas. La primera es con el cliente delante: si el proveedor no
            contesta en ese lapso, el vendedor puede seguir con el papel. La segunda es el plazo
            que tiene el abonado para firmar desde su casa; pasado ese plazo el trámite se marca
            vencido y se le puede ofrecer el papel.
          </Aviso>
        </Card>

        <Card
          title="Quién puede habilitar la firma en papel"
          icon={PenLine}
          subtitle="Firmar en papel saltea la verificación de huella y rostro"
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {ROLES.map(([valor, texto]) => (
              <label
                key={valor}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  roles.includes(valor)
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-200'
                    : 'border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={roles.includes(valor)}
                  onChange={() => alternarRol(valor)}
                  className="h-3.5 w-3.5"
                />
                {texto}
              </label>
            ))}
          </div>

          {/*
            Sin nadie que pueda autorizar, el papel deja de existir — y el papel
            es la salida cuando el proveedor no contesta. El servidor lo rechaza
            igual; esto lo dice antes de que alguien aprete guardar.
          */}
          {roles.length === 0 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                Tiene que quedar al menos uno. Sin nadie que pueda habilitar el papel, el día que el
                proveedor falle no habría ninguna forma de firmar un contrato.
              </span>
            </div>
          )}

          <p className="mt-3 text-[11px] text-slate-500">
            Quien lo habilite queda registrado con su nombre, la fecha y el motivo en cada contrato.
            También se puede dar a alguien puntual con el permiso{' '}
            <code className="text-slate-400">contratos.firma_manual</code>, sin convertirlo en
            administrador.
          </p>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" variante="primario" icon={Save} cargando={guardando}>
            Guardar
          </Button>
        </div>
      </form>
    </div>
  )
}
